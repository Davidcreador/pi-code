import { EnvironmentId, PI_NATIVE_WS_METHODS, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import * as piNative from "./piNative.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

describe("Pi-native operations", () => {
  it.effect("forwards every typed operation through its existing RPC method", () =>
    Effect.gen(function* () {
      const calls: Array<[string, unknown]> = [];
      const client = Object.fromEntries(
        Object.values(PI_NATIVE_WS_METHODS).map((method) => [
          method,
          (input: unknown) =>
            Effect.sync(() => {
              calls.push([method, input]);
              return method === PI_NATIVE_WS_METHODS.getLastAssistantText
                ? { text: "answer" }
                : undefined;
            }),
        ]),
      ) as unknown as WsRpcProtocolClient;
      const session: RpcSession = {
        client,
        initialConfig: Effect.never,
        ready: Effect.void,
        probe: Effect.void,
        closed: Effect.never,
      };
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.some(session)),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      });
      const threadId = ThreadId.make("thread-1");
      const run = <A, E>(
        effect: Effect.Effect<A, E, EnvironmentSupervisor.EnvironmentSupervisor>,
      ) =>
        effect.pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      yield* run(piNative.getTree({ threadId }));
      yield* run(piNative.navigateTree({ threadId, targetId: "entry-1" }));
      yield* run(piNative.abortBranchSummary({ threadId }));
      yield* run(piNative.setEntryLabel({ threadId, targetId: "entry-1", label: "mark" }));
      yield* run(piNative.reload({ threadId }));
      yield* run(piNative.compact({ threadId }));
      yield* run(piNative.getStateAndStats({ threadId }));
      yield* run(piNative.setSessionName({ threadId, name: "Session" }));
      yield* run(piNative.getLastAssistantText({ threadId }));
      yield* run(piNative.exportHtml({ threadId }));
      yield* run(piNative.getSettings({ threadId, scope: "global" }));
      yield* run(
        piNative.updateSettings({ threadId, scope: "project", values: { quietStartup: true } }),
      );
      yield* run(piNative.getScopedModels({ threadId, scope: "global" }));
      yield* run(
        piNative.updateScopedModels({ threadId, scope: "project", patterns: ["anthropic/*"] }),
      );
      yield* run(piNative.listResumeSessions({ threadId }));
      yield* run(piNative.resume({ threadId, sessionId: "opaque" }));
      yield* run(piNative.importSession({ threadId, filename: "upload.jsonl", content: "{}\n" }));
      yield* run(piNative.fork({ threadId, targetId: "entry-1" }));
      yield* run(piNative.clone({ threadId }));
      yield* run(piNative.getTrust({ threadId }));
      yield* run(piNative.setTrust({ threadId, trusted: true, confirmed: true }));
      yield* run(piNative.getChangelog({ threadId }));
      yield* run(piNative.getAuthState({ threadId }));
      yield* run(piNative.beginAuthLogin({ threadId, providerId: "anthropic", authType: "oauth" }));
      yield* run(piNative.getAuthFlow({ threadId, flowId: "flow-1" }));
      yield* run(
        piNative.respondAuthFlow({
          threadId,
          flowId: "flow-1",
          promptId: "prompt-1",
          response: "secret",
        }),
      );
      yield* run(piNative.cancelAuthFlow({ threadId, flowId: "flow-1" }));
      yield* run(piNative.logout({ threadId, providerId: "anthropic", confirmed: true }));
      yield* run(piNative.share({ threadId, confirmed: true }));

      expect(calls.map(([method]) => method)).toEqual(Object.values(PI_NATIVE_WS_METHODS));
      expect(calls[1]?.[1]).toEqual({ threadId: "thread-1", targetId: "entry-1" });
    }),
  );
});
