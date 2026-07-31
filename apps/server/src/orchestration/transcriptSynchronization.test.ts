import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationEvent,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";
const later = "2026-01-01T00:01:00.000Z";

const seed = projectEvent(createEmptyReadModel(now), {
  sequence: 1,
  eventId: EventId.make("event-thread"),
  aggregateKind: "thread",
  aggregateId: ThreadId.make("thread-1"),
  type: "thread.created",
  occurredAt: now,
  commandId: CommandId.make("command-thread"),
  causationEventId: null,
  correlationId: null,
  metadata: {},
  payload: {
    threadId: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("pi"), model: "model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: now,
    updatedAt: now,
  },
});

describe("thread transcript replacement", () => {
  it.effect("decides and projects an atomic branch replacement", () =>
    Effect.gen(function* () {
      const readModel = yield* seed;
      const messages = [
        {
          id: MessageId.make("pi:user"),
          role: "user" as const,
          text: "selected branch",
          turnId: TurnId.make("pi:user"),
          streaming: false,
          createdAt: later,
          updatedAt: later,
        },
      ];
      const event = yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.transcript.replace",
          commandId: CommandId.make("replace"),
          threadId: ThreadId.make("thread-1"),
          messages,
          activities: [],
          resetDerivedState: true,
          createdAt: later,
        },
      });
      expect("type" in event).toBe(true);
      if (!("type" in event)) return;
      expect(event.type).toBe("thread.transcript-replaced");
      const projected = yield* projectEvent(readModel, {
        ...event,
        sequence: 2,
      } as OrchestrationEvent);
      const thread = projected.threads[0];
      expect(thread?.messages).toEqual(messages);
      expect(thread?.activities).toEqual([]);
      expect(thread?.proposedPlans).toEqual([]);
      expect(thread?.checkpoints).toEqual([]);
      expect(thread?.latestTurn).toBeNull();
      expect(thread?.updatedAt).toBe(later);
      expect(thread?.session).toBeNull();
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves derived state during transcript reconciliation", () =>
    Effect.gen(function* () {
      const readModel = yield* seed;
      const latestTurn = {
        turnId: TurnId.make("active-turn"),
        state: "completed" as const,
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        assistantMessageId: null,
      };
      const current = {
        ...readModel,
        threads: readModel.threads.map((thread) => ({ ...thread, latestTurn })),
      };
      const event = yield* decideOrchestrationCommand({
        readModel: current,
        command: {
          type: "thread.transcript.replace",
          commandId: CommandId.make("reconcile"),
          threadId: ThreadId.make("thread-1"),
          messages: [],
          activities: [],
          resetDerivedState: false,
          createdAt: later,
        },
      });
      expect("type" in event).toBe(true);
      if (!("type" in event)) return;
      const projected = yield* projectEvent(current, {
        ...event,
        sequence: 2,
      } as OrchestrationEvent);
      expect(projected.threads[0]?.latestTurn).toEqual(latestTurn);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects replacement for a missing thread", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        decideOrchestrationCommand({
          readModel: createEmptyReadModel(now),
          command: {
            type: "thread.transcript.replace",
            commandId: CommandId.make("replace-missing"),
            threadId: ThreadId.make("missing"),
            messages: [],
            activities: [],
            resetDerivedState: false,
            createdAt: later,
          },
        }),
      );
      expect(exit._tag).toBe("Failure");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
