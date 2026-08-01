// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ApprovalRequestId,
  PiSettings,
  ProviderInstanceId,
  ThreadId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as ServerConfig from "../../config.ts";
import {
  makePiAdapter,
  nthLastUserEntryOnActiveBranch,
  parseGitHubGistShareUrl,
  parsePiSessionTree,
} from "./PiAdapter.ts";

// Scripted stand-in for the pi binary. Spawning a real executable is what
// lets this exercise `makePiAdapter` end to end: the adapter owns its own
// spawn, so `binaryPath` is the only injection point.
const fakePiPath = `${import.meta.dirname}/fixtures/fake-pi`;

const decodePiSettings = Schema.decodeSync(PiSettings);
const settings = decodePiSettings({ binaryPath: fakePiPath });

const layer = NodeServices.layer;

const waitForFileContent = (filePath: string, expected: string) =>
  Effect.callback<void>((resume) => {
    let completed = false;
    const completeIfReady = () => {
      if (
        !completed &&
        NodeFS.existsSync(filePath) &&
        NodeFS.readFileSync(filePath, "utf8") === expected
      ) {
        completed = true;
        watcher.close();
        resume(Effect.void);
      }
    };
    const watcher = NodeFS.watch(NodePath.dirname(filePath), completeIfReady);
    completeIfReady();
    return Effect.sync(() => watcher.close());
  });

