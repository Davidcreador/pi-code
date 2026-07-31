import {
  CommandId,
  EventId,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type PiNativeNavigateTreeResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { describe, expect, it } from "vite-plus/test";

import {
  hasProjectedPiTreeNavigationWork,
  navigatePiTreeAndReplaceTranscript,
  piTranscriptMatchesProjection,
  reconcilePiTranscript,
  reconcilePiTranscriptPreservingPendingUserMessage,
} from "./piTreeNavigation.ts";

const input = { threadId: ThreadId.make("thread-1"), targetId: "target" };
const result: PiNativeNavigateTreeResult = {
  cancelled: false,
  aborted: false,
  leafId: "target",
};

function dependencies(navigation: PiNativeNavigateTreeResult = result) {
  const calls = { read: 0, dispatch: [] as OrchestrationCommand[] };
  return {
    calls,
    value: {
      currentLeafId: "current-leaf",
      navigate: () => Effect.succeed(navigation),
      readTranscript: () =>
        Effect.sync(() => {
          calls.read += 1;
          return { messages: [], activities: [] };
        }),
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          calls.dispatch.push(command);
        }),
      commandId: Effect.succeed(CommandId.make("replace")),
      createdAt: Effect.succeed("2026-01-01T00:00:00.000Z"),
    },
  };
}

describe("piTranscriptMatchesProjection", () => {
  it("detects drift without considering materialization-only image bytes", () => {
    const transcript = { messages: [], activities: [], images: [] };
    expect(piTranscriptMatchesProjection(transcript, { messages: [], activities: [] })).toBe(true);
    expect(
      piTranscriptMatchesProjection(transcript, {
        messages: [],
        activities: [
          {
            id: EventId.make("activity"),
            tone: "tool",
            kind: "tool.completed",
            summary: "changed",
            payload: {},
            turnId: null,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    ).toBe(false);
  });
});

describe("reconcilePiTranscript", () => {
  it("dispatches only when the persisted projection drifted", async () => {
    const fixture = dependencies();
    const unchanged = await Effect.runPromise(
      reconcilePiTranscript(
        input.threadId,
        { messages: [], activities: [] },
        { messages: [], activities: [] },
        fixture.value,
      ),
    );
    expect(unchanged).toBe(false);
    expect(fixture.calls.dispatch).toEqual([]);

    const repaired = await Effect.runPromise(
      reconcilePiTranscript(
        input.threadId,
        { messages: [], activities: [] },
        {
          messages: [],
          activities: [
            {
              id: EventId.make("stale"),
              tone: "tool",
              kind: "tool.completed",
              summary: "stale",
              payload: {},
              turnId: null,
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
        fixture.value,
      ),
    );
    expect(repaired).toBe(true);
    expect(fixture.calls.dispatch).toHaveLength(1);
  });
});

describe("reconcilePiTranscriptPreservingPendingUserMessage", () => {
  it("keeps every queued user message while replacing drifted activities", async () => {
    const fixture = dependencies();
    const pendingMessages = ["first", "second"].map((text) => ({
      id: MessageId.make(`pending-${text}`),
      role: "user" as const,
      text,
      attachments: [],
      turnId: null,
      streaming: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }));

    const repaired = await Effect.runPromise(
      reconcilePiTranscriptPreservingPendingUserMessage(
        input.threadId,
        { messages: [], activities: [] },
        {
          messages: pendingMessages,
          activities: [
            {
              id: EventId.make("stale"),
              tone: "tool",
              kind: "tool.completed",
              summary: "stale",
              payload: {},
              turnId: null,
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
        fixture.value,
      ),
    );

    expect(repaired).toBe(true);
    expect(fixture.calls.dispatch[0]).toMatchObject({
      type: "thread.transcript.replace",
      messages: pendingMessages,
      activities: [],
      resetDerivedState: false,
    });
  });

  it("keeps a queued user message when transcript drift has the same length", async () => {
    const fixture = dependencies();
    const canonicalMessage = {
      id: MessageId.make("canonical"),
      role: "user" as const,
      text: "canonical",
      attachments: [],
      turnId: TurnId.make("pi:canonical"),
      streaming: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const pendingMessage = {
      ...canonicalMessage,
      id: MessageId.make("pending"),
      text: "pending",
      turnId: null,
    };

    await Effect.runPromise(
      reconcilePiTranscriptPreservingPendingUserMessage(
        input.threadId,
        { messages: [canonicalMessage], activities: [] },
        { messages: [pendingMessage], activities: [] },
        fixture.value,
      ),
    );

    expect(fixture.calls.dispatch[0]).toMatchObject({
      type: "thread.transcript.replace",
      messages: [canonicalMessage, pendingMessage],
      resetDerivedState: false,
    });
  });
});

describe("hasProjectedPiTreeNavigationWork", () => {
  it("allows an idle live session and rejects active turn work", () => {
    expect(
      hasProjectedPiTreeNavigationWork({
        latestTurn: { state: "completed" },
        session: { status: "running", activeTurnId: null },
      }),
    ).toBe(false);
    expect(
      hasProjectedPiTreeNavigationWork({
        latestTurn: { state: "queued" },
        session: { status: "running", activeTurnId: null },
      }),
    ).toBe(true);
    expect(
      hasProjectedPiTreeNavigationWork({
        latestTurn: { state: "running" },
        session: { status: "running", activeTurnId: "turn-1" },
      }),
    ).toBe(true);
    expect(
      hasProjectedPiTreeNavigationWork({
        latestTurn: null,
        session: { status: "starting", activeTurnId: null },
      }),
    ).toBe(true);
  });
});

describe("navigatePiTreeAndReplaceTranscript", () => {
  it("replaces the transcript only after successful navigation", async () => {
    const fixture = dependencies();
    await Effect.runPromise(navigatePiTreeAndReplaceTranscript(input, fixture.value));
    expect(fixture.calls.read).toBe(1);
    expect(fixture.calls.dispatch).toHaveLength(1);
    expect(fixture.calls.dispatch[0]).toMatchObject({
      type: "thread.transcript.replace",
      resetDerivedState: true,
    });
  });

  it("does not replace the transcript when navigating to the active leaf", async () => {
    const fixture = dependencies({ cancelled: false, aborted: false, leafId: "current-leaf" });
    await Effect.runPromise(
      navigatePiTreeAndReplaceTranscript({ ...input, targetId: "current-leaf" }, fixture.value),
    );
    expect(fixture.calls.read).toBe(0);
    expect(fixture.calls.dispatch).toEqual([]);
  });

  it.each([
    { cancelled: true, aborted: false, leafId: null },
    { cancelled: false, aborted: true, leafId: null },
  ])("does not replace after cancelled or aborted navigation", async (navigation) => {
    const fixture = dependencies(navigation);
    await Effect.runPromise(navigatePiTreeAndReplaceTranscript(input, fixture.value));
    expect(fixture.calls.read).toBe(0);
    expect(fixture.calls.dispatch).toEqual([]);
  });

  it("does not report success when replacement dispatch fails", async () => {
    const fixture = dependencies();
    const exit = await Effect.runPromise(
      Effect.exit(
        navigatePiTreeAndReplaceTranscript(input, {
          ...fixture.value,
          dispatch: () => Effect.fail("projection failed"),
        }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});
