// @effect-diagnostics nodeBuiltinImport:off
import { spawn as spawnProcess } from "node:child_process";
import * as NodeFSP from "node:fs/promises";

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
  PiNativeAuthFlow,
  PiNativeAuthState,
  type ModelSelection,
  PiNativeCompactResult,
  PiNativeChangelogResult,
  PiNativeLastAssistantText,
  PiNativeNavigateTreeResult,
  PiNativeScopedModelsResult,
  PiNativeSessionMutationResult,
  PiNativeSettingsResult,
  type PiNativeShareResult,
  PiNativeTrustResult,
  PI_NATIVE_IMPORT_MAX_BYTES,
  PI_NATIVE_IMPORT_MAX_ENTRIES,
  PI_NATIVE_IMPORT_MAX_LINES,
  PiNativeSessionState,
  PiNativeSessionStats,
  type PiNativeSessionTree,
  PiNativeTreeEntryKind,
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
  type UserInputQuestion,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { resolveAttachmentPath, toSafeThreadAttachmentSegment } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { PiNativeAdapterShape } from "../Services/PiNativeAdapter.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import { PiRpcError, type PiRpcProcess, type PiRpcRecord, spawnPiRpc } from "../piRpc.ts";
import { piRpcCapabilityIssue, resolvePiRuntimeCommand } from "../piRuntime.ts";
import { normalizePiActiveTranscript } from "../piTranscript.ts";

const PROVIDER = ProviderDriverKind.make("pi");
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const PiRpcExportHtmlResult = Schema.Struct({ path: Schema.String });
const PiResumeSessionsRuntimeResult = Schema.Struct({
  sessions: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      sessionId: Schema.String,
      name: Schema.optional(Schema.String),
      createdAt: Schema.String,
      modifiedAt: Schema.String,
      messageCount: Schema.Number,
      current: Schema.Boolean,
    }),
  ),
});

/** See OPENCODE_RESUME_VERSION — same convention, pi's cursor carries the pi session id. */
const PI_RESUME_VERSION = 1 as const;
const activePiSessionClaims = new Map<string, symbol>();

function claimPiSession(sessionId: string, token: symbol): boolean {
  const owner = activePiSessionClaims.get(sessionId);
  if (owner !== undefined && owner !== token) return false;
  activePiSessionClaims.set(sessionId, token);
  return true;
}

function releasePiSessionClaim(sessionId: string, token: symbol): void {
  if (activePiSessionClaims.get(sessionId) === token) activePiSessionClaims.delete(sessionId);
}

function releasePiSessionClaims(token: symbol): void {
  for (const [sessionId, owner] of activePiSessionClaims) {
    if (owner === token) activePiSessionClaims.delete(sessionId);
  }
}

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

export function parseGitHubGistShareUrl(raw: string): PiNativeShareResult | undefined {
  try {
    const gistUrl = new URL(raw.trim());
    if (gistUrl.protocol !== "https:" || gistUrl.hostname !== "gist.github.com") return undefined;
    const gistId = gistUrl.pathname.split("/").filter(Boolean).at(-1);
    if (!gistId || !/^[a-f0-9]{5,64}$/i.test(gistId)) return undefined;
    return { url: `https://pi.dev/session/#${gistId}`, gistUrl: gistUrl.toString() };
  } catch {
    return undefined;
  }
}

function runGitHubCli(input: {
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
}): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawnProcess("gh", [...input.args], {
      cwd: input.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      action();
    };
    const append = (current: string, chunk: Buffer) => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") > 65_536) {
        child.kill();
        finish(() => reject(new Error("GitHub CLI output exceeded the limit.")));
        return current;
      }
      return next;
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", (cause) => finish(() => reject(cause)));
    child.once("close", (code) =>
      finish(() =>
        code === 0
          ? resolve(stdout.trim())
          : reject(new Error(stderr.trim() || `GitHub CLI exited with code ${code ?? "unknown"}.`)),
      ),
    );
  });
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((part) => {
      if (!isRecord(part)) return [];
      if (typeof part.text === "string") return [part.text];
      if (part.type === "image") return ["[image]"];
      if (part.type === "toolCall" && typeof part.name === "string") return [`[tool] ${part.name}`];
      return [];
    })
    .join("\n");
}

function entryPresentation(entry: Record<string, unknown>): {
  readonly role?: string;
  readonly preview: string;
  readonly editorText?: string;
} {
  if (entry.type === "message" && isRecord(entry.message)) {
    const role = typeof entry.message.role === "string" ? entry.message.role : undefined;
    const text = contentText(entry.message.content);
    return {
      ...(role ? { role } : {}),
      preview: text || role || "message",
      ...(role === "user" ? { editorText: text } : {}),
    };
  }
  if (entry.type === "custom_message") {
    if (entry.display !== true) return { preview: String(entry.customType ?? "custom message") };
    const text = contentText(entry.content);
    return {
      preview: text || String(entry.customType ?? "custom message"),
      editorText: text,
    };
  }
  if (entry.type === "compaction" || entry.type === "branch_summary") {
    return { preview: typeof entry.summary === "string" ? entry.summary : String(entry.type) };
  }
  if (entry.type === "model_change") {
    return { preview: `${String(entry.provider ?? "")}/${String(entry.modelId ?? "")}` };
  }
  if (entry.type === "thinking_level_change") {
    return { preview: String(entry.thinkingLevel ?? "thinking level change") };
  }
  if (entry.type === "custom") return { preview: String(entry.customType ?? "custom") };
  if (entry.type === "session_info") return { preview: String(entry.name ?? "session info") };
  if (entry.type === "label") return { preview: String(entry.label ?? "label cleared") };
  return { preview: String(entry.type ?? "entry") };
}

