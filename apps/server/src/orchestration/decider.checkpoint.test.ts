import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationSession,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function makeReadModel(status: OrchestrationSession["status"]): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("pi"), model: "default" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: {
          threadId: ThreadId.make("thread-1"),
          status,
          providerName: "Pi",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW,
        },
      },
    ],
    updatedAt: NOW,
  };
}

it.layer(NodeServices.layer)("checkpoint revert decider", (it) => {
  it.effect("rejects revert while the provider session is active", () =>
    Effect.gen(function* () {
      for (const status of ["starting", "running"] as const) {
        const error = yield* decideOrchestrationCommand({
          command: {
            type: "thread.checkpoint.revert",
            commandId: CommandId.make(`cmd-revert-${status}`),
            threadId: ThreadId.make("thread-1"),
            turnCount: 0,
            createdAt: NOW,
          },
          readModel: makeReadModel(status),
        }).pipe(Effect.flip);

        expect(error._tag).toBe("OrchestrationCommandInvariantError");
        expect(error.message).toContain("active session");
      }
    }),
  );
});
