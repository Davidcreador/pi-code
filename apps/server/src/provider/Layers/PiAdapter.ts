/**
 * PiAdapter — provider adapter for pi (pi.dev).
 *
 * One `pi --mode rpc` subprocess per thread session. Pi persists its own
 * session files, so resume is "spawn with the same `--session-id`"; the
 * resume cursor only carries that id. Event translation follows
 * docs/providers/pi.md: a t3 turn is pi's `agent_start` → `agent_settled`
 * span, assistant/tool activity becomes item lifecycle + content deltas.
 *
 * Pi has no approval gate — tools run without permission prompts, so this
 * adapter never emits `request.opened` and rejects `respondToRequest`.
 *
 * @module PiAdapter
 */
import {
  type ChatAttachment,
  EventId,
  type ModelSelection,
  type PiSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeItemId,
  RuntimeRequestId,
  type ThreadId,
  type ToolLifecycleItemType,
  TurnId,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import { PiRpcError, type PiRpcProcess, type PiRpcRecord, spawnPiRpc } from "../piRpc.ts";

const PROVIDER = ProviderDriverKind.make("pi");
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/** See OPENCODE_RESUME_VERSION — same convention, pi's cursor carries the pi session id. */
const PI_RESUME_VERSION = 1 as const;

export function parsePiResume(raw: unknown): { readonly sessionId: string } | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== PI_RESUME_VERSION) {
    return undefined;
  }
  if (typeof record.sessionId !== "string" || record.sessionId.trim().length === 0) {
    return undefined;
  }
  return { sessionId: record.sessionId.trim() };
}

function makePiResume(sessionId: string) {
  return { schemaVersion: PI_RESUME_VERSION, sessionId };
}

/** `provider/modelId` slug from pi's catalog (`get_available_models`). */
export function parsePiModelSlug(
  slug: string,
): { readonly provider: string; readonly modelId: string } | undefined {
  const separator = slug.indexOf("/");
  if (separator <= 0 || separator === slug.length - 1) {
    return undefined;
  }
  return { provider: slug.slice(0, separator), modelId: slug.slice(separator + 1) };
}

export function piToolItemType(toolName: string): ToolLifecycleItemType {
  switch (toolName) {
    case "bash":
      return "command_execution";
    case "edit":
    case "write":
      return "file_change";
    default:
      return "dynamic_tool_call";
  }
}

interface PiSessionContext {
  session: ProviderSession;
  readonly rpc: PiRpcProcess;
  readonly sessionScope: Scope.Closeable;
  readonly stopped: Ref.Ref<boolean>;
  readonly piSessionId: string;
  activeTurnId: TurnId | undefined;
  abortRequested: boolean;
  /** Minted item id for the assistant message currently streaming. */
  assistantItemId: string | undefined;
  /** Minted item id for a running compaction, if any. */
  compactionItemId: string | undefined;
  /** Current `provider/modelId` slug, mirrors pi state. */
  model: string | undefined;
  thinkingLevel: string | undefined;
}

export interface PiAdapterOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
}

interface EventBaseInput {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly raw?: unknown;
}

