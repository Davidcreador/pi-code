import { PiSettings, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as ServerConfig from "../../config.ts";
import { makePiAdapter } from "./PiAdapter.ts";

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
});
