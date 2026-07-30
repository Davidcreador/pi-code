import {
  ApprovalRequestId,
  PiSettings,
  ProviderInstanceId,
  ThreadId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as ServerConfig from "../../config.ts";
import { makePiAdapter, nthLastUserEntryOnActiveBranch } from "./PiAdapter.ts";

// Scripted stand-in for the pi binary. Spawning a real executable is what
// lets this exercise `makePiAdapter` end to end: the adapter owns its own
// spawn, so `binaryPath` is the only injection point.
const fakePiPath = `${import.meta.dirname}/fixtures/fake-pi`;

const decodePiSettings = Schema.decodeSync(PiSettings);
const settings = decodePiSettings({ binaryPath: fakePiPath });

const layer = NodeServices.layer;

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

  it.effect("reports an interrupted turn after abort", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* makePiAdapter(settings, {
          instanceId: ProviderInstanceId.make("pi"),
        }).pipe(
          Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "pi-adapter-test-" })),
        );

        const threadId = ThreadId.make("22222222-2222-4222-8222-222222222222");
        const events: Array<{ type: string; payload?: unknown }> = [];

        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });

        const drain = yield* adapter.streamEvents.pipe(
          Stream.tap((event) => Effect.sync(() => events.push(event))),
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runDrain,
          Effect.forkScoped,
        );

        yield* adapter.sendTurn({ threadId, input: "HOLD" });
        yield* adapter.interruptTurn(threadId);
        yield* Fiber.awaitAll([drain]).pipe(Effect.timeout("30 seconds"));

        const completed = events.find((event) => event.type === "turn.completed");
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

  it.effect("cancels dialogs it cannot render", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* makePiAdapter(settings, {
          instanceId: ProviderInstanceId.make("pi"),
        }).pipe(
          Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "pi-adapter-test-" })),
        );

        const threadId = ThreadId.make("88888888-8888-4888-8888-888888888888");
        const events: Array<{ type: string; payload?: unknown }> = [];

        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        const drain = yield* adapter.streamEvents.pipe(
          Stream.tap((event) => Effect.sync(() => events.push(event))),
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runDrain,
          Effect.forkScoped,
        );

        // `editor` wants free-form text, which the user-input contract cannot
        // express; the adapter cancels it, which the fixture answers by
        // closing the turn.
        yield* adapter.sendTurn({ threadId, input: "EDITOR" });
        yield* Fiber.awaitAll([drain]);

        const warning = events.find((event) => event.type === "runtime.warning");
        assert.include(String((warning?.payload as { message: string }).message), "'editor'");
        assert.notInclude(
          events.map((event) => event.type),
          "user-input.requested",
        );

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
