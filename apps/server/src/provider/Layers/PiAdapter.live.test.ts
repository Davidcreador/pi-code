import { PiSettings, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as ServerConfig from "../../config.ts";
import { makePiAdapter } from "./PiAdapter.ts";

/**
 * Live integration test: spawns a real `pi --mode rpc`, runs one prompt on a
 * cheap model, and asserts the runtime-event translation end to end.
 *
 * Costs real tokens and needs pi installed with provider credentials, so it
 * only runs when explicitly requested:
 *
 *   PI_E2E=1 vp test run apps/server/src/provider/Layers/PiAdapter.live.test.ts
 */
const decodePiSettings = Schema.decodeSync(PiSettings);

it.live.skipIf(!process.env.PI_E2E)(
  "PiAdapter runs one turn end-to-end against a real pi process",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* makePiAdapter(decodePiSettings({}), {
          instanceId: ProviderInstanceId.make("pi"),
        }).pipe(
          Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "pi-adapter-live-" })),
        );

        const uuid = yield* (yield* Crypto.Crypto).randomUUIDv4;
        const threadId = ThreadId.make(`pi-live-${uuid}`);
        const seen: Array<string> = [];

        const drain = yield* adapter.streamEvents.pipe(
          Stream.tap((event) => Effect.sync(() => seen.push(event.type))),
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runDrain,
          Effect.forkScoped,
        );

        const session = yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: {
            instanceId: ProviderInstanceId.make("pi"),
            model: process.env.PI_E2E_MODEL ?? "anthropic/claude-haiku-4-5",
          },
        });
        assert.equal(session.status, "ready");
        assert.equal(session.model, process.env.PI_E2E_MODEL ?? "anthropic/claude-haiku-4-5");

        const turn = yield* adapter.sendTurn({
          threadId,
          input: "Reply with exactly: OK",
        });
        assert.equal(turn.threadId, threadId);

        yield* Fiber.awaitAll([drain]).pipe(Effect.timeout("120 seconds"));

        assert.include(seen, "session.started");
        assert.include(seen, "thread.started");
        assert.include(seen, "turn.started");
        assert.include(seen, "content.delta");
        assert.include(seen, "item.started");
        assert.include(seen, "item.completed");
        assert.include(seen, "turn.completed");

        yield* adapter.stopAll();
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 180_000 },
);
