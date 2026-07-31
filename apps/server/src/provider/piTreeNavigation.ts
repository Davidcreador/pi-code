import type {
  CommandId,
  OrchestrationCommand,
  OrchestrationMessage,
  OrchestrationThreadActivity,
  PiNativeNavigateTreeInput,
  PiNativeNavigateTreeResult,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { PiActiveTranscript } from "./piTranscript.ts";

type TranscriptReplaceCommand = Extract<
  OrchestrationCommand,
  { readonly type: "thread.transcript.replace" }
>;

export function hasProjectedPiTreeNavigationWork(
  thread:
    | {
        readonly latestTurn: { readonly state: string } | null;
        readonly session: {
          readonly status: string;
          readonly activeTurnId: unknown | null;
        } | null;
      }
    | undefined,
): boolean {
  return (
    thread?.latestTurn?.state === "queued" ||
    thread?.latestTurn?.state === "running" ||
    thread?.session?.status === "starting" ||
    thread?.session?.activeTurnId != null
  );
}

interface TranscriptReplacementDependencies<DE, DR, ME, MR> {
  readonly dispatch: (command: TranscriptReplaceCommand) => Effect.Effect<unknown, DE, DR>;
  readonly commandId: Effect.Effect<CommandId, ME, MR>;
  readonly createdAt: Effect.Effect<string, never, never>;
}

export function piTranscriptMatchesProjection(
  transcript: PiActiveTranscript,
  projected: {
    readonly messages: ReadonlyArray<OrchestrationMessage>;
    readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  },
): boolean {
  return (
    JSON.stringify(transcript.messages) === JSON.stringify(projected.messages) &&
    JSON.stringify(transcript.activities) === JSON.stringify(projected.activities)
  );
}

export function replacePiTranscript<DE, DR, ME, MR>(
  threadId: ThreadId,
  transcript: PiActiveTranscript,
  resetDerivedState: boolean,
  dependencies: TranscriptReplacementDependencies<DE, DR, ME, MR>,
): Effect.Effect<void, DE | ME, DR | MR> {
  return Effect.all({
    commandId: dependencies.commandId,
    createdAt: dependencies.createdAt,
  }).pipe(
    Effect.flatMap(({ commandId, createdAt }) =>
      dependencies.dispatch({
        type: "thread.transcript.replace",
        commandId,
        threadId,
        messages: transcript.messages,
        activities: transcript.activities,
        resetDerivedState,
        createdAt,
      }),
    ),
    Effect.asVoid,
  );
}

export function reconcilePiTranscript<DE, DR, ME, MR>(
  threadId: ThreadId,
  transcript: PiActiveTranscript,
  projected: {
    readonly messages: ReadonlyArray<OrchestrationMessage>;
    readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  },
  dependencies: TranscriptReplacementDependencies<DE, DR, ME, MR>,
): Effect.Effect<boolean, DE | ME, DR | MR> {
  if (piTranscriptMatchesProjection(transcript, projected)) return Effect.succeed(false);
  return replacePiTranscript(threadId, transcript, false, dependencies).pipe(Effect.as(true));
}

export function reconcilePiTranscriptPreservingPendingUserMessage<DE, DR, ME, MR>(
  threadId: ThreadId,
  transcript: PiActiveTranscript,
  projected: {
    readonly messages: ReadonlyArray<OrchestrationMessage>;
    readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  },
  dependencies: TranscriptReplacementDependencies<DE, DR, ME, MR>,
): Effect.Effect<boolean, DE | ME, DR | MR> {
  let pendingStart = projected.messages.length;
  while (
    pendingStart > 0 &&
    projected.messages[pendingStart - 1]?.role === "user" &&
    projected.messages[pendingStart - 1]?.turnId === null
  ) {
    pendingStart -= 1;
  }
  const pendingUserMessages = projected.messages.slice(pendingStart);
  if (pendingUserMessages.length === 0) {
    return reconcilePiTranscript(threadId, transcript, projected, dependencies);
  }

  const projectedBeforePending = {
    messages: projected.messages.slice(0, pendingStart),
    activities: projected.activities,
  };
  if (piTranscriptMatchesProjection(transcript, projectedBeforePending)) {
    return Effect.succeed(false);
  }
  return replacePiTranscript(
    threadId,
    {
      ...transcript,
      messages: [...transcript.messages, ...pendingUserMessages],
    },
    false,
    dependencies,
  ).pipe(Effect.as(true));
}

export function navigatePiTreeAndReplaceTranscript<NE, NR, RE, RR, DE, DR, ME, MR>(
  input: PiNativeNavigateTreeInput,
  dependencies: {
    readonly currentLeafId: string | null;
    readonly navigate: (
      input: PiNativeNavigateTreeInput,
    ) => Effect.Effect<PiNativeNavigateTreeResult, NE, NR>;
    readonly readTranscript: () => Effect.Effect<PiActiveTranscript, RE, RR>;
  } & TranscriptReplacementDependencies<DE, DR, ME, MR>,
): Effect.Effect<PiNativeNavigateTreeResult, NE | RE | DE | ME, NR | RR | DR | MR> {
  return dependencies.navigate(input).pipe(
    Effect.flatMap((result) => {
      if (result.cancelled || result.aborted || dependencies.currentLeafId === input.targetId) {
        return Effect.succeed(result);
      }
      return dependencies.readTranscript().pipe(
        Effect.flatMap((transcript) =>
          replacePiTranscript(input.threadId, transcript, true, dependencies),
        ),
        Effect.as(result),
      );
    }),
  );
}