export function parsePiSessionTree(raw: unknown): PiNativeSessionTree {
  if (!isRecord(raw) || !Array.isArray(raw.tree)) {
    throw new Error("pi get_tree response is missing its tree");
  }
  const entries: Array<PiNativeSessionTree["entries"][number]> = [];
  const childIds: string[][] = [];
  const stack = raw.tree
    .map((rawNode) => ({ rawNode, parentIndex: null as number | null }))
    .reverse();

  while (stack.length > 0) {
    const node = stack.pop();
    if (
      !node ||
      !isRecord(node.rawNode) ||
      !isRecord(node.rawNode.entry) ||
      !Array.isArray(node.rawNode.children)
    ) {
      throw new Error("pi get_tree response contains an invalid node");
    }
    const entry = node.rawNode.entry;
    if (
      typeof entry.id !== "string" ||
      typeof entry.timestamp !== "string" ||
      !Schema.is(PiNativeTreeEntryKind)(entry.type)
    ) {
      throw new Error("pi get_tree response contains an invalid entry");
    }

    const order = entries.length;
    const presentation = entryPresentation(entry);
    entries.push({
      id: entry.id,
      parentId: typeof entry.parentId === "string" ? entry.parentId : null,
      childIds: [],
      order,
      kind: entry.type,
      timestamp: entry.timestamp,
      preview: presentation.preview,
      ...(presentation.role ? { role: presentation.role } : {}),
      ...(presentation.editorText !== undefined ? { editorText: presentation.editorText } : {}),
      ...(typeof node.rawNode.label === "string" ? { label: node.rawNode.label } : {}),
    });
    childIds.push([]);
    if (node.parentIndex !== null) childIds[node.parentIndex]?.push(entry.id);
    for (let index = node.rawNode.children.length - 1; index >= 0; index -= 1) {
      stack.push({ rawNode: node.rawNode.children[index], parentIndex: order });
    }
  }

  const leafId = typeof raw.leafId === "string" ? raw.leafId : null;
  return {
    entries: entries.map((entry, index) => ({ ...entry, childIds: childIds[index] ?? [] })),
    leafId,
  };
}

interface PiBranchEntry {
  readonly id: string;
  readonly parentId: string | undefined;
  readonly role: string | undefined;
}

function toBranchEntry(raw: unknown): PiBranchEntry | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const entry = raw as Record<string, unknown>;
  if (entry.type !== "message" || typeof entry.id !== "string") {
    return undefined;
  }
  const message = entry.message as Record<string, unknown> | undefined;
  return {
    id: entry.id,
    parentId: typeof entry.parentId === "string" ? entry.parentId : undefined,
    role: typeof message?.role === "string" ? message.role : undefined,
  };
}

/**
 * Entry id of the `numTurns`-th most recent user message on the active
 * branch, or `undefined` when the branch holds fewer user turns than that.
 *
 * `get_entries` spans the whole session tree — pre-compaction history and
 * abandoned branches included — so the active branch has to be recovered by
 * walking parent links back from the leaf. Exported for unit testing.
 */
export function nthLastUserEntryOnActiveBranch(
  entries: ReadonlyArray<unknown>,
  leafId: string | undefined,
  numTurns: number,
): string | undefined {
  if (leafId === undefined || numTurns < 1) {
    return undefined;
  }
  const byId = new Map<string, PiBranchEntry>();
  for (const raw of entries) {
    const entry = toBranchEntry(raw);
    if (entry !== undefined) {
      byId.set(entry.id, entry);
    }
  }

  const userEntryIds: Array<string> = [];
  const visited = new Set<string>();
  let cursor: string | undefined = leafId;
  // Leaf → root, so user entries accumulate newest-first. `visited` guards
  // against a malformed parent cycle.
  while (cursor !== undefined && !visited.has(cursor)) {
    visited.add(cursor);
    const entry: PiBranchEntry | undefined = byId.get(cursor);
    if (entry === undefined) {
      break;
    }
    if (entry.role === "user") {
      userEntryIds.push(entry.id);
    }
    cursor = entry.parentId;
  }

  return userEntryIds[numTurns - 1];
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
  readonly mutationLock: Semaphore.Semaphore;
  readonly ownershipToken: symbol;
  piSessionId: string;
  activeTurnId: TurnId | undefined;
  abortRequested: boolean;
  /** Minted item id for the assistant message currently streaming. */
  assistantItemId: string | undefined;
  /**
   * True once `item.started` was emitted for the current assistant message.
   * The item is opened lazily on the first content delta: some models (e.g.
   * cursor-backed ones) can return an entirely empty assistant message, and
   * an assistant item with no content breaks downstream assistant-completion
   * handling.
   */
  assistantItemOpened: boolean;
  /** Minted item id for a running compaction, if any. */
  compactionItemId: string | undefined;
  /** Current `provider/modelId` slug, mirrors pi state. */
  model: string | undefined;
  thinkingLevel: string | undefined;
  sessionName: string | undefined;
  /**
   * Interactive extension UI requests awaiting an answer, keyed by pi's
   * request id (which doubles as the question id on the wire).
   */
  readonly pendingUiRequests: Map<string, PiUiRequestKind>;
}

type PiUiRequestKind = "select" | "confirm" | "input" | "editor";

