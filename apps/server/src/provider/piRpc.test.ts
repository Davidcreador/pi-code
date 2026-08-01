import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { PiRpcError, spawnPiRpc } from "./piRpc.ts";

/**
 * Stand-in for `pi --mode rpc`: reads JSONL commands from stdin and answers
 * on stdout. `split` deliberately writes its response across two chunks so
 * the client's LF re-framing is exercised.
 */
const FAKE_PI_SCRIPT = `
process.stdin.setEncoding("utf8");
if (process.env.HOLD_TERMINATION === "1") {
  process.on("SIGTERM", () => {
    process.stdout.write(JSON.stringify({ type: "termination_started" }) + "\\n");
  });
}
let buf = "";
let heldResponse;
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const cmd = JSON.parse(line);
    if (cmd.type === "ready") {
      process.stdout.write(JSON.stringify({ type: "response", id: cmd.id, command: "ready", success: true, data: {} }) + "\\n");
    } else if (cmd.type === "ping") {
      process.stdout.write(JSON.stringify({ type: "response", id: cmd.id, command: "ping", success: true, data: { pong: true } }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");
    } else if (cmd.type === "boom") {
      process.stdout.write(JSON.stringify({ type: "response", id: cmd.id, command: "boom", success: false, error: "kaboom" }) + "\\n");
    } else if (cmd.type === "hold_response") {
      heldResponse = cmd;
    } else if (cmd.type === "release_response" && heldResponse) {
      process.stdout.write(JSON.stringify({ type: "response", id: heldResponse.id, command: heldResponse.type, success: true, data: {} }) + "\\n");
      heldResponse = undefined;
    } else if (cmd.type === "split") {
      const payload = JSON.stringify({ type: "response", id: cmd.id, command: "split", success: true, data: { whole: true } }) + "\\n";
      process.stdout.write(payload.slice(0, 5));
      setTimeout(() => process.stdout.write(payload.slice(5)), 30);
    } else if (cmd.type === "die") {
      process.exit(3);
    } else if (cmd.type === "close_stdin") {
      process.stdout.write(JSON.stringify({ type: "stdin_closed" }) + "\\n");
      require("node:fs").closeSync(0);
      setInterval(() => {}, 1000);
    } else if (cmd.type === "release_termination") {
      process.exit(0);
    }
  }
});
`;

const spawnFakePi = spawnPiRpc({
  binaryPath: process.execPath,
  args: ["-e", FAKE_PI_SCRIPT],
  cwd: process.cwd(),
});

const spawnHeldFakePi = spawnPiRpc({
  binaryPath: process.execPath,
  args: ["-e", FAKE_PI_SCRIPT],
  cwd: process.cwd(),
  environment: { ...process.env, HOLD_TERMINATION: "1" },
});