it.layer(layer)("PiAdapter", (it) => {
  it.effect("translates a pi turn into runtime events", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* makePiAdapter(settings, {
          instanceId: ProviderInstanceId.make("pi"),
        }).pipe(
          Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "pi-adapter-test-" })),
        );

        const threadId = ThreadId.make("11111111-1111-4111-8111-111111111111");
        const events: Array<{ type: string; payload?: unknown }> = [];

        const drain = yield* adapter.streamEvents.pipe(
          Stream.tap((event) => Effect.sync(() => events.push(event))),
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runDrain,
          Effect.forkScoped,
        );

        const session = yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        assert.equal(session.status, "ready");
        assert.equal(session.model, "anthropic/claude-haiku-4-5");

        yield* adapter.sendTurn({ threadId, input: "hi" });
        yield* Fiber.awaitAll([drain]).pipe(Effect.timeout("30 seconds"));

        const types = events.map((event) => event.type);
        assert.deepEqual(types.slice(0, 4), [
          "session.started",
          "session.configured",
          "thread.started",
          "session.state.changed",
        ]);

        // setStatus is a fire-and-forget notification: acknowledged, no warning.
        assert.notInclude(types, "runtime.warning");

        assert.include(types, "turn.started");
        assert.include(types, "turn.completed");

        const deltas = events.filter((event) => event.type === "content.delta");
        assert.deepEqual(
          deltas.map((event) => event.payload as { streamKind: string; delta: string }),
          [
            { streamKind: "reasoning_text", delta: "hmm" },
            { streamKind: "assistant_text", delta: "O" },
            { streamKind: "assistant_text", delta: "K" },
          ],
        );

        // The assistant item opens on the first delta, not on message_start.
        const assistantStart = events.findIndex(
          (event) =>
            event.type === "item.started" &&
            (event.payload as { itemType: string }).itemType === "assistant_message",
        );
        const firstDelta = events.findIndex((event) => event.type === "content.delta");
        assert.isAbove(assistantStart, -1);
        assert.isBelow(assistantStart, firstDelta + 1);

        const bash = events.filter(
          (event) =>
            (event.payload as { itemType?: string } | undefined)?.itemType === "command_execution",
        );
        assert.deepEqual(
          bash.map((event) => event.type),
          ["item.started", "item.completed"],
        );

        const completed = events.find((event) => event.type === "turn.completed");
        assert.deepEqual((completed?.payload as { state: string }).state, "completed");

        yield* adapter.stopAll();
      }),
    ),
  );

  it.effect("serializes turn submission with transcript mutation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* makePiAdapter(settings, {
          instanceId: ProviderInstanceId.make("pi"),
        }).pipe(
          Effect.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "pi-adapter-lock-test-" }),
          ),
        );
        const threadId = ThreadId.make("12121212-1212-4121-8121-121212121212");
        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });

        const order: string[] = [];
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const mutation = yield* adapter.piNative
          .withSessionLock(
            threadId,
            Effect.sync(() => order.push("mutation-start")).pipe(
              Effect.andThen(Deferred.succeed(entered, undefined)),
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(Effect.sync(() => order.push("mutation-end"))),
            ),
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        const turn = yield* adapter.sendTurn({ threadId, input: "after navigation" }).pipe(
          Effect.tap(() => Effect.sync(() => order.push("turn-sent"))),
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        assert.isUndefined(turn.pollUnsafe());

        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(mutation);
        yield* Fiber.join(turn);
        assert.deepEqual(order, ["mutation-start", "mutation-end", "turn-sent"]);
        yield* adapter.stopAll();
      }),
    ),
  );

  it.effect("adopts switched session model and thinking state before the next turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* makePiAdapter(settings, {
          instanceId: ProviderInstanceId.make("pi"),
          environment: {
            ...process.env,
            FAKE_PI_REJECT_REDUNDANT_SELECTION: "1",
            FAKE_PI_RESUME_TARGET: "switch-target",
          },
        }).pipe(
          Effect.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "pi-adapter-switch-test-" }),
          ),
        );
        const threadId = ThreadId.make("13131313-1313-4131-8131-131313131313");
        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        yield* adapter.piNative.listResumeSessions(threadId);

        const switched = yield* adapter.piNative.resumeSession({ threadId, sessionId: "opaque-1" });
        assert.equal(switched.sessionId, "fake-resume_session");
        assert.deepEqual(switched.model, { provider: "openai", id: "gpt-5" });
        assert.equal(switched.thinkingLevel, "high");
        const [session] = yield* adapter.listSessions();
        assert.equal(session?.threadId, threadId);
        assert.equal(session?.model, "openai/gpt-5");
        assert.equal(session?.status, "ready");
        assert.deepEqual(session?.resumeCursor, {
          schemaVersion: 1,
          sessionId: "fake-resume_session",
        });
        const state = yield* adapter.piNative.getSessionStateAndStats(threadId);
        assert.equal(state.state.thinkingLevel, "high");
        assert.equal(state.state.sessionName, "Switched session");

        yield* adapter.sendTurn({
          threadId,
          input: "after switch",
          modelSelection: {
            instanceId: ProviderInstanceId.make("pi"),
            model: "openai/gpt-5",
            options: [{ id: "effort", value: "high" }],
          },
        });
        yield* adapter.stopAll();
      }),
    ),
  );

  it.effect("rejects resuming a Pi session already open in another thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* makePiAdapter(settings, {
          instanceId: ProviderInstanceId.make("pi"),
          environment: { ...process.env, FAKE_PI_RESUME_TARGET: "owner-target" },
        }).pipe(
          Effect.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "pi-adapter-owner-test-" }),
          ),
        );
        const ownerThreadId = ThreadId.make("14141414-1414-4141-8141-141414141414");
        const otherThreadId = ThreadId.make("24242424-2424-4242-8242-242424242424");
        yield* adapter.startSession({
          threadId: ownerThreadId,
          runtimeMode: "full-access",
          resumeCursor: { schemaVersion: 1, sessionId: "owner-target" },
        });
        yield* adapter.startSession({ threadId: otherThreadId, runtimeMode: "full-access" });
        yield* adapter.piNative.listResumeSessions(otherThreadId);

        const error = yield* adapter.piNative
          .resumeSession({ threadId: otherThreadId, sessionId: "opaque-1" })
          .pipe(Effect.flip);
        assert.equal(error._tag, "ProviderAdapterValidationError");
        if (error._tag === "ProviderAdapterValidationError") {
          assert.include(error.issue, "already open in another thread");
        }
        yield* adapter.stopAll();
      }),
    ),
  );

  it.effect("rejects duplicate Pi session ownership across configured instances", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const configLayer = ServerConfig.layerTest(process.cwd(), {
          prefix: "pi-adapter-cross-instance-owner-test-",
        });
        const first = yield* makePiAdapter(settings, {
          instanceId: ProviderInstanceId.make("pi-one"),
        }).pipe(Effect.provide(configLayer));
        const second = yield* makePiAdapter(settings, {
          instanceId: ProviderInstanceId.make("pi-two"),
        }).pipe(Effect.provide(configLayer));
        const resumeCursor = { schemaVersion: 1, sessionId: "shared-session" };
        const secondThreadId = ThreadId.make("45454545-4545-4454-8454-454545454545");
        yield* first.startSession({
          threadId: ThreadId.make("34343434-3434-4343-8343-343434343434"),
          runtimeMode: "full-access",
          resumeCursor,
        });

        const error = yield* second
          .startSession({
            threadId: secondThreadId,
            runtimeMode: "full-access",
            resumeCursor,
          })
          .pipe(Effect.flip);
        assert.equal(error._tag, "ProviderAdapterValidationError");
        yield* first.stopAll();
        yield* second.startSession({
          threadId: secondThreadId,
          runtimeMode: "full-access",
          resumeCursor,
        });
        yield* second.stopAll();
      }),
    ),
  );

  (["malformed", "exit", "state"] as const).forEach((mode, index) => {
    it.effect(`closes the Pi process after an ambiguous ${mode} session switch`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const configLayer = ServerConfig.layerTest(process.cwd(), {
            prefix: `pi-adapter-switch-${mode}-test-`,
          });
          const exitMarker = NodePath.join(
            NodeOS.tmpdir(),
            `d4-pi-switch-${process.pid}-${mode}-closed`,
          );
          NodeFS.rmSync(exitMarker, { force: true });
          const first = yield* makePiAdapter(settings, {
            instanceId: ProviderInstanceId.make(`pi-${mode}-one`),
            environment: {
              ...process.env,
              FAKE_PI_EXIT_MARKER: exitMarker,
              FAKE_PI_SWITCH_FAILURE: mode,
            },
          }).pipe(Effect.provide(configLayer));
          const second = yield* makePiAdapter(settings, {
            instanceId: ProviderInstanceId.make(`pi-${mode}-two`),
          }).pipe(Effect.provide(configLayer));
          const threadId = ThreadId.make(`56565656-5656-4565-8565-56565656565${index}`);
          const initialSessionId = `ambiguous-${mode}`;
          yield* first.startSession({
            threadId,
            runtimeMode: "full-access",
            resumeCursor: { schemaVersion: 1, sessionId: initialSessionId },
          });

          const error = yield* first.piNative.cloneSession(threadId).pipe(Effect.flip);
          assert.equal(error._tag, "ProviderAdapterRequestError");
          assert.isFalse(yield* first.hasSession(threadId));
          assert.equal(NodeFS.readFileSync(exitMarker, "utf8"), "closed");
          NodeFS.rmSync(exitMarker, { force: true });

          yield* second.startSession({
            threadId: ThreadId.make(`67676767-6767-4676-8676-67676767676${index}`),
            runtimeMode: "full-access",
            resumeCursor: {
              schemaVersion: 1,
              sessionId: mode === "exit" ? initialSessionId : "fake-clone_session",
            },
          });
          yield* second.stopAll();
        }),
      ),
    );
  });

  it.effect("releases adoption-time Pi claims when the caller is interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const exitMarker = NodePath.join(
          NodeOS.tmpdir(),
          `d4-pi-switch-${process.pid}-interrupt-closed`,
        );
        NodeFS.rmSync(exitMarker, { force: true });
        const first = yield* makePiAdapter(settings, {
          instanceId: ProviderInstanceId.make("pi-interrupt-one"),
          environment: {
            ...process.env,
            FAKE_PI_EXIT_MARKER: exitMarker,
            FAKE_PI_RESUME_TARGET: "switch-target",
          },
        }).pipe(
          Effect.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "pi-adapter-switch-interrupt-test-" }),
          ),
        );
        const second = yield* makePiAdapter(settings, {
          instanceId: ProviderInstanceId.make("pi-interrupt-two"),
        }).pipe(
          Effect.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "pi-adapter-switch-interrupt-test-" }),
          ),
        );
        const firstThreadId = ThreadId.make("68686868-6868-4868-8868-686868686868");
        yield* first.startSession({ threadId: firstThreadId, runtimeMode: "full-access" });
        yield* first.piNative.listResumeSessions(firstThreadId);
        const clock = yield* Clock.Clock;
        const adoptionStarted = yield* Deferred.make<void>();
        const blockedClock = {
          ...clock,
          currentTimeMillis: Deferred.succeed(adoptionStarted, undefined).pipe(
            Effect.andThen(Effect.never),
          ),
        };
        const switching = yield* first.piNative
          .resumeSession({ threadId: firstThreadId, sessionId: "opaque-1" })
          .pipe(Effect.provideService(Clock.Clock, blockedClock), Effect.forkScoped);
        yield* Deferred.await(adoptionStarted);

        yield* Fiber.interrupt(switching);
        assert.isFalse(yield* first.hasSession(firstThreadId));
        assert.equal(NodeFS.readFileSync(exitMarker, "utf8"), "closed");
        yield* second.startSession({
          threadId: ThreadId.make("69696969-6969-4969-8969-696969696969"),
          runtimeMode: "full-access",
          resumeCursor: { schemaVersion: 1, sessionId: "fake-resume_session" },
        });
        yield* second.startSession({
          threadId: ThreadId.make("70707070-7070-4070-8070-707070707070"),
          runtimeMode: "full-access",
          resumeCursor: { schemaVersion: 1, sessionId: "switch-target" },
        });
        yield* second.stopAll();
        NodeFS.rmSync(exitMarker, { force: true });
      }),
    ),
  );

  it.effect("expires opaque resume handles when their Pi context closes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* makePiAdapter(settings, {
          instanceId: ProviderInstanceId.make("pi"),
        }).pipe(
          Effect.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "pi-adapter-resume-handle-test-" }),
          ),
        );
        const threadId = ThreadId.make("78787878-7878-4878-8878-787878787878");
        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        yield* adapter.piNative.listResumeSessions(threadId);
        yield* adapter.stopSession(threadId);
        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });

        const error = yield* adapter.piNative
          .resumeSession({ threadId, sessionId: "opaque-1" })
          .pipe(Effect.flip);
        assert.equal(error._tag, "ProviderAdapterValidationError");
        yield* adapter.stopAll();
      }),
    ),
  );

  it.effect("runs Pi authentication without returning the credential", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* makePiAdapter(settings, {
          instanceId: ProviderInstanceId.make("pi"),
        }).pipe(
          Effect.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "pi-adapter-auth-test-" }),
          ),
        );
        const threadId = ThreadId.make("15151515-1515-4151-8151-151515151515");
        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });

        const state = yield* adapter.piNative.getAuthState(threadId);
        assert.deepEqual(state.providers[0], {
          id: "anthropic",
          name: "Anthropic",
          methods: ["oauth", "api_key"],
          configured: false,
          storedCredential: false,
        });
        const flow = yield* adapter.piNative.beginAuthLogin({
          threadId,
          providerId: "anthropic",
          authType: "api_key",
        });
        assert.equal(flow.prompt?.type, "secret");
        const completed = yield* adapter.piNative.respondAuthFlow({
          threadId,
          flowId: flow.flowId,
          promptId: flow.prompt?.id ?? "",
          response: "test-secret-that-must-not-return",
        });
        assert.equal(completed.status, "succeeded");
        assert.notProperty(completed, "response");
        yield* adapter.piNative.logoutAuth({ threadId, providerId: "anthropic", confirmed: true });
        yield* adapter.stopAll();
      }),
    ),
  );

  it.effect("requires explicit confirmation before sharing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* makePiAdapter(settings, {
          instanceId: ProviderInstanceId.make("pi"),
        }).pipe(
          Effect.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "pi-adapter-share-test-" }),
          ),
        );

        const error = yield* adapter.piNative
          .shareSession({
            threadId: ThreadId.make("14141414-1414-4141-8141-141414141414"),
            confirmed: false,
          })
          .pipe(Effect.flip);

        assert.equal(error._tag, "ProviderAdapterValidationError");
      }),
    ),
  );

  it.effect("rejects an RPC runtime without native controls", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* makePiAdapter(settings, {
          instanceId: ProviderInstanceId.make("pi"),
          environment: { ...process.env, FAKE_PI_CAPABILITIES: "partial" },
        }).pipe(
          Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "pi-adapter-test-" })),
        );

        const error = yield* adapter
          .startSession({
            threadId: ThreadId.make("99999999-9999-4999-8999-999999999999"),
            runtimeMode: "full-access",
          })
          .pipe(Effect.flip);

        if (error._tag !== "ProviderAdapterRequestError") {
          return assert.fail(`Expected ProviderAdapterRequestError, received ${error._tag}`);
        }
        assert.equal(error.method, "get_capabilities");
        assert.include(error.detail, "missing capabilities");
      }),
    ),
  );

  it.effect("bounds the whole handshake and releases the ownership lock", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const capabilitiesMarker = NodePath.join(config.baseDir, "capabilities-phase");
        const stateMarker = NodePath.join(config.baseDir, "state-phase");
        const sigtermMarker = NodePath.join(config.baseDir, "handshake-sigterm");
        const pidMarker = NodePath.join(config.baseDir, "handshake-process-pid");
        const adapter = yield* makePiAdapter(settings, {
          instanceId: ProviderInstanceId.make("pi"),
          environment: {
            ...process.env,
            FAKE_PI_HOLD_CAPABILITIES_MARKER: capabilitiesMarker,
            FAKE_PI_HOLD_CAPABILITIES_SESSION_ID: "hung-session",
            FAKE_PI_HANG_STATE_SESSION_ID: "hung-session",
            FAKE_PI_STATE_MARKER: stateMarker,
            FAKE_PI_IGNORE_SIGTERM_SESSION_ID: "hung-session",
            FAKE_PI_SIGTERM_MARKER: sigtermMarker,
            FAKE_PI_PID_MARKER: pidMarker,
            FAKE_PI_EXIT_MARKER: NodePath.join(config.baseDir, "normal-process-exited"),
          },
          handshakeTimeout: "30 millis",
        });

        const firstStart = yield* adapter
          .startSession({
            threadId: ThreadId.make("97979797-9797-4797-8979-979797979797"),
            runtimeMode: "full-access",
            resumeCursor: { schemaVersion: 1, sessionId: "hung-session" },
          })
          .pipe(Effect.flip, Effect.forkScoped);
        yield* waitForFileContent(capabilitiesMarker, "waiting");
        yield* TestClock.adjust("20 millis");
        NodeFS.writeFileSync(capabilitiesMarker, "release");
        yield* waitForFileContent(stateMarker, "waiting");
        yield* TestClock.adjust("10 millis");
        yield* waitForFileContent(sigtermMarker, "received");
        const firstPid = Number(NodeFS.readFileSync(pidMarker, "utf8"));
        assert.doesNotThrow(() => process.kill(firstPid, 0));
        yield* TestClock.adjust("5 seconds");

        const firstError = yield* Fiber.join(firstStart);
        assert.equal(firstError._tag, "ProviderAdapterRequestError");
        assert.include(firstError.message, "Timed out");
        assert.throws(() => process.kill(firstPid, 0));

        const session = yield* adapter
          .startSession({
            threadId: ThreadId.make("96969696-9696-4696-8969-969696969696"),
            runtimeMode: "full-access",
          })
          .pipe(Effect.timeout("10 seconds"));
        assert.equal(session.status, "ready");
        yield* adapter.stopAll();
      }),
    ).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "pi-adapter-handshake-test-" }),
      ),
    ),
  );

  it.effect("allows prompt requests to run beyond the control timeout", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const promptMarker = NodePath.join(config.baseDir, "prompt-phase");
        const adapter = yield* makePiAdapter(settings, {
          instanceId: ProviderInstanceId.make("pi"),
          environment: { ...process.env, FAKE_PI_HOLD_PROMPT_MARKER: promptMarker },
        });
        const threadId = ThreadId.make("95959595-9595-4595-8959-959595959595");
        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });

        const prompt = yield* adapter
          .sendTurn({ threadId, input: "long prompt" })
          .pipe(Effect.forkScoped);
        yield* waitForFileContent(promptMarker, "waiting");
        yield* TestClock.adjust("61 seconds");
        NodeFS.writeFileSync(promptMarker, "release");

        const turn = yield* Fiber.join(prompt).pipe(Effect.timeout("10 seconds"));
        assert.equal(turn.threadId, threadId);
        yield* adapter.stopAll();
      }),
    ).pipe(
      Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "pi-adapter-prompt-test-" })),
    ),
  );

  it.effect("closes the RPC process when capability probing fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const exitMarker = NodePath.join(config.baseDir, "pi-exited");
        const adapter = yield* makePiAdapter(settings, {
          instanceId: ProviderInstanceId.make("pi"),
          environment: {
            ...process.env,
            FAKE_PI_CAPABILITIES: "error",
            FAKE_PI_EXIT_MARKER: exitMarker,
          },
        });

        const error = yield* adapter
          .startSession({
            threadId: ThreadId.make("98989898-9898-4898-8989-989898989898"),
            runtimeMode: "full-access",
          })
          .pipe(Effect.flip);

        assert.equal(error._tag, "ProviderAdapterRequestError");
        assert.include(error.message, "capability probe failed");
        assert.equal(NodeFS.readFileSync(exitMarker, "utf8"), "closed");
      }),
    ).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "pi-adapter-capability-error-test-" }),
      ),
    ),
  );

  it.effect("keeps the active turn id when steering before abort", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* makePiAdapter(settings, {
          instanceId: ProviderInstanceId.make("pi"),
        }).pipe(
          Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "pi-adapter-test-" })),
        );

        const threadId = ThreadId.make("22222222-2222-4222-8222-222222222222");
        const events: Array<{
          type: string;
          turnId?: string | undefined;
          payload?: unknown;
        }> = [];
        let steeredTurn: { readonly turnId: string } | undefined;

        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });

        const drain = yield* adapter.streamEvents.pipe(
          Stream.tap((event) => Effect.sync(() => events.push(event))),
          Stream.tap((event) =>
            event.type === "turn.started" && steeredTurn === undefined
              ? adapter.sendTurn({ threadId, input: "HOLD again" }).pipe(
                  Effect.tap((turn) =>
                    Effect.sync(() => {
                      steeredTurn = turn;
                    }),
                  ),
                  Effect.andThen(adapter.interruptTurn(threadId)),
                )
              : Effect.void,
          ),
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runDrain,
          Effect.forkScoped,
        );

        const firstTurn = yield* adapter.sendTurn({ threadId, input: "HOLD" });
        yield* Fiber.awaitAll([drain]).pipe(Effect.timeout("30 seconds"));

        assert.equal(steeredTurn?.turnId, firstTurn.turnId);
        const completed = events.find((event) => event.type === "turn.completed");
        assert.equal(completed?.turnId, firstTurn.turnId);
        assert.equal((completed?.payload as { state: string }).state, "interrupted");

        yield* adapter.stopAll();
      }),
    ),
  );

  it.effect("turns an extension select dialog into a user-input request", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* makePiAdapter(settings, {
          instanceId: ProviderInstanceId.make("pi"),
        }).pipe(
          Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "pi-adapter-test-" })),
        );

        const threadId = ThreadId.make("66666666-6666-4666-8666-666666666666");
        const events: Array<{ type: string; payload?: unknown }> = [];
        const REQUEST_ID = "ui-select";
        const ANSWER = "Block";

        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        // Answer from inside the stream: a Queue-backed stream has a single
        // consumer, and it.effect runs on a TestClock where sleeps never
        // advance, so reacting to the event is both correct and deterministic.
        const drain = yield* adapter.streamEvents.pipe(
          Stream.tap((event) => Effect.sync(() => events.push(event))),
          Stream.tap((event) =>
            event.type === "user-input.requested"
              ? adapter
                  .respondToUserInput(threadId, ApprovalRequestId.make(REQUEST_ID), {
                    [REQUEST_ID]: ANSWER,
                  })
                  .pipe(Effect.ignore)
              : Effect.void,
          ),
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runDrain,
          Effect.forkScoped,
        );

        yield* adapter.sendTurn({ threadId, input: "ASK" });
        yield* Fiber.awaitAll([drain]);

        const asked = events.find((event) => event.type === "user-input.requested");
        const question = (asked?.payload as { questions: Array<UserInputQuestion> } | undefined)
          ?.questions[0];
        assert.equal(question?.question, "Pick one");
        assert.deepEqual(
          question?.options.map((option) => option.label),
          ["Allow", "Block"],
        );

        const echoed = events
          .filter((event) => event.type === "content.delta")
          .map((event) => (event.payload as { delta: string }).delta)
          .join("");
        assert.include(echoed, '"value":"Block"');
        assert.include(
          events.map((event) => event.type),
          "user-input.resolved",
        );

        yield* adapter.stopAll();
      }),
    ),
  );

  it.effect("resolves pending extension input before an unexpected exit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const pidMarker = NodePath.join(config.baseDir, "unexpected-exit-pid");
        const adapter = yield* makePiAdapter(settings, {
          instanceId: ProviderInstanceId.make("pi"),
          environment: { ...process.env, FAKE_PI_PID_MARKER: pidMarker },
        });
        const threadId = ThreadId.make("65656565-6565-4565-8565-656565656565");
        const events: Array<{
          type: string;
          requestId?: string | undefined;
          payload?: unknown;
        }> = [];

        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        const pid = Number(NodeFS.readFileSync(pidMarker, "utf8"));
        const drain = yield* adapter.streamEvents.pipe(
          Stream.tap((event) => Effect.sync(() => events.push(event))),
          Stream.tap((event) =>
            event.type === "user-input.requested"
              ? Effect.sync(() => process.kill(pid, "SIGKILL"))
              : Effect.void,
          ),
          Stream.takeUntil((event) => event.type === "session.exited"),
          Stream.runDrain,
          Effect.forkScoped,
        );

        yield* adapter.sendTurn({ threadId, input: "ASK" });
        yield* Fiber.awaitAll([drain]).pipe(Effect.timeout("30 seconds"));

        const resolvedIndex = events.findIndex((event) => event.type === "user-input.resolved");
        const exitedIndex = events.findIndex((event) => event.type === "session.exited");
        assert.isAtLeast(resolvedIndex, 0);
        assert.isAbove(exitedIndex, resolvedIndex);
        assert.equal(events[resolvedIndex]?.requestId, "ui-select");
        assert.deepEqual(events[resolvedIndex]?.payload, { answers: {} });
        assert.isFalse(yield* adapter.hasSession(threadId));
      }),
    ).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "pi-adapter-unexpected-exit-test-" }),
      ),
    ),
  );

  it.effect("resolves pending extension input before a graceful stop", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* makePiAdapter(settings, {
          instanceId: ProviderInstanceId.make("pi"),
        }).pipe(
          Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "pi-adapter-test-" })),
        );
        const threadId = ThreadId.make("64646464-6464-4464-8464-646464646464");
        const events: Array<{
          type: string;
          requestId?: string | undefined;
          payload?: unknown;
        }> = [];

        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        const drain = yield* adapter.streamEvents.pipe(
          Stream.tap((event) => Effect.sync(() => events.push(event))),
          Stream.tap((event) =>
            event.type === "user-input.requested" ? adapter.stopSession(threadId) : Effect.void,
          ),
          Stream.takeUntil((event) => event.type === "session.exited"),
          Stream.runDrain,
          Effect.forkScoped,
        );

        yield* adapter.sendTurn({ threadId, input: "ASK" });
        yield* Fiber.awaitAll([drain]).pipe(Effect.timeout("30 seconds"));

        const resolvedIndex = events.findIndex((event) => event.type === "user-input.resolved");
        const exitedIndex = events.findIndex((event) => event.type === "session.exited");
        assert.isAtLeast(resolvedIndex, 0);
        assert.isAbove(exitedIndex, resolvedIndex);
        assert.equal(events[resolvedIndex]?.requestId, "ui-select");
        assert.deepEqual(events[resolvedIndex]?.payload, { answers: {} });
        assert.isFalse(yield* adapter.hasSession(threadId));
      }),
    ),
  );

  it.effect("maps a confirm dialog to a boolean answer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* makePiAdapter(settings, {
          instanceId: ProviderInstanceId.make("pi"),
        }).pipe(
          Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "pi-adapter-test-" })),
        );

        const threadId = ThreadId.make("77777777-7777-4777-8777-777777777777");
        const events: Array<{ type: string; payload?: unknown }> = [];
        const REQUEST_ID = "ui-confirm";
        const ANSWER = "Yes";

        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        const drain = yield* adapter.streamEvents.pipe(
          Stream.tap((event) => Effect.sync(() => events.push(event))),
          Stream.tap((event) =>
            event.type === "user-input.requested"
              ? adapter
                  .respondToUserInput(threadId, ApprovalRequestId.make(REQUEST_ID), {
                    [REQUEST_ID]: ANSWER,
                  })
                  .pipe(Effect.ignore)
              : Effect.void,
          ),
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runDrain,
          Effect.forkScoped,
        );

        yield* adapter.sendTurn({ threadId, input: "CONFIRM" });
        yield* Fiber.awaitAll([drain]);

        const echoed = events
          .filter((event) => event.type === "content.delta")
          .map((event) => (event.payload as { delta: string }).delta)
          .join("");
        assert.include(echoed, '"confirmed":true');

        yield* adapter.stopAll();
      }),
    ),
  );

  it.effect("turns an extension editor into a prefilled free-form request", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* makePiAdapter(settings, {
          instanceId: ProviderInstanceId.make("pi"),
        }).pipe(
          Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "pi-adapter-test-" })),
        );

        const threadId = ThreadId.make("88888888-8888-4888-8888-888888888888");
        const events: Array<{ type: string; payload?: unknown }> = [];
        const requestId = "ui-editor";

        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        const drain = yield* adapter.streamEvents.pipe(
          Stream.tap((event) => Effect.sync(() => events.push(event))),
          Stream.tap((event) =>
            event.type === "user-input.requested"
              ? adapter
                  .respondToUserInput(threadId, ApprovalRequestId.make(requestId), {
                    [requestId]: "edited text",
                  })
                  .pipe(Effect.ignore)
              : Effect.void,
          ),
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runDrain,
          Effect.forkScoped,
        );

        yield* adapter.sendTurn({ threadId, input: "EDITOR" });
        yield* Fiber.awaitAll([drain]);

        const asked = events.find((event) => event.type === "user-input.requested");
        const question = (asked?.payload as { questions: Array<UserInputQuestion> } | undefined)
          ?.questions[0];
        assert.equal(question?.defaultAnswer, "original text");
        assert.equal(question?.answerMode, "verbatim");
        assert.deepEqual(question?.options, []);
        const echoed = events
          .filter((event) => event.type === "content.delta")
          .map((event) => (event.payload as { delta: string }).delta)
          .join("");
        assert.include(echoed, '"value":"edited text"');

        yield* adapter.stopAll();
      }),
    ),
  );

  it.effect("rolls back a turn by forking the last user entry", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* makePiAdapter(settings, {
          instanceId: ProviderInstanceId.make("pi"),
        }).pipe(
          Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "pi-adapter-test-" })),
        );

        const threadId = ThreadId.make("33333333-3333-4333-8333-333333333333");
        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });

        const snapshot = yield* adapter.rollbackThread(threadId, 1);
        assert.equal(snapshot.threadId, threadId);
        assert.deepEqual(snapshot.turns[0]?.items, [{ role: "system", forkedFrom: "u2" }]);

        yield* adapter.stopAll();
      }),
    ),
  );

  it.effect("fails the rollback when an extension cancels the fork", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* makePiAdapter(settings, {
          instanceId: ProviderInstanceId.make("pi"),
        }).pipe(
          Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "pi-adapter-test-" })),
        );

        const threadId = ThreadId.make("44444444-4444-4444-8444-444444444444");
        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });

        // The fixture cancels forks from `u1`, which is two user turns back.
        const error = yield* adapter.rollbackThread(threadId, 2).pipe(Effect.flip);
        assert.include(String((error as { detail?: string }).detail), "cancelled the fork");

        yield* adapter.stopAll();
      }),
    ),
  );

  it.effect("rejects a rollback deeper than the branch's user turns", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* makePiAdapter(settings, {
          instanceId: ProviderInstanceId.make("pi"),
        }).pipe(
          Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "pi-adapter-test-" })),
        );

        const threadId = ThreadId.make("55555555-5555-4555-8555-555555555555");
        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });

        const error = yield* adapter.rollbackThread(threadId, 5).pipe(Effect.flip);
        assert.include(String((error as { issue?: string }).issue), "fewer than 5 user turn");

        yield* adapter.stopAll();
      }),
    ),
  );

  it.effect("routes Pi-native controls through the active thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* makePiAdapter(settings, {
          instanceId: ProviderInstanceId.make("pi"),
        }).pipe(
          Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "pi-adapter-test-" })),
        );
        const threadId = ThreadId.make("77777777-7777-4777-8777-777777777777");
        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });

        const tree = yield* adapter.piNative.getSessionTree(threadId);
        assert.equal(tree.leafId, "a2");
        assert.deepEqual(
          tree.entries.map((entry) => entry.id),
          ["u1", "a1", "u2", "a2", "u2-abandoned"],
        );
        assert.equal(tree.entries[0]?.editorText, "first prompt");
        assert.equal(tree.entries[1]?.label, "checkpoint");
        assert.deepEqual(tree.entries[1]?.childIds, ["u2", "u2-abandoned"]);

        assert.deepEqual(
          yield* adapter.piNative.navigateSessionTree({ threadId, targetId: "u2" }),
          {
            editorText: "second prompt",
            cancelled: false,
            leafId: "u2",
          },
        );
        assert.deepEqual(
          yield* adapter.piNative.navigateSessionTree({ threadId, targetId: "cancel" }),
          {
            cancelled: true,
            leafId: "a2",
          },
        );
        assert.deepEqual(
          yield* adapter.piNative.navigateSessionTree({ threadId, targetId: "abort" }),
          {
            cancelled: false,
            aborted: true,
            leafId: "a2",
          },
        );
        const stale = yield* adapter.piNative
          .navigateSessionTree({ threadId, targetId: "stale" })
          .pipe(Effect.flip);
        assert.equal(stale._tag, "ProviderAdapterRequestError");
        assert.include(stale.message, "Entry not found: stale");

        yield* adapter.piNative.abortBranchSummary(threadId);
        yield* adapter.piNative.setEntryLabel({ threadId, targetId: "u2", label: "keep" });
        yield* adapter.piNative.setEntryLabel({ threadId, targetId: "u2" });
        yield* adapter.piNative.reloadResources(threadId);
        assert.equal((yield* adapter.piNative.compactSession({ threadId })).summary, "compacted");
        assert.equal(
          (yield* adapter.piNative.getSessionStateAndStats(threadId)).stats.totalMessages,
          6,
        );
        yield* adapter.piNative.setSessionName({ threadId, name: "Renamed" });
        assert.equal(
          (yield* adapter.piNative.getLastAssistantText(threadId)).text,
          "second answer",
        );
        const exportPath = (yield* adapter.piNative.exportSessionHtml({ threadId })).canonicalPath;
        assert.match(
          exportPath,
          /[\\/]d4-export-[^\\/]+[\\/]77777777-7777-4777-8777-777777777777\.html$/,
        );
        assert.isTrue(NodeFS.existsSync(exportPath));
        NodeFS.rmSync(NodePath.dirname(exportPath), { recursive: true });

        yield* adapter.stopAll();
      }),
    ),
  );

  it.effect("does not follow a preexisting exports symlink", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const outsideDir = NodePath.join(config.baseDir, "outside-exports");
        NodeFS.mkdirSync(outsideDir);
        NodeFS.writeFileSync(NodePath.join(outsideDir, "sentinel"), "untouched");
        NodeFS.symlinkSync(outsideDir, NodePath.join(config.stateDir, "exports"), "dir");

        const adapter = yield* makePiAdapter(settings, {
          instanceId: ProviderInstanceId.make("pi"),
        });
        const threadId = ThreadId.make("79797979-7979-4797-8797-797979797979");
        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });

        const exportPath = (yield* adapter.piNative.exportSessionHtml({ threadId })).canonicalPath;
        assert.notEqual(
          NodePath.dirname(NodePath.dirname(exportPath)),
          NodeFS.realpathSync(config.stateDir),
        );
        assert.match(NodePath.basename(NodePath.dirname(exportPath)), /^d4-export-/);
        assert.notInclude(exportPath, `${NodePath.sep}exports${NodePath.sep}`);
        assert.deepEqual(NodeFS.readdirSync(outsideDir), ["sentinel"]);
        assert.equal(
          NodeFS.readFileSync(NodePath.join(outsideDir, "sentinel"), "utf8"),
          "untouched",
        );
        assert.isTrue(NodeFS.existsSync(exportPath));
        NodeFS.rmSync(NodePath.dirname(exportPath), { recursive: true });

        yield* adapter.stopAll();
      }),
    ).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "pi-adapter-export-symlink-test-" }),
      ),
    ),
  );

  it.effect("rejects and cleans up a missing Pi HTML export", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const adapter = yield* makePiAdapter(settings, {
          instanceId: ProviderInstanceId.make("pi"),
          environment: { ...process.env, FAKE_PI_EXPORT_MODE: "missing" },
        });
        const threadId = ThreadId.make("71717171-7171-4717-8717-717171717171");
        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });

        const error = yield* adapter.piNative.exportSessionHtml({ threadId }).pipe(Effect.flip);
        assert.equal(error._tag, "ProviderAdapterRequestError");
        assert.include(error.message, "did not create");
        assert.isFalse(
          NodeFS.readdirSync(config.stateDir).some((entry) => entry.startsWith("d4-export-")),
        );

        yield* adapter.stopAll();
      }),
    ).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "pi-adapter-export-missing-test-" }),
      ),
    ),
  );

  it.effect("rejects and cleans up symlink, directory, and empty Pi HTML exports", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const modes = ["symlink", "directory", "empty"] as const;
        for (const [index, mode] of modes.entries()) {
          const adapter = yield* makePiAdapter(settings, {
            instanceId: ProviderInstanceId.make("pi"),
            environment: { ...process.env, FAKE_PI_EXPORT_MODE: mode },
          });
          const threadId = ThreadId.make(`72727272-7272-4727-8727-72717171717${index}`);
          yield* adapter.startSession({ threadId, runtimeMode: "full-access" });

          const error = yield* adapter.piNative.exportSessionHtml({ threadId }).pipe(Effect.flip);
          assert.equal(error._tag, "ProviderAdapterRequestError");
          assert.include(error.message, "invalid export file");
          assert.isFalse(
            NodeFS.readdirSync(config.stateDir).some((entry) => entry.startsWith("d4-export-")),
          );

          yield* adapter.stopAll();
        }
      }),
    ).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "pi-adapter-export-invalid-test-" }),
      ),
    ),
  );

  it.effect("rejects reload and navigation while Pi is busy", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* makePiAdapter(settings, {
          instanceId: ProviderInstanceId.make("pi"),
          environment: { ...process.env, FAKE_PI_BUSY: "streaming" },
        }).pipe(
          Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "pi-adapter-test-" })),
        );
        const threadId = ThreadId.make("88888888-8888-4888-8888-888888888888");
        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });

        const reloadError = yield* adapter.piNative.reloadResources(threadId).pipe(Effect.flip);
        assert.equal(reloadError._tag, "ProviderAdapterValidationError");
        assert.include(reloadError.message, "current response");
        const navigationError = yield* adapter.piNative
          .navigateSessionTree({ threadId, targetId: "u2" })
          .pipe(Effect.flip);
        assert.equal(navigationError._tag, "ProviderAdapterValidationError");
        assert.include(navigationError.message, "before navigating");

        yield* adapter.stopAll();
      }),
    ),
  );
});