const CONFIRM_YES = "Yes";
const CONFIRM_NO = "No";

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
    const adapterScope = yield* Scope.Scope;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const crypto = yield* Crypto.Crypto;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const rpcRuntime = resolvePiRuntimeCommand({
      piSettings,
      entry: "rpc",
      ...(options?.environment ? { environment: options.environment } : {}),
    });

    const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, PiSessionContext>();
    const resumeSessionIds = new Map<ThreadId, ReadonlyMap<string, string>>();
    const sessionOwnershipLock = yield* Semaphore.make(1);

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
        yield* Effect.forEach(contexts, (context) => Effect.ignoreCause(closePiContext(context)), {
          concurrency: "unbounded",
          discard: true,
        });
      }).pipe(Effect.ensuring(Queue.shutdown(runtimeEvents))),
    );

    const closePiContext = (context: PiSessionContext) =>
      Effect.gen(function* () {
        if (yield* Ref.getAndSet(context.stopped, true)) {
          return;
        }
        sessions.delete(context.session.threadId);
        resumeSessionIds.delete(context.session.threadId);
        yield* context.rpc.terminate.pipe(
          Effect.mapError((cause) => rpcError("terminate", cause)),
          Effect.ensuring(
            Scope.close(context.sessionScope, Exit.void).pipe(
              Effect.ensuring(Effect.sync(() => releasePiSessionClaims(context.ownershipToken))),
            ),
          ),
        );
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
        context.assistantItemOpened = false;
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
        context.assistantItemOpened = false;
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
        if (!context.assistantItemOpened) {
          context.assistantItemOpened = true;
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId: context.activeTurnId,
              itemId: context.assistantItemId,
            })),
            type: "item.started",
            payload: { itemType: "assistant_message", status: "inProgress" },
          });
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
        const opened = context.assistantItemOpened;
        context.assistantItemId = undefined;
        context.assistantItemOpened = false;
        if (!opened) {
          // The message produced no content; there is no item to close.
          return;
        }
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
      }).pipe(
        Effect.flatMap((base) => emit({ ...base, type: "runtime.warning", payload: { message } })),
      );

    const EXTENSION_UI_NOTIFICATION_METHODS = new Set([
      "notify",
      "setStatus",
      "clearStatus",
      "setWidget",
      "clearWidget",
      "setTitle",
      "set_editor_text",
    ]);

    const cancelUiRequest = (context: PiSessionContext, requestId: string) =>
      context.rpc
        .send({ type: "extension_ui_response", id: requestId, cancelled: true })
        .pipe(Effect.ignore);

    const uiQuestionFor = (
      record: PiRpcRecord,
      requestId: string,
    ): UserInputQuestion | undefined => {
      const title =
        typeof record.title === "string" && record.title.length > 0 ? record.title : undefined;
      if (title === undefined) {
        return undefined;
      }
      if (record.method === "select") {
        const options = (Array.isArray(record.options) ? record.options : [])
          .filter((option): option is string => typeof option === "string" && option.length > 0)
          .map((option) => ({ label: option, description: option }));
        return options.length > 0
          ? { id: requestId, header: "Extension", question: title, options, multiSelect: false }
          : undefined;
      }
      if (record.method === "confirm") {
        const message =
          typeof record.message === "string" && record.message.length > 0 ? record.message : title;
        return {
          id: requestId,
          header: "Extension",
          question: title,
          options: [
            { label: CONFIRM_YES, description: message },
            { label: CONFIRM_NO, description: "Decline" },
          ],
          multiSelect: false,
        };
      }
      if (record.method !== "input" && record.method !== "editor") return undefined;
      const placeholder = typeof record.placeholder === "string" ? record.placeholder : undefined;
      const defaultAnswer =
        record.method === "editor" && typeof record.prefill === "string"
          ? record.prefill
          : undefined;
      return {
        id: requestId,
        header: "Extension",
        question: title,
        options: [],
        multiSelect: false,
        answerMode: "verbatim",
        ...(placeholder !== undefined ? { placeholder } : {}),
        ...(defaultAnswer !== undefined ? { defaultAnswer } : {}),
      };
    };

    const handleExtensionUiRequest = (context: PiSessionContext, record: PiRpcRecord) =>
      Effect.gen(function* () {
        const requestId = record.id;
        if (typeof requestId !== "string") {
          return;
        }
        const method = typeof record.method === "string" ? record.method : "";

        if (EXTENSION_UI_NOTIFICATION_METHODS.has(method)) {
          if (method === "notify" && typeof record.message === "string") {
            yield* handleWarning(context, record.message, record);
          }
          return;
        }

        if (
          method === "select" ||
          method === "confirm" ||
          method === "input" ||
          method === "editor"
        ) {
          const question = uiQuestionFor(record, requestId);
          if (question !== undefined) {
            context.pendingUiRequests.set(requestId, method);
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId: context.activeTurnId,
                requestId,
                raw: record,
              })),
              type: "user-input.requested",
              payload: { questions: [question] },
            });
            return;
          }
        }

        yield* cancelUiRequest(context, requestId);
        yield* handleWarning(
          context,
          `A pi extension requested interactive UI ('${method || "unknown"}') that this client cannot render; the request was cancelled.`,
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

    /**
     * Translation of one pi record must never take the session's event pump
     * down with it: `Stream.runForEach` stops on the first failure, which
     * would silently strand the turn (no further deltas, no `turn.completed`).
     * Mirrors the ingestion worker's `processInputSafely`.
     */
    const handlePiEventSafely = (context: PiSessionContext, record: PiRpcRecord) =>
      handlePiEvent(context, record).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("pi adapter failed to translate a runtime event", {
                threadId: context.session.threadId,
                recordType: record.type,
                cause: Cause.pretty(cause),
              }),
        ),
      );

    const emitUnexpectedExit = (context: PiSessionContext, code: number) =>
      Effect.gen(function* () {
        if (yield* Ref.getAndSet(context.stopped, true)) {
          return;
        }
        const turnId = context.activeTurnId;
        sessions.delete(context.session.threadId);
        resumeSessionIds.delete(context.session.threadId);
        yield* context.rpc.terminate.pipe(Effect.ignore);
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
        yield* Scope.close(context.sessionScope, Exit.void).pipe(
          Effect.ensuring(Effect.sync(() => releasePiSessionClaims(context.ownershipToken))),
          Effect.forkIn(adapterScope, { startImmediately: true }),
        );
      });

    // ── Model / prompt plumbing ────────────────────────────────────────

    const applyModelSelection = (
      context: PiSessionContext,
      modelSelection: ModelSelection | undefined,
    ) =>
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

    const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) => {
      const ownershipToken = Symbol();
      let claimedSessionId: string | undefined;
      let contextToClose: PiSessionContext | undefined;

      return sessionOwnershipLock
        .withPermits(1)(
          Effect.gen(function* () {
            const existing = sessions.get(input.threadId);
            if (existing !== undefined) return existing.session;

            const resume = parsePiResume(input.resumeCursor);
            const piSessionId = resume?.sessionId ?? (yield* randomUUIDv4);
            if (!(yield* Effect.sync(() => claimPiSession(piSessionId, ownershipToken)))) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "startSession",
                issue: `Pi session '${piSessionId}' is already open in another thread.`,
              });
            }
            claimedSessionId = piSessionId;

            const cwd = input.cwd ?? serverConfig.cwd;
            const sessionScope = yield* Scope.make();
            const rpc = yield* Effect.gen(function* () {
              const process = yield* spawnPiRpc({
                binaryPath: rpcRuntime.binaryPath,
                args: [...rpcRuntime.argsPrefix, "--session-id", piSessionId],
                cwd,
                ...(rpcRuntime.environment ? { environment: rpcRuntime.environment } : {}),
              }).pipe(
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                Scope.provide(sessionScope),
                Effect.mapError((cause) => rpcError("startSession", cause)),
              );
              const capabilities = yield* process
                .request({ type: "get_capabilities" })
                .pipe(Effect.mapError((cause) => rpcError("get_capabilities", cause)));
              const capabilityIssue = piRpcCapabilityIssue(capabilities);
              if (capabilityIssue !== undefined) {
                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "get_capabilities",
                  detail: `Incompatible pi RPC runtime: ${capabilityIssue}.`,
                });
              }
              return process;
            }).pipe(Effect.onError(() => Scope.close(sessionScope, Exit.void)));

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
              mutationLock: yield* Semaphore.make(1),
              ownershipToken,
              piSessionId,
              activeTurnId: undefined,
              abortRequested: false,
              assistantItemId: undefined,
              assistantItemOpened: false,
              compactionItemId: undefined,
              model: undefined,
              thinkingLevel: undefined,
              sessionName: undefined,
              pendingUiRequests: new Map(),
            };
            contextToClose = context;

            const initialState = yield* getPiSessionState(context);
            if (initialState.sessionId !== piSessionId) {
              if (
                !(yield* Effect.sync(() => claimPiSession(initialState.sessionId, ownershipToken)))
              ) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "startSession",
                  issue: `Pi session '${initialState.sessionId}' is already open in another thread.`,
                });
              }
              yield* Effect.sync(() => releasePiSessionClaim(piSessionId, ownershipToken));
              claimedSessionId = initialState.sessionId;
            }
            yield* adoptPiSessionState(context, initialState);
            sessions.set(input.threadId, context);

            if (input.modelSelection !== undefined) {
              yield* applyModelSelection(context, input.modelSelection);
            }

            yield* rpc.events.pipe(
              Stream.runForEach((record) => handlePiEventSafely(context, record)),
              Effect.ignore,
              Effect.forkIn(sessionScope),
            );
            yield* rpc.awaitExit.pipe(
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
              payload: {
                config: {
                  piSessionId: context.piSessionId,
                  ...(context.model ? { model: context.model } : {}),
                },
              },
            });
            yield* emit({
              ...(yield* buildEventBase({ threadId: input.threadId })),
              type: "thread.started",
              payload: { providerThreadId: context.piSessionId },
            });
            yield* emitSessionState(context, "ready");

            return context.session;
          }),
        )
        .pipe(
          Effect.onError(() =>
            contextToClose !== undefined
              ? closePiContext(contextToClose).pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      if (claimedSessionId !== undefined)
                        releasePiSessionClaim(claimedSessionId, ownershipToken);
                    }),
                  ),
                  Effect.ignoreCause,
                )
              : Effect.sync(() => {
                  if (claimedSessionId !== undefined)
                    releasePiSessionClaim(claimedSessionId, ownershipToken);
                }),
          ),
        );
    };

    const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const context = yield* requireContext(input.threadId);
        return yield* context.mutationLock.withPermit(
          Effect.gen(function* () {
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
                    if (context.activeTurnId === turnId) context.activeTurnId = undefined;
                  }),
                ),
                Effect.mapError((cause) => rpcError("prompt", cause)),
              );

            return {
              threadId: input.threadId,
              turnId,
              resumeCursor: context.session.resumeCursor,
            };
          }),
        );
      });

    const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (threadId) =>
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
      answers,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireContext(threadId);
        const kind = context.pendingUiRequests.get(requestId);
        if (kind === undefined) {
          // pi auto-resolves dialogs once their timeout elapses, so a late
          // answer has nothing left to answer.
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "respondToUserInput",
            detail: `No pending pi extension UI request '${requestId}'; it may have timed out.`,
          });
        }
        context.pendingUiRequests.delete(requestId);

        // Questions carry the request id, so the answer is keyed by it.
        const answer = answers[requestId];
        const label = Array.isArray(answer)
          ? answer.find((entry): entry is string => typeof entry === "string")
          : typeof answer === "string"
            ? answer
            : undefined;

        yield* context.rpc
          .send(
            label === undefined
              ? { type: "extension_ui_response", id: requestId, cancelled: true }
              : kind === "confirm"
                ? { type: "extension_ui_response", id: requestId, confirmed: label === CONFIRM_YES }
                : { type: "extension_ui_response", id: requestId, value: label },
          )
          .pipe(Effect.mapError((cause) => rpcError("extension_ui_response", cause)));

        yield* emit({
          ...(yield* buildEventBase({
            threadId,
            turnId: context.activeTurnId,
            requestId,
          })),
          type: "user-input.resolved",
          payload: { answers },
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

    /**
     * Rolling back N turns means re-rooting the conversation just before the
     * Nth most recent user message: pi's `fork` takes a user entry id and
     * starts a new branch from it, which drops that message and everything
     * after it from the active branch.
     */
    const rollbackThread: ProviderAdapterShape<ProviderAdapterError>["rollbackThread"] = (
      threadId,
      numTurns,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireContext(threadId);
        if (numTurns < 1) {
          return yield* readThread(threadId);
        }

        const entriesResponse = yield* context.rpc
          .request({ type: "get_entries" })
          .pipe(Effect.mapError((cause) => rpcError("get_entries", cause)));
        const entriesData = entriesResponse.data as Record<string, unknown> | undefined;
        const entries = Array.isArray(entriesData?.entries) ? entriesData.entries : [];
        const leafId = typeof entriesData?.leafId === "string" ? entriesData.leafId : undefined;

        const entryId = nthLastUserEntryOnActiveBranch(entries, leafId, numTurns);
        if (entryId === undefined) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: `pi session for thread '${threadId}' has fewer than ${numTurns} user turn(s) to roll back.`,
          });
        }

        const forked = yield* context.rpc
          .request({ type: "fork", entryId })
          .pipe(Effect.mapError((cause) => rpcError("fork", cause)));
        if ((forked.data as Record<string, unknown> | undefined)?.cancelled === true) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "fork",
            detail: "A pi extension cancelled the fork; the thread was not rolled back.",
          });
        }

        return yield* readThread(threadId);
      });

    const getPiSessionState = (context: PiSessionContext) =>
      context.rpc.request({ type: "get_state" }).pipe(
        Effect.flatMap((response) =>
          Schema.decodeUnknownEffect(PiNativeSessionState)(response.data),
        ),
        Effect.mapError((cause) => rpcError("get_state", cause)),
      );

    const adoptPiSessionState = (context: PiSessionContext, state: PiNativeSessionState) => {
      context.piSessionId = state.sessionId;
      context.model = state.model ? `${state.model.provider}/${state.model.id}` : undefined;
      context.thinkingLevel = state.thinkingLevel;
      context.sessionName = state.sessionName;
      return touchSession(context, {
        resumeCursor: makePiResume(state.sessionId),
        model: context.model,
        status: state.isStreaming || state.isCompacting ? "running" : "ready",
      });
    };

    const getPiSessionTree: PiNativeAdapterShape<ProviderAdapterError>["getSessionTree"] = (
      threadId,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireContext(threadId);
        const response = yield* context.rpc
          .request({ type: "get_tree" })
          .pipe(Effect.mapError((cause) => rpcError("get_tree", cause)));
        return yield* Effect.try({
          try: () => parsePiSessionTree(response.data),
          catch: (cause) => rpcError("get_tree", cause),
        });
      });

    const getPiActiveTranscript: PiNativeAdapterShape<ProviderAdapterError>["getActiveTranscript"] =
      (threadId) =>
        Effect.gen(function* () {
          const context = yield* requireContext(threadId);
          const response = yield* context.rpc
            .request({ type: "get_entries" })
            .pipe(Effect.mapError((cause) => rpcError("get_entries", cause)));
          const data = isRecord(response.data) ? response.data : {};
          const entries = Array.isArray(data.entries) ? data.entries : [];
          const leafId = typeof data.leafId === "string" ? data.leafId : undefined;
          const transcript = yield* Effect.try({
            try: () => normalizePiActiveTranscript(entries, leafId, threadId),
            catch: (cause) => rpcError("get_entries", cause),
          });
          yield* fileSystem
            .makeDirectory(serverConfig.attachmentsDir, { recursive: true })
            .pipe(Effect.mapError((cause) => rpcError("materialize_transcript_images", cause)));
          yield* Effect.forEach(
            transcript.images ?? [],
            ({ attachment, data }) => {
              const attachmentPath = resolveAttachmentPath({
                attachmentsDir: serverConfig.attachmentsDir,
                attachment,
              });
              return attachmentPath === null
                ? Effect.fail(rpcError("materialize_transcript_images", "Invalid attachment path"))
                : fileSystem
                    .writeFile(attachmentPath, data)
                    .pipe(
                      Effect.mapError((cause) => rpcError("materialize_transcript_images", cause)),
                    );
            },
            { concurrency: 1, discard: true },
          );
          return transcript;
        });

    const navigatePiSessionTree: PiNativeAdapterShape<ProviderAdapterError>["navigateSessionTree"] =
      (input) =>
        Effect.gen(function* () {
          const context = yield* requireContext(input.threadId);
          const state = yield* getPiSessionState(context);
          if (state.isStreaming || state.isCompacting) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "navigatePiSessionTree",
              issue: "Wait for the current response or compaction to finish before navigating.",
            });
          }
          const response = yield* context.rpc
            .request({
              type: "navigate_tree",
              targetId: input.targetId,
              ...(input.summarize !== undefined ? { summarize: input.summarize } : {}),
              ...(input.customInstructions !== undefined
                ? { customInstructions: input.customInstructions }
                : {}),
              ...(input.replaceInstructions !== undefined
                ? { replaceInstructions: input.replaceInstructions }
                : {}),
              ...(input.label !== undefined ? { label: input.label } : {}),
            })
            .pipe(Effect.mapError((cause) => rpcError("navigate_tree", cause)));
          return yield* Schema.decodeUnknownEffect(PiNativeNavigateTreeResult)(response.data).pipe(
            Effect.mapError((cause) => rpcError("navigate_tree", cause)),
          );
        });

    const abortPiBranchSummary: PiNativeAdapterShape<ProviderAdapterError>["abortBranchSummary"] = (
      threadId,
    ) =>
      requireContext(threadId).pipe(
        Effect.flatMap((context) => context.rpc.request({ type: "abort_branch_summary" })),
        Effect.mapError((cause) => rpcError("abort_branch_summary", cause)),
        Effect.asVoid,
      );

    const setPiEntryLabel: PiNativeAdapterShape<ProviderAdapterError>["setEntryLabel"] = (input) =>
      requireContext(input.threadId).pipe(
        Effect.flatMap((context) =>
          context.rpc.request({
            type: "set_entry_label",
            targetId: input.targetId,
            ...(input.label !== undefined ? { label: input.label } : {}),
          }),
        ),
        Effect.mapError((cause) => rpcError("set_entry_label", cause)),
        Effect.asVoid,
      );

    const reloadPiResources: PiNativeAdapterShape<ProviderAdapterError>["reloadResources"] = (
      threadId,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireContext(threadId);
        const state = yield* getPiSessionState(context);
        if (state.isStreaming) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "reloadPiResources",
            issue: "Wait for the current response to finish before reloading.",
          });
        }
        if (state.isCompacting) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "reloadPiResources",
            issue: "Wait for compaction to finish before reloading.",
          });
        }
        yield* context.rpc
          .request({ type: "reload" })
          .pipe(Effect.mapError((cause) => rpcError("reload", cause)));
      });

    const compactPiSession: PiNativeAdapterShape<ProviderAdapterError>["compactSession"] = (
      input,
    ) =>
      requireContext(input.threadId).pipe(
        Effect.flatMap((context) =>
          context.rpc.request({
            type: "compact",
            ...(input.customInstructions !== undefined
              ? { customInstructions: input.customInstructions }
              : {}),
          }),
        ),
        Effect.flatMap((response) =>
          Schema.decodeUnknownEffect(PiNativeCompactResult)(response.data),
        ),
        Effect.mapError((cause) => rpcError("compact", cause)),
      );

    const getPiSessionStateAndStats: PiNativeAdapterShape<ProviderAdapterError>["getSessionStateAndStats"] =
      (threadId) =>
        Effect.gen(function* () {
          const context = yield* requireContext(threadId);
          const state = yield* getPiSessionState(context);
          const statsResponse = yield* context.rpc
            .request({ type: "get_session_stats" })
            .pipe(Effect.mapError((cause) => rpcError("get_session_stats", cause)));
          const stats = yield* Schema.decodeUnknownEffect(PiNativeSessionStats)(
            statsResponse.data,
          ).pipe(Effect.mapError((cause) => rpcError("get_session_stats", cause)));
          return { state, stats };
        });

    const setPiSessionName: PiNativeAdapterShape<ProviderAdapterError>["setSessionName"] = (
      input,
    ) =>
      requireContext(input.threadId).pipe(
        Effect.flatMap((context) =>
          context.rpc.request({ type: "set_session_name", name: input.name }).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                context.sessionName = input.name;
              }),
            ),
          ),
        ),
        Effect.mapError((cause) => rpcError("set_session_name", cause)),
        Effect.asVoid,
      );

    const getPiLastAssistantText: PiNativeAdapterShape<ProviderAdapterError>["getLastAssistantText"] =
      (threadId) =>
        requireContext(threadId).pipe(
          Effect.flatMap((context) => context.rpc.request({ type: "get_last_assistant_text" })),
          Effect.flatMap((response) =>
            Schema.decodeUnknownEffect(PiNativeLastAssistantText)(response.data),
          ),
          Effect.mapError((cause) => rpcError("get_last_assistant_text", cause)),
        );

    const exportPiSessionHtml: PiNativeAdapterShape<ProviderAdapterError>["exportSessionHtml"] = (
      input,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireContext(input.threadId);
        const threadSegment = toSafeThreadAttachmentSegment(input.threadId);
        if (threadSegment === null) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "exportPiSessionHtml",
            issue: "Cannot export a Pi session with an invalid thread id.",
          });
        }

        const exportDir = yield* fileSystem.makeTempDirectory({ prefix: "d4-export-" });
        const canonicalExportDir = yield* fileSystem.realPath(exportDir);
        const outputPath = path.join(canonicalExportDir, `${threadSegment}.html`);
        return yield* Effect.gen(function* () {
          const response = yield* context.rpc.request({ type: "export_html", outputPath });
          const result = yield* Schema.decodeUnknownEffect(PiRpcExportHtmlResult)(response.data);
          if (result.path !== outputPath) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "export_html",
              detail: "Pi returned an unexpected export path.",
            });
          }

          const outputInfo = yield* Effect.tryPromise({
            try: () => NodeFSP.lstat(outputPath),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "export_html",
                detail: "Pi did not create the requested export file.",
                cause,
              }),
          });
          if (!outputInfo.isFile() || outputInfo.isSymbolicLink() || outputInfo.size === 0) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "export_html",
              detail: "Pi created an invalid export file.",
            });
          }

          const canonicalOutputPath = yield* fileSystem.realPath(outputPath);
          const relativeOutputPath = path.relative(canonicalExportDir, canonicalOutputPath);
          if (
            relativeOutputPath === "" ||
            relativeOutputPath === ".." ||
            relativeOutputPath.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relativeOutputPath)
          ) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "export_html",
              detail: "Pi created an export file outside the export directory.",
            });
          }
          return {
            canonicalPath: canonicalOutputPath,
            fileName: path.basename(canonicalOutputPath),
          };
        }).pipe(
          Effect.tapError(() =>
            fileSystem
              .remove(exportDir, { recursive: true, force: true })
              .pipe(Effect.catch(() => Effect.void)),
          ),
        );
      }).pipe(Effect.mapError((cause) => rpcError("export_html", cause)));

    const requestDecoded = <S extends Schema.Top>(
      context: PiSessionContext,
      method: string,
      command: PiRpcRecord,
      schema: S,
    ) =>
      context.rpc.request(command).pipe(
        Effect.flatMap((response) => Schema.decodeUnknownEffect(schema)(response.data)),
        Effect.mapError((cause) => rpcError(method, cause)),
      );

    const ensurePiIdle = (context: PiSessionContext, operation: string) =>
      getPiSessionState(context).pipe(
        Effect.flatMap((state) =>
          state.isStreaming || state.isCompacting
            ? Effect.fail(
                new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation,
                  issue: "Wait for the current response or compaction to finish.",
                }),
              )
            : Effect.void,
        ),
      );

    const adoptSwitchedSession = (
      context: PiSessionContext,
      result: PiNativeSessionMutationResult,
    ) =>
      Effect.gen(function* () {
        if (result.cancelled) return result;
        const previousSessionId = context.piSessionId;
        const state = yield* getPiSessionState(context);
        if (!(yield* Effect.sync(() => claimPiSession(state.sessionId, context.ownershipToken)))) {
          yield* closePiContext(context);
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "adoptSwitchedSession",
            issue: `Pi session '${state.sessionId}' is already open in another thread.`,
          });
        }
        yield* adoptPiSessionState(context, state);
        resumeSessionIds.delete(context.session.threadId);
        if (previousSessionId !== state.sessionId) {
          yield* Effect.sync(() =>
            releasePiSessionClaim(previousSessionId, context.ownershipToken),
          );
        }
        return {
          ...result,
          sessionId: state.sessionId,
          ...(state.model ? { model: state.model } : {}),
          thinkingLevel: state.thinkingLevel,
        };
      });

    const getPiSettings: PiNativeAdapterShape<ProviderAdapterError>["getSettings"] = (input) =>
      Effect.gen(function* () {
        const context = yield* requireContext(input.threadId);
        return yield* requestDecoded(
          context,
          "get_safe_settings",
          { type: "get_safe_settings", scope: input.scope },
          PiNativeSettingsResult,
        );
      });
    const updatePiSettings: PiNativeAdapterShape<ProviderAdapterError>["updateSettings"] = (
      input,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireContext(input.threadId);
        return yield* requestDecoded(
          context,
          "set_safe_settings",
          { type: "set_safe_settings", scope: input.scope, values: input.values },
          PiNativeSettingsResult,
        );
      });
    const getPiScopedModels: PiNativeAdapterShape<ProviderAdapterError>["getScopedModels"] = (
      input,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireContext(input.threadId);
        return yield* requestDecoded(
          context,
          "get_scoped_models",
          { type: "get_scoped_models", scope: input.scope },
          PiNativeScopedModelsResult,
        );
      });
    const updatePiScopedModels: PiNativeAdapterShape<ProviderAdapterError>["updateScopedModels"] = (
      input,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireContext(input.threadId);
        return yield* requestDecoded(
          context,
          "set_scoped_models",
          { type: "set_scoped_models", scope: input.scope, patterns: input.patterns },
          PiNativeScopedModelsResult,
        );
      });
    const listPiResumeSessions: PiNativeAdapterShape<ProviderAdapterError>["listResumeSessions"] = (
      threadId,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireContext(threadId);
        const result = yield* requestDecoded(
          context,
          "list_resume_sessions",
          { type: "list_resume_sessions" },
          PiResumeSessionsRuntimeResult,
        );
        resumeSessionIds.set(
          threadId,
          new Map(result.sessions.map((session) => [session.id, session.sessionId])),
        );
        return {
          sessions: result.sessions.map(({ sessionId: _sessionId, ...session }) => session),
        };
      });
    const switchSession = (context: PiSessionContext, operation: string, command: PiRpcRecord) =>
      ensurePiIdle(context, operation).pipe(
        Effect.andThen(
          requestDecoded(context, operation, command, PiNativeSessionMutationResult).pipe(
            Effect.flatMap((result) => adoptSwitchedSession(context, result)),
            Effect.onExit((exit) =>
              Exit.isSuccess(exit) ? Effect.void : Effect.ignoreCause(closePiContext(context)),
            ),
          ),
        ),
      );
    const resumePiSession: PiNativeAdapterShape<ProviderAdapterError>["resumeSession"] = (input) =>
      sessionOwnershipLock.withPermits(1)(
        Effect.gen(function* () {
          const context = yield* requireContext(input.threadId);
          const targetSessionId = resumeSessionIds.get(input.threadId)?.get(input.sessionId);
          if (targetSessionId === undefined) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "resumePiSession",
              issue: "Unknown or expired Pi session id.",
            });
          }
          if (
            !(yield* Effect.sync(() => claimPiSession(targetSessionId, context.ownershipToken)))
          ) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "resumePiSession",
              issue: "That Pi session is already open in another thread.",
            });
          }
          return yield* switchSession(context, "resume_session", {
            type: "resume_session",
            sessionId: input.sessionId,
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (context.piSessionId !== targetSessionId) {
                  releasePiSessionClaim(targetSessionId, context.ownershipToken);
                }
              }),
            ),
          );
        }),
      );
    const importPiSession: PiNativeAdapterShape<ProviderAdapterError>["importSession"] = (input) =>
      Effect.gen(function* () {
        const context = yield* requireContext(input.threadId);
        const bytes = Buffer.byteLength(input.content, "utf8");
        const lines = input.content.split("\n").length;
        if (bytes > PI_NATIVE_IMPORT_MAX_BYTES || lines > PI_NATIVE_IMPORT_MAX_LINES) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "importPiSession",
            issue: "Imported session exceeds the byte or line limit.",
          });
        }
        const entries = input.content.split("\n").filter((line) => line.trim().length > 0).length;
        if (entries > PI_NATIVE_IMPORT_MAX_ENTRIES) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "importPiSession",
            issue: "Imported session has too many entries.",
          });
        }
        return yield* switchSession(context, "import_session", {
          type: "import_session",
          filename: input.filename,
          content: input.content,
        });
      });
    const forkPiSession: PiNativeAdapterShape<ProviderAdapterError>["forkSession"] = (input) =>
      Effect.gen(function* () {
        const context = yield* requireContext(input.threadId);
        return yield* switchSession(context, "fork_session", {
          type: "fork_session",
          entryId: input.targetId,
        });
      });
    const clonePiSession: PiNativeAdapterShape<ProviderAdapterError>["cloneSession"] = (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireContext(threadId);
        return yield* switchSession(context, "clone_session", { type: "clone_session" });
      });
    const getPiTrust: PiNativeAdapterShape<ProviderAdapterError>["getTrust"] = (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireContext(threadId);
        return yield* requestDecoded(
          context,
          "get_project_trust",
          { type: "get_project_trust" },
          PiNativeTrustResult,
        );
      });
    const setPiTrust: PiNativeAdapterShape<ProviderAdapterError>["setTrust"] = (input) =>
      Effect.gen(function* () {
        if (input.trusted && input.confirmed !== true) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "setPiTrust",
            issue: "Trusting a project requires explicit confirmation.",
          });
        }
        const context = yield* requireContext(input.threadId);
        return yield* requestDecoded(
          context,
          "set_project_trust",
          { type: "set_project_trust", trusted: input.trusted, confirmed: input.confirmed },
          PiNativeTrustResult,
        );
      });
    const getPiChangelog: PiNativeAdapterShape<ProviderAdapterError>["getChangelog"] = (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireContext(threadId);
        return yield* requestDecoded(
          context,
          "get_changelog",
          { type: "get_changelog" },
          PiNativeChangelogResult,
        );
      });
    const getPiAuthState: PiNativeAdapterShape<ProviderAdapterError>["getAuthState"] = (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireContext(threadId);
        return yield* requestDecoded(
          context,
          "get_auth_state",
          { type: "get_auth_state" },
          PiNativeAuthState,
        );
      });
    const beginPiAuthLogin: PiNativeAdapterShape<ProviderAdapterError>["beginAuthLogin"] = (
      input,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireContext(input.threadId);
        return yield* requestDecoded(
          context,
          "begin_auth_login",
          {
            type: "begin_auth_login",
            providerId: input.providerId,
            authType: input.authType,
          },
          PiNativeAuthFlow,
        );
      });
    const getPiAuthFlow: PiNativeAdapterShape<ProviderAdapterError>["getAuthFlow"] = (input) =>
      Effect.gen(function* () {
        const context = yield* requireContext(input.threadId);
        return yield* requestDecoded(
          context,
          "get_auth_flow",
          {
            type: "get_auth_flow",
            flowId: input.flowId,
          },
          PiNativeAuthFlow,
        );
      });
    const respondPiAuthFlow: PiNativeAdapterShape<ProviderAdapterError>["respondAuthFlow"] = (
      input,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireContext(input.threadId);
        return yield* requestDecoded(
          context,
          "respond_auth_flow",
          {
            type: "respond_auth_flow",
            flowId: input.flowId,
            promptId: input.promptId,
            response: input.response,
          },
          PiNativeAuthFlow,
        );
      });
    const cancelPiAuthFlow: PiNativeAdapterShape<ProviderAdapterError>["cancelAuthFlow"] = (
      input,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireContext(input.threadId);
        return yield* requestDecoded(
          context,
          "cancel_auth_flow",
          {
            type: "cancel_auth_flow",
            flowId: input.flowId,
          },
          PiNativeAuthFlow,
        );
      });
    const logoutPiAuth: PiNativeAdapterShape<ProviderAdapterError>["logoutAuth"] = (input) =>
      Effect.gen(function* () {
        const context = yield* requireContext(input.threadId);
        yield* context.rpc
          .request({
            type: "logout_auth",
            providerId: input.providerId,
            confirmed: input.confirmed,
          })
          .pipe(Effect.mapError((cause) => rpcError("logout_auth", cause)));
      });
    const sharePiSession: PiNativeAdapterShape<ProviderAdapterError>["shareSession"] = (input) =>
      Effect.gen(function* () {
        if (!input.confirmed) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sharePiSession",
            issue: "Sharing requires explicit confirmation.",
          });
        }
        const context = yield* requireContext(input.threadId);
        const cwd = context.session.cwd ?? serverConfig.cwd;
        yield* Effect.tryPromise({
          try: () => runGitHubCli({ args: ["auth", "status"], cwd }),
          catch: (cause) => rpcError("share_auth", cause),
        });
        const exported = yield* exportPiSessionHtml({ threadId: input.threadId });
        return yield* Effect.gen(function* () {
          const gistOutput = yield* Effect.tryPromise({
            try: () =>
              runGitHubCli({
                args: ["gist", "create", "--public=false", exported.canonicalPath],
                cwd,
              }),
            catch: (cause) => rpcError("share_gist", cause),
          });
          const result = parseGitHubGistShareUrl(gistOutput);
          if (!result) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "share_gist",
              detail: "GitHub CLI returned an invalid gist URL.",
            });
          }
          return result;
        }).pipe(
          Effect.ensuring(
            fileSystem
              .remove(path.dirname(exported.canonicalPath), { recursive: true, force: true })
              .pipe(Effect.catch(() => Effect.void)),
          ),
        );
      });

    const withPiSessionLock: PiNativeAdapterShape<ProviderAdapterError>["withSessionLock"] = (
      threadId,
      effect,
    ) =>
      requireContext(threadId).pipe(
        Effect.flatMap((context) => context.mutationLock.withPermit(effect)),
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
      piNative: {
        withSessionLock: withPiSessionLock,
        getSessionTree: getPiSessionTree,
        getActiveTranscript: getPiActiveTranscript,
        navigateSessionTree: navigatePiSessionTree,
        abortBranchSummary: abortPiBranchSummary,
        setEntryLabel: setPiEntryLabel,
        reloadResources: reloadPiResources,
        compactSession: compactPiSession,
        getSessionStateAndStats: getPiSessionStateAndStats,
        setSessionName: setPiSessionName,
        getLastAssistantText: getPiLastAssistantText,
        exportSessionHtml: exportPiSessionHtml,
        getSettings: getPiSettings,
        updateSettings: updatePiSettings,
        getScopedModels: getPiScopedModels,
        updateScopedModels: updatePiScopedModels,
        listResumeSessions: listPiResumeSessions,
        resumeSession: resumePiSession,
        importSession: importPiSession,
        forkSession: forkPiSession,
        cloneSession: clonePiSession,
        getTrust: getPiTrust,
        setTrust: setPiTrust,
        getChangelog: getPiChangelog,
        getAuthState: getPiAuthState,
        beginAuthLogin: beginPiAuthLogin,
        getAuthFlow: getPiAuthFlow,
        respondAuthFlow: respondPiAuthFlow,
        cancelAuthFlow: cancelPiAuthFlow,
        logoutAuth: logoutPiAuth,
        shareSession: sharePiSession,
      },
      stopAll,
      get streamEvents() {
        return Stream.fromQueue(runtimeEvents);
      },
    } satisfies ProviderAdapterShape<ProviderAdapterError>;
  });
}
