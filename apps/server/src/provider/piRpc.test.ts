import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { PiRpcError, spawnPiRpc } from "./piRpc.ts";

/**
 * Stand-in for `pi --mode rpc`: reads JSONL commands from stdin and answers
 * on stdout. `split` deliberately writes its response across two chunks so
 * the client's LF re-framing is exercised.
 */
const FAKE_PI_SCRIPT = `
process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const cmd = JSON.parse(line);
    if (cmd.type === "ping") {
      process.stdout.write(JSON.stringify({ type: "response", id: cmd.id, command: "ping", success: true, data: { pong: true } }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");
    } else if (cmd.type === "boom") {
      process.stdout.write(JSON.stringify({ type: "response", id: cmd.id, command: "boom", success: false, error: "kaboom" }) + "\\n");
    } else if (cmd.type === "split") {
      const payload = JSON.stringify({ type: "response", id: cmd.id, command: "split", success: true, data: { whole: true } }) + "\\n";
      process.stdout.write(payload.slice(0, 5));
      setTimeout(() => process.stdout.write(payload.slice(5)), 30);
    } else if (cmd.type === "die") {
      process.exit(3);
    }
  }
});
`;

const spawnFakePi = spawnPiRpc({
  binaryPath: process.execPath,
  args: ["-e", FAKE_PI_SCRIPT],
  cwd: process.cwd(),
});

const layer = NodeServices.layer;

it.layer(layer)("piRpc", (it) => {
  it.effect("correlates responses by id and routes events separately", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const rpc = yield* spawnFakePi;
        const response = yield* rpc.request({ type: "ping" }).pipe(Effect.timeout("10 seconds"));
        assert.deepEqual(response.data, { pong: true });

        const event = yield* rpc.events.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.timeout("10 seconds"),
        );
        assert.deepEqual(event, [{ type: "agent_start" }]);
      }),
    ),
  );

  it.effect("reassembles responses split across stdout chunks", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const rpc = yield* spawnFakePi;
        const response = yield* rpc.request({ type: "split" }).pipe(Effect.timeout("10 seconds"));
        assert.deepEqual(response.data, { whole: true });
      }),
    ),
  );

  it.effect("fails the request when pi reports success: false", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const rpc = yield* spawnFakePi;
        const result = yield* rpc
          .request({ type: "boom" })
          .pipe(Effect.flip, Effect.timeout("10 seconds"));
        assert.instanceOf(result, PiRpcError);
        assert.equal(result.detail, "kaboom");
      }),
    ),
  );

  it.effect("fails pending requests when the process exits", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const rpc = yield* spawnFakePi;
        // No response will ever arrive for this one; the `die` command
        // terminates the fake before it answers.
        const pending = yield* rpc.request({ type: "never-answered" }).pipe(Effect.forkScoped);
        yield* rpc.send({ type: "die" });
        const exitCode = yield* rpc.awaitExit.pipe(Effect.timeout("10 seconds"));
        assert.equal(exitCode, 3);
        const result = yield* Fiber.awaitAll([pending]).pipe(Effect.timeout("10 seconds"));
        assert.equal(result[0]?._tag, "Failure");
      }),
    ),
  );
});
