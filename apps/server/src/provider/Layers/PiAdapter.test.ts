import { PiSettings, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as ServerConfig from "../../config.ts";
import { makePiAdapter } from "./PiAdapter.ts";

/**
 * A scripted stand-in for the pi binary. It answers the handshake commands
 * the adapter issues on `startSession`, then replays a fixed turn when
 * prompted — including a record the adapter cannot translate, so the pump's
 * per-record isolation is covered too.
 *
 * Writing a real executable (rather than reusing `spawnPiRpc` directly) is
 * what lets this exercise `makePiAdapter` end to end: the adapter owns its
 * own spawn, and `binaryPath` is the only injection point.
 */
const FAKE_PI = `#!/usr/bin/env node
process.stdin.setEncoding("utf8");
const w = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const cmd = JSON.parse(line);
    switch (cmd.type) {
      case "get_state":
        w({ type: "response", id: cmd.id, command: "get_state", success: true,
            data: { sessionId: "fake-session", thinkingLevel: "medium",
                    model: { provider: "anthropic", id: "claude-haiku-4-5" } } });
        break;
      case "set_model":
      case "set_thinking_level":
        w({ type: "response", id: cmd.id, command: cmd.type, success: true });
        break;
      case "prompt":
        w({ type: "response", id: cmd.id, command: "prompt", success: true });
        w({ type: "extension_ui_request", id: "ui-1", method: "setStatus", statusKey: "noise" });
        w({ type: "agent_start" });
        // "HOLD" keeps the turn open so an abort is the only thing that can
        // settle it, making the interrupt assertion race-free.
        if (String(cmd.message).includes("HOLD")) break;
        w({ type: "message_start", message: { role: "assistant" } });
        w({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "hmm" } });
        w({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "O" } });
        w({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "K" } });
        w({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "OK" }] } });
        w({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "ls" } });
        w({ type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", result: "file.txt" });
        w({ type: "agent_settled" });
        break;
      case "abort":
        w({ type: "response", id: cmd.id, command: "abort", success: true });
        w({ type: "agent_settled" });
        break;
      default:
        w({ type: "response", id: cmd.id, command: cmd.type, success: true, data: {} });
    }
  }
});
`;

const fakePiPath = (() => {
  const dir = mkdtempSync(join(tmpdir(), "pi-adapter-test-"));
  const path = join(dir, "fake-pi");
  writeFileSync(path, FAKE_PI);
  chmodSync(path, 0o755);
  return path;
})();

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
