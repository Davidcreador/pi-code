import { ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { it as effectIt } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { checkpointRefPrefixForThread } from "../../checkpointing/Utils.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import {
  deleteThreadCheckpointRefs,
  logCleanupCauseUnlessInterrupted,
} from "./ThreadDeletionReactor.ts";

describe("deleteThreadCheckpointRefs", () => {
  effectIt.effect("deletes the thread ref namespace from its worktree", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-deletion-reactor-test");
      const projectId = ProjectId.make("project-deletion-reactor-test");
      const calls: CheckpointStore.DeleteCheckpointRefsInput[] = [];
      const layer = Layer.mergeAll(
        Layer.mock(ProjectionThreadRepository)({
          getById: () =>
            Effect.succeed(
              Option.some({
                threadId,
                projectId,
                title: "Deleted thread",
                modelSelection: { instanceId: ProviderInstanceId.make("pi"), model: "default" },
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: "/tmp/deleted-thread-worktree",
                latestTurnId: null,
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
                archivedAt: null,
                settledOverride: null,
                settledAt: null,
                snoozedUntil: null,
                snoozedAt: null,
                latestUserMessageAt: null,
                pendingApprovalCount: 0,
                pendingUserInputCount: 0,
                hasActionableProposedPlan: 0,
                deletedAt: "2026-01-01T00:00:01.000Z",
              }),
            ),
        }),
        Layer.mock(ProjectionProjectRepository)({
          getById: () =>
            Effect.succeed(
              Option.some({
                projectId,
                title: "Deleted project",
                workspaceRoot: "/tmp/deleted-project",
                defaultModelSelection: null,
                scripts: [],
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
                deletedAt: null,
              }),
            ),
        }),
        Layer.mock(CheckpointStore.CheckpointStore)({
          deleteCheckpointRefs: (input) =>
            Effect.sync(() => {
              calls.push(input);
            }),
        }),
      );

      yield* deleteThreadCheckpointRefs(threadId).pipe(Effect.provide(layer));

      expect(calls).toEqual([
        {
          cwd: "/tmp/deleted-thread-worktree",
          checkpointRefPrefix: checkpointRefPrefixForThread(threadId),
        },
      ]);
    }),
  );
});

describe("logCleanupCauseUnlessInterrupted", () => {
  const threadId = ThreadId.make("thread-deletion-reactor-test");

  it("swallows ordinary cleanup failures", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.fail("cleanup failed"),
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("preserves interrupt causes", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.interrupt,
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  });
});