const spawnStubbornFakePi = spawnPiRpc({
  binaryPath: process.execPath,
  args: ["-e", FAKE_PI_SCRIPT],
  cwd: process.cwd(),
  environment: { ...process.env, HOLD_TERMINATION: "1" },
  terminateGrace: "50 millis",
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

  it.effect("times out an unanswered request without poisoning later requests", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const rpc = yield* spawnFakePi;
        const timeout = yield* rpc
          .request({ type: "hold_response" }, { timeout: "20 millis" })
          .pipe(Effect.flip, Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("20 millis");
        const error = yield* Fiber.join(timeout);
        assert.instanceOf(error, PiRpcError);
        assert.equal(error.operation, "hold_response");
        assert.include(error.detail, "timed out");

        yield* rpc.send({ type: "release_response" });
        const response = yield* rpc.request({ type: "ping" }).pipe(Effect.timeout("10 seconds"));
        assert.deepEqual(response.data, { pong: true });
        const event = yield* rpc.events.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.timeout("10 seconds"),
        );
        assert.deepEqual(event, [{ type: "agent_start" }]);
        yield* rpc.terminate.pipe(Effect.timeout("10 seconds"));
      }),
    ),
  );

  it.effect("allows an intentionally long request to disable its timeout", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const rpc = yield* spawnFakePi;
        const request = yield* rpc
          .request({ type: "hold_response" }, { timeout: null })
          .pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("61 seconds");
        yield* rpc.send({ type: "release_response" });
        const response = yield* Fiber.join(request).pipe(Effect.timeout("10 seconds"));
        assert.equal(response.command, "hold_response");
        yield* rpc.terminate.pipe(Effect.timeout("10 seconds"));
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

  it.effect("finalizes pending requests before termination returns", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const rpc = yield* spawnFakePi;
        const pending = yield* rpc.request({ type: "never-answered" }).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;

        yield* rpc.terminate.pipe(Effect.timeout("10 seconds"));
        const result = yield* Fiber.awaitAll([pending]).pipe(Effect.timeout("10 seconds"));
        assert.equal(result[0]?._tag, "Failure");
        yield* rpc.terminate.pipe(Effect.timeout("10 seconds"));
      }),
    ),
  );

  it.effect("escalates termination when pi ignores SIGTERM", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const rpc = yield* spawnStubbornFakePi;
        yield* rpc.request({ type: "ready" }).pipe(Effect.timeout("10 seconds"));
        const termination = yield* rpc.terminate.pipe(Effect.forkScoped);
        const started = yield* rpc.events.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.timeout("10 seconds"),
        );
        assert.deepEqual(started, [{ type: "termination_started" }]);
        yield* TestClock.adjust("50 millis");
        yield* Fiber.join(termination);
        yield* rpc.awaitExit.pipe(Effect.timeout("10 seconds"));
      }),
    ),
  );

  it.effect("finishes exit cleanup across interrupted and concurrent termination", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const rpc = yield* spawnHeldFakePi;
        yield* rpc.request({ type: "ready" }).pipe(Effect.timeout("10 seconds"));
        const pending = yield* rpc.request({ type: "never-answered" }).pipe(Effect.forkScoped);
        const firstTermination = yield* rpc.terminate.pipe(Effect.forkScoped);
        const started = yield* rpc.events.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.timeout("10 seconds"),
        );
        assert.deepEqual(started, [{ type: "termination_started" }]);
        yield* Fiber.interrupt(firstTermination);

        const secondTermination = yield* rpc.terminate.pipe(Effect.forkScoped);
        const thirdTermination = yield* rpc.terminate.pipe(Effect.forkScoped);
        yield* rpc.send({ type: "release_termination" });
        const terminations = yield* Fiber.awaitAll([secondTermination, thirdTermination]).pipe(
          Effect.timeout("10 seconds"),
        );
        assert.equal(terminations[0]?._tag, "Success");
        assert.equal(terminations[1]?._tag, "Success");
        const result = yield* Fiber.awaitAll([pending]).pipe(Effect.timeout("10 seconds"));
        assert.equal(result[0]?._tag, "Failure");
      }),
    ),
  );

  it.effect("fails pending and new requests after the child closes stdin", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const rpc = yield* spawnFakePi;
        const pending = yield* rpc
          .request({ type: "hold_response" })
          .pipe(Effect.flip, Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* rpc.send({ type: "close_stdin" });
        const closed = yield* rpc.events.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.timeout("10 seconds"),
        );
        assert.deepEqual(closed, [{ type: "stdin_closed" }]);

        yield* rpc.send({ type: "probe_closed_stdin" });
        yield* TestClock.adjust("50 millis");
        yield* Effect.yieldNow;

        const pendingError = yield* Fiber.join(pending);
        assert.instanceOf(pendingError, PiRpcError);
        assert.include(pendingError.detail, "stdin transport closed");

        const newError = yield* rpc.request({ type: "after_stdin_closed" }).pipe(Effect.flip);
        assert.instanceOf(newError, PiRpcError);
        assert.equal(newError.operation, "after_stdin_closed");
        assert.include(newError.detail, "stdin transport closed");
        yield* rpc.terminate.pipe(Effect.timeout("10 seconds"));
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