it("parses only GitHub gist URLs for shared sessions", () => {
  assert.deepEqual(parseGitHubGistShareUrl("https://gist.github.com/user/abc123"), {
    url: "https://pi.dev/session/#abc123",
    gistUrl: "https://gist.github.com/user/abc123",
  });
  assert.isUndefined(parseGitHubGistShareUrl("javascript:alert(1)"));
  assert.isUndefined(parseGitHubGistShareUrl("https://example.com/user/abc123"));
});

it("parsePiSessionTree hides non-displayed custom message content", () => {
  const tree = parsePiSessionTree({
    tree: [
      {
        entry: {
          type: "custom_message",
          id: "hidden",
          parentId: null,
          timestamp: "2026-01-01T00:00:00.000Z",
          customType: "extension-state",
          display: false,
          content: "secret",
        },
        children: [],
      },
    ],
    leafId: "hidden",
  });
  assert.equal(tree.entries[0]?.preview, "extension-state");
  assert.notProperty(tree.entries[0] ?? {}, "editorText");
  assert.notInclude(JSON.stringify(tree), "secret");
});

it("parsePiSessionTree rejects raw malformed entries", () => {
  assert.throws(() => parsePiSessionTree({ tree: [{ entry: { id: "bad" }, children: [] }] }));
});