export function makePiAdapter(piSettings: PiSettings, options?: PiAdapterOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("pi");
    const serverConfig = yield* ServerConfig;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const crypto = yield* Crypto.Crypto;
    const fileSystem = yield* FileSystem.FileSystem;
    const binaryPath = piSettings.binaryPath.trim().length > 0 ? piSettings.binaryPath : "pi";

    const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, PiSessionContext>();

    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate pi runtime identifier.",
            cause,
          }),
      ),
    );

    const buildEventBase = (input: EventBaseInput) =>
      Effect.all({
        eventId: randomUUIDv4.pipe(Effect.map(EventId.make)),
        createdAt: nowIso,
      }).pipe(
        Effect.map(({ eventId, createdAt }) => ({
          eventId,
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: input.threadId,
          createdAt,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
          ...(input.requestId ? { requestId: RuntimeRequestId.make(input.requestId) } : {}),
          ...(input.raw !== undefined
            ? { raw: { source: "pi.rpc.event" as const, payload: input.raw } }
            : {}),
        })),
      );

    const emit = (event: ProviderRuntimeEvent) =>
      Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        yield* Effect.forEach(
          contexts,
          (context) => Effect.ignoreCause(closePiContext(context)),
          { concurrency: "unbounded", discard: true },
        );
      }).pipe(Effect.ensuring(Queue.shutdown(runtimeEvents))),
    );

    const closePiContext = (context: PiSessionContext) =>
      Effect.gen(function* () {
        if (yield* Ref.getAndSet(context.stopped, true)) {
          return;
        }
        sessions.delete(context.session.threadId);
        yield* Scope.close(context.sessionScope, Exit.void);
      });

    const requireContext = (threadId: ThreadId) =>
      Effect.suspend(() => {
        const context = sessions.get(threadId);
        return context === undefined
          ? Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }))
          : Effect.succeed(context);
      });

    const rpcError = (method: string, cause: unknown) =>
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method,
        detail: cause instanceof PiRpcError ? cause.detail : String(cause),
        cause,
      });

    const touchSession = (context: PiSessionContext, patch: Partial<ProviderSession>) =>
      nowIso.pipe(
        Effect.map((updatedAt) => {
          context.session = { ...context.session, ...patch, updatedAt };
          return context.session;
        }),
      );

    // ── Event pump ─────────────────────────────────────────────────────

    const emitSessionState = (
      context: PiSessionContext,
      state: "ready" | "running",
      raw?: unknown,
    ) =>
      Effect.gen(function* () {
        yield* touchSession(context, { status: state === "running" ? "running" : "ready" });
        yield* emit({
          ...(yield* buildEventBase({
            threadId: context.session.threadId,
            turnId: context.activeTurnId,
            raw,
          })),
          type: "session.state.changed",
          payload: { state },
        });
      });

    const handleAgentStart = (context: PiSessionContext, record: PiRpcRecord) =>
      Effect.gen(function* () {
        yield* emitSessionState(context, "running", record);
        yield* emit({
          ...(yield* buildEventBase({
            threadId: context.session.threadId,
            turnId: context.activeTurnId,
            raw: record,
          })),
          type: "turn.started",
          payload: { ...(context.model ? { model: context.model } : {}) },
        });
      });

    const handleAgentSettled = (context: PiSessionContext, record: PiRpcRecord) =>
      Effect.gen(function* () {
        const turnId = context.activeTurnId;
        context.activeTurnId = undefined;
        context.assistantItemId = undefined;
        const interrupted = context.abortRequested;
        context.abortRequested = false;
        if (turnId !== undefined) {
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              raw: record,
            })),
            type: "turn.completed",
            payload: { state: interrupted ? "interrupted" : "completed" },
          });
        }
        yield* emitSessionState(context, "ready");
      });

    const handleMessageStart = (context: PiSessionContext, record: PiRpcRecord) =>
      Effect.gen(function* () {
        const message = record.message as Record<string, unknown> | undefined;
        if (message?.role !== "assistant") {
          return;
        }
        context.assistantItemId = yield* randomUUIDv4;
        yield* emit({
          ...(yield* buildEventBase({
            threadId: context.session.threadId,
            turnId: context.activeTurnId,
            itemId: context.assistantItemId,
            raw: record,
          })),
          type: "item.started",
          payload: { itemType: "assistant_message", status: "inProgress" },
        });
      });

    const handleMessageUpdate = (context: PiSessionContext, record: PiRpcRecord) =>
      Effect.gen(function* () {
        const streamEvent = record.assistantMessageEvent as Record<string, unknown> | undefined;
        if (streamEvent === undefined || typeof streamEvent.delta !== "string") {
          return;
        }
        const streamKind =
          streamEvent.type === "text_delta"
            ? ("assistant_text" as const)
            : streamEvent.type === "thinking_delta"
              ? ("reasoning_text" as const)
              : undefined;
        if (streamKind === undefined || streamEvent.delta.length === 0) {
          return;
        }
        yield* emit({
          ...(yield* buildEventBase({
            threadId: context.session.threadId,
            turnId: context.activeTurnId,
            itemId: context.assistantItemId,
          })),
          type: "content.delta",
          payload: { streamKind, delta: streamEvent.delta },
        });
      });

    const handleMessageEnd = (context: PiSessionContext, record: PiRpcRecord) =>
      Effect.gen(function* () {
        const message = record.message as Record<string, unknown> | undefined;
        if (message?.role !== "assistant" || context.assistantItemId === undefined) {
          return;
        }
        const itemId = context.assistantItemId;
        context.assistantItemId = undefined;
        yield* emit({
          ...(yield* buildEventBase({
            threadId: context.session.threadId,
            turnId: context.activeTurnId,
            itemId,
            raw: record,
          })),
          type: "item.completed",
          payload: { itemType: "assistant_message", status: "completed", data: message },
        });
      });

    const handleToolExecution = (
      context: PiSessionContext,
      record: PiRpcRecord,
      phase: "start" | "update" | "end",
    ) =>
      Effect.gen(function* () {
        const toolCallId = typeof record.toolCallId === "string" ? record.toolCallId : undefined;
        const toolName = typeof record.toolName === "string" ? record.toolName : "tool";
        if (toolCallId === undefined) {
          return;
        }
        const base = yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: context.activeTurnId,
          itemId: toolCallId,
          raw: record,
        });
        const itemType = piToolItemType(toolName);
        if (phase === "start") {
          yield* emit({
            ...base,
            type: "item.started",
            payload: {
              itemType,
              status: "inProgress",
              title: toolName,
              data: { args: record.args },
            },
          });
          return;
        }
        if (phase === "update") {
          yield* emit({
            ...base,
            type: "item.updated",
            payload: { itemType, status: "inProgress", title: toolName, data: record.partial },
          });
          return;
        }
        yield* emit({
          ...base,
          type: "item.completed",
          payload: {
            itemType,
            status: record.isError === true ? "failed" : "completed",
            title: toolName,
            data: record.result,
          },
        });
      });

    const handleCompaction = (
      context: PiSessionContext,
      record: PiRpcRecord,
      phase: "start" | "end",
    ) =>
      Effect.gen(function* () {
        if (phase === "start") {
          context.compactionItemId = yield* randomUUIDv4;
        }
        const itemId = context.compactionItemId;
        if (itemId === undefined) {
          return;
        }
        if (phase === "end") {
          context.compactionItemId = undefined;
        }
        yield* emit({
          ...(yield* buildEventBase({
            threadId: context.session.threadId,
            turnId: context.activeTurnId,
            itemId,
            raw: record,
          })),
          type: phase === "start" ? "item.started" : "item.completed",
          payload: {
            itemType: "context_compaction",
            status: phase === "start" ? "inProgress" : "completed",
          },
        });
      });

    const handleWarning = (context: PiSessionContext, message: string, record: PiRpcRecord) =>
      buildEventBase({
        threadId: context.session.threadId,
        turnId: context.activeTurnId,
        raw: record,
      }).pipe(Effect.flatMap((base) => emit({ ...base, type: "runtime.warning", payload: { message } })));

    /**
     * Extension UI requests come from pi extensions (dialogs, pickers). None
     * of their widget shapes map onto the orchestration user-input contract
     * yet, so cancel them instead of letting the extension hang the turn.
     * Shape reference: pi.dev/docs/latest/rpc, "Extension UI Protocol".
     */
    const handleExtensionUiRequest = (context: PiSessionContext, record: PiRpcRecord) =>
      Effect.gen(function* () {
        if (typeof record.id !== "string") {
          return;
        }
        yield* context.rpc
          .send({ type: "extension_ui_response", id: record.id, cancelled: true })
          .pipe(Effect.ignore);
        yield* handleWarning(
          context,
          "A pi extension requested interactive UI; the request was cancelled (not supported here yet).",
          record,
        );
      });

    const handlePiEvent = (context: PiSessionContext, record: PiRpcRecord) => {
      switch (record.type) {
        case "agent_start":
          return handleAgentStart(context, record);
        case "agent_settled":
          return handleAgentSettled(context, record);
        case "message_start":
          return handleMessageStart(context, record);
        case "message_update":
          return handleMessageUpdate(context, record);
        case "message_end":
          return handleMessageEnd(context, record);
        case "tool_execution_start":
          return handleToolExecution(context, record, "start");
        case "tool_execution_update":
          return handleToolExecution(context, record, "update");
        case "tool_execution_end":
          return handleToolExecution(context, record, "end");
        case "compaction_start":
          return handleCompaction(context, record, "start");
        case "compaction_end":
          return handleCompaction(context, record, "end");
        case "auto_retry_start":
          return handleWarning(context, "pi is retrying after a transient provider error.", record);
        case "extension_error":
          return buildEventBase({
            threadId: context.session.threadId,
            turnId: context.activeTurnId,
            raw: record,
          }).pipe(
            Effect.flatMap((base) =>
              emit({
                ...base,
                type: "runtime.error",
                payload: {
                  message:
                    typeof record.error === "string" ? record.error : "A pi extension failed.",
                  class: "provider_error",
                },
              }),
            ),
          );
        case "extension_ui_request":
          return handleExtensionUiRequest(context, record);
        default:
          return Effect.void;
      }
    };

    const emitUnexpectedExit = (context: PiSessionContext, code: number) =>
      Effect.gen(function* () {
        if (yield* Ref.getAndSet(context.stopped, true)) {
          return;
        }
        const turnId = context.activeTurnId;
        sessions.delete(context.session.threadId);
        yield* emit({
          ...(yield* buildEventBase({ threadId: context.session.threadId, turnId })),
          type: "runtime.error",
          payload: {
            message: `pi exited unexpectedly with code ${code}.`,
            class: "transport_error",
          },
        }).pipe(Effect.ignore);
        yield* emit({
          ...(yield* buildEventBase({ threadId: context.session.threadId, turnId })),
          type: "session.exited",
          payload: {
            reason: `pi exited with code ${code}`,
            recoverable: false,
            exitKind: "error",
          },
        }).pipe(Effect.ignore);
        yield* Scope.close(context.sessionScope, Exit.void);
      });

    // ── Model / prompt plumbing ────────────────────────────────────────

    const applyModelSelection = (context: PiSessionContext, modelSelection: ModelSelection | undefined) =>
      Effect.gen(function* () {
        if (modelSelection === undefined) {
          return;
        }
        if (modelSelection.instanceId !== boundInstanceId) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: `pi model selection is bound to instance '${modelSelection.instanceId}', expected '${boundInstanceId}'.`,
          });
        }
        if (modelSelection.model !== context.model) {
          const slug = parsePiModelSlug(modelSelection.model);
          if (slug === undefined) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "pi model selection must use the 'provider/model' format.",
            });
          }
          yield* context.rpc
            .request({ type: "set_model", provider: slug.provider, modelId: slug.modelId })
            .pipe(Effect.mapError((cause) => rpcError("set_model", cause)));
          context.model = modelSelection.model;
          yield* touchSession(context, { model: modelSelection.model });
        }
        const thinkingLevel = getModelSelectionStringOptionValue(modelSelection, "effort");
        if (thinkingLevel !== undefined && thinkingLevel !== context.thinkingLevel) {
          yield* context.rpc
            .request({ type: "set_thinking_level", level: thinkingLevel })
            .pipe(Effect.mapError((cause) => rpcError("set_thinking_level", cause)));
          context.thinkingLevel = thinkingLevel;
        }
      });

    const attachmentImages = (attachments: ReadonlyArray<ChatAttachment>) =>
      Effect.forEach(attachments, (attachment) =>
        Effect.gen(function* () {
          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (attachmentPath === null) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "sendTurn",
              detail: `Attachment '${attachment.name}' could not be resolved on disk.`,
            });
          }
          const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "sendTurn",
                  detail: `Failed to read attachment '${attachment.name}'.`,
                  cause,
                }),
            ),
          );
          return {
            type: "image",
            data: Buffer.from(bytes).toString("base64"),
            mimeType: attachment.mimeType,
          };
        }),
      );

    // ── Adapter surface ────────────────────────────────────────────────

    const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
      Effect.gen(function* () {
        const existing = sessions.get(input.threadId);
        if (existing !== undefined) {
          return existing.session;
        }

        const resume = parsePiResume(input.resumeCursor);
        const piSessionId = resume?.sessionId ?? (yield* randomUUIDv4);
        const cwd = input.cwd ?? serverConfig.cwd;
        const sessionScope = yield* Scope.make();

        const rpc = yield* spawnPiRpc({
          binaryPath,
          args: ["--mode", "rpc", "--session-id", piSessionId],
          cwd,
          ...(options?.environment ? { environment: options.environment } : {}),
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Scope.provide(sessionScope),
          Effect.mapError((cause) => rpcError("startSession", cause)),
        );

        const createdAt = yield* nowIso;
        const context: PiSessionContext = {
          session: {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            threadId: input.threadId,
            resumeCursor: makePiResume(piSessionId),
            createdAt,
            updatedAt: createdAt,
          },
          rpc,
          sessionScope,
          stopped: yield* Ref.make(false),
          piSessionId,
          activeTurnId: undefined,
          abortRequested: false,
          assistantItemId: undefined,
          compactionItemId: undefined,
          model: undefined,
          thinkingLevel: undefined,
        };
        sessions.set(input.threadId, context);

        // Adopt pi's current state so the session reflects reality before
        // the first turn (default model from pi settings, resumed name, …).
        const state = yield* rpc
          .request({ type: "get_state" })
          .pipe(Effect.mapError((cause) => rpcError("get_state", cause)));
        const stateData = state.data as Record<string, unknown> | undefined;
        const stateModel = stateData?.model as Record<string, unknown> | undefined;
        if (typeof stateModel?.provider === "string" && typeof stateModel?.id === "string") {
          context.model = `${stateModel.provider}/${stateModel.id}`;
          yield* touchSession(context, { model: context.model });
        }
        if (typeof stateData?.thinkingLevel === "string") {
          context.thinkingLevel = stateData.thinkingLevel;
        }

        if (input.modelSelection !== undefined) {
          yield* applyModelSelection(context, input.modelSelection);
        }

        yield* rpc.events
          .pipe(
            Stream.runForEach((record) => handlePiEvent(context, record)),
            Effect.ignore,
            Effect.forkIn(sessionScope),
          );
        yield* rpc.awaitExit
          .pipe(
            Effect.flatMap((code) => emitUnexpectedExit(context, code)),
            Effect.ignore,
            Effect.forkIn(sessionScope),
          );

        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "session.started",
          payload: { ...(resume ? { resume: input.resumeCursor } : {}) },
        });
        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "session.configured",
          payload: { config: { piSessionId, ...(context.model ? { model: context.model } : {}) } },
        });
        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "thread.started",
          payload: { providerThreadId: piSessionId },
        });
        yield* emitSessionState(context, "ready");

        return context.session;
      });

    const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const context = yield* requireContext(input.threadId);
        yield* applyModelSelection(context, input.modelSelection);

        const turnId = TurnId.make(yield* randomUUIDv4);
        const streaming = context.session.status === "running";
        const images =
          input.attachments !== undefined && input.attachments.length > 0
            ? yield* attachmentImages(input.attachments)
            : undefined;

        context.activeTurnId = turnId;
        yield* context.rpc
          .request({
            type: "prompt",
            message: input.input ?? "",
            ...(images !== undefined ? { images } : {}),
            ...(streaming ? { streamingBehavior: "steer" } : {}),
          })
          .pipe(
            Effect.tapError(() =>
              Effect.sync(() => {
                if (context.activeTurnId === turnId) {
                  context.activeTurnId = undefined;
                }
              }),
            ),
            Effect.mapError((cause) => rpcError("prompt", cause)),
          );

        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: context.session.resumeCursor,
        };
      });

    const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (
      threadId,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireContext(threadId);
        context.abortRequested = true;
        yield* context.rpc
          .request({ type: "abort" })
          .pipe(Effect.mapError((cause) => rpcError("abort", cause)));
      });

    const respondToRequest: ProviderAdapterShape<ProviderAdapterError>["respondToRequest"] = (
      _threadId,
      requestId,
    ) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respondToRequest",
          detail: `pi runs without approval requests; nothing to respond to (request '${requestId}').`,
        }),
      );

    const respondToUserInput: ProviderAdapterShape<ProviderAdapterError>["respondToUserInput"] = (
      threadId,
      requestId,
    ) =>
      Effect.gen(function* () {
        yield* requireContext(threadId);
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respondToUserInput",
          detail: `pi extension UI requests are auto-cancelled; no pending request '${requestId}'.`,
        });
      });

    const stopSession: ProviderAdapterShape<ProviderAdapterError>["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const context = sessions.get(threadId);
        if (context === undefined) {
          return;
        }
        yield* emit({
          ...(yield* buildEventBase({ threadId })),
          type: "session.exited",
          payload: { reason: "stopped", recoverable: true, exitKind: "graceful" },
        });
        yield* closePiContext(context);
      });

    const readThread: ProviderAdapterShape<ProviderAdapterError>["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireContext(threadId);
        const response = yield* context.rpc
          .request({ type: "get_messages" })
          .pipe(Effect.mapError((cause) => rpcError("get_messages", cause)));
        const data = response.data as Record<string, unknown> | undefined;
        const messages = Array.isArray(data?.messages) ? (data.messages as Array<unknown>) : [];
        return {
          threadId,
          turns: [
            {
              id: context.activeTurnId ?? TurnId.make(context.piSessionId),
              items: messages,
            },
          ],
        };
      });

    const rollbackThread: ProviderAdapterShape<ProviderAdapterError>["rollbackThread"] = (
      threadId,
    ) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "rollbackThread",
          detail: `Rolling back pi threads is not supported yet (thread '${threadId}').`,
        }),
      );

    const stopAll: ProviderAdapterShape<ProviderAdapterError>["stopAll"] = () =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        yield* Effect.forEach(contexts, (context) => closePiContext(context), {
          concurrency: "unbounded",
          discard: true,
        });
      });

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions: () => Effect.sync(() => [...sessions.values()].map((c) => c.session)),
      hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
      readThread,
      rollbackThread,
      stopAll,
      get streamEvents() {
        return Stream.fromQueue(runtimeEvents);
      },
    } satisfies ProviderAdapterShape<ProviderAdapterError>;
  });
}