it("parsePiSessionTree handles deeply nested sessions without recursion", () => {
  const depth = 12_000;
  let node: Record<string, unknown> | undefined;
  for (let index = depth - 1; index >= 0; index -= 1) {
    node = {
      entry: {
        type: "message",
        id: `entry-${index}`,
        parentId: index === 0 ? null : `entry-${index - 1}`,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: `message-${index}` },
      },
      children: node ? [node] : [],
    };
  }

  const tree = parsePiSessionTree({ tree: node ? [node] : [], leafId: `entry-${depth - 1}` });
  assert.equal(tree.entries.length, depth);
  assert.deepEqual(tree.entries[0]?.childIds, ["entry-1"]);
  assert.equal(tree.entries[depth - 1]?.id, `entry-${depth - 1}`);
});

it("nthLastUserEntryOnActiveBranch walks the active branch only", () => {
  const entries = [
    { type: "message", id: "u1", parentId: null, message: { role: "user" } },
    { type: "message", id: "a1", parentId: "u1", message: { role: "assistant" } },
    { type: "message", id: "u2", parentId: "a1", message: { role: "user" } },
    { type: "message", id: "a2", parentId: "u2", message: { role: "assistant" } },
    // Abandoned sibling branch: newer id, but not reachable from the leaf.
    { type: "message", id: "u-abandoned", parentId: "a1", message: { role: "user" } },
  ];

  assert.equal(nthLastUserEntryOnActiveBranch(entries, "a2", 1), "u2");
  assert.equal(nthLastUserEntryOnActiveBranch(entries, "a2", 2), "u1");
  assert.isUndefined(nthLastUserEntryOnActiveBranch(entries, "a2", 3));
  assert.isUndefined(nthLastUserEntryOnActiveBranch(entries, undefined, 1));
  assert.isUndefined(nthLastUserEntryOnActiveBranch(entries, "a2", 0));
});

it("nthLastUserEntryOnActiveBranch survives a malformed parent cycle", () => {
  const entries = [
    { type: "message", id: "x", parentId: "y", message: { role: "user" } },
    { type: "message", id: "y", parentId: "x", message: { role: "assistant" } },
  ];

  assert.equal(nthLastUserEntryOnActiveBranch(entries, "x", 1), "x");
  assert.isUndefined(nthLastUserEntryOnActiveBranch(entries, "x", 2));
});
