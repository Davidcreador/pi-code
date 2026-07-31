import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  normalizePiActiveTranscript,
  PI_TRANSCRIPT_MAX_IMAGES,
  PI_TRANSCRIPT_MAX_IMAGE_BYTES,
} from "./piTranscript.ts";

const TIMESTAMP = 1_767_225_600_000;

const entry = (id: string, parentId: string | null, value: Record<string, unknown>) => ({
  id,
  parentId,
  timestamp: TIMESTAMP,
  ...value,
});

const piMessage = (role: string, content: unknown, extra: Record<string, unknown> = {}) => ({
  role,
  content,
  timestamp: TIMESTAMP,
  ...extra,
});

describe("normalizePiActiveTranscript", () => {
  it("walks only the selected branch and assigns deterministic turn ids", () => {
    const entries = [
      entry("u1", null, { type: "message", message: piMessage("user", "first") }),
      entry("a1", "u1", {
        type: "message",
        message: piMessage("assistant", [{ type: "text", text: "old" }]),
      }),
      entry("a2", "u1", {
        type: "message",
        message: piMessage("assistant", [{ type: "text", text: "selected" }]),
      }),
    ];
    const transcript = normalizePiActiveTranscript(entries, "a2");
    expect(transcript.messages.map(({ id, text, turnId }) => ({ id, text, turnId }))).toEqual([
      { id: "pi:u1", text: "first", turnId: "pi:u1" },
      { id: "pi:a2", text: "selected", turnId: "pi:u1" },
    ]);
  });

  it("preserves displayed custom messages and summaries but excludes metadata", () => {
    const entries = [
      entry("model", null, { type: "model_change", provider: "x", modelId: "y" }),
      entry("custom", "model", { type: "custom_message", display: true, content: "notice" }),
      entry("hidden", "custom", { type: "custom_message", display: false, content: "secret" }),
      entry("compact", "hidden", { type: "compaction", summary: "summary" }),
      entry("branch", "compact", { type: "branch_summary", summary: "branch summary" }),
    ];
    expect(
      normalizePiActiveTranscript(entries, "branch").messages.map((message) => message.text),
    ).toEqual(["notice", "summary", "branch summary"]);
  });

  it("normalizes tool calls, results, and bash execution into safe activities", () => {
    const entries = [
      entry("u", null, { type: "message", message: piMessage("user", "run") }),
      entry("a", "u", {
        type: "message",
        message: piMessage("assistant", [
          { type: "text", text: "working" },
          { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } },
        ]),
      }),
      entry("result", "a", {
        type: "message",
        message: piMessage("toolResult", [{ type: "text", text: "done" }], {
          toolCallId: "call-1",
          toolName: "read",
          isError: false,
        }),
      }),
      entry("bash", "result", {
        type: "message",
        message: piMessage("bashExecution", [], {
          command: "pwd",
          output: "/tmp",
          exitCode: 0,
          cancelled: false,
          truncated: false,
        }),
      }),
    ];
    const activities = normalizePiActiveTranscript(entries, "bash").activities;
    expect(
      activities.map(({ id, kind, turnId, payload }) => ({ id, kind, turnId, payload })),
    ).toEqual([
      {
        id: "pi:a:tool:call-1",
        kind: "tool.completed",
        turnId: "pi:u",
        payload: {
          itemType: "dynamic_tool_call",
          status: "completed",
          title: "read",
          data: {
            toolCallId: "call-1",
            toolName: "read",
            args: { path: "a.ts" },
            result: "done",
          },
        },
      },
      {
        id: "pi:bash:bash",
        kind: "tool.completed",
        turnId: "pi:u",
        payload: {
          itemType: "command_execution",
          status: "completed",
          title: "Ran command",
          detail: "pwd",
          data: {
            command: "pwd",
            output: "/tmp",
            exitCode: 0,
            cancelled: false,
            truncated: false,
          },
        },
      },
    ]);
  });

  it("materializes deterministic image metadata without retaining base64 in messages", () => {
    const transcript = normalizePiActiveTranscript(
      [
        entry("u", null, {
          type: "message",
          message: piMessage("user", [
            { type: "text", text: "look" },
            { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
          ]),
        }),
      ],
      "u",
      ThreadId.make("thread-1"),
    );
    expect(transcript.messages[0]?.attachments).toEqual([
      expect.objectContaining({ type: "image", mimeType: "image/png", sizeBytes: 5 }),
    ]);
    expect(JSON.stringify(transcript.messages)).not.toContain("aGVsbG8=");
    expect(Array.from(transcript.images?.[0]?.data ?? [])).toEqual([104, 101, 108, 108, 111]);
  });

  it("rejects oversized and malformed image base64 before decoding", () => {
    const oversizedBase64 = "A".repeat(Math.ceil((10 * 1024 * 1024 + 1) / 3) * 4);
    const makeTranscript = (data: string) =>
      normalizePiActiveTranscript(
        [
          entry("u", null, {
            type: "message",
            message: piMessage("user", [{ type: "image", mimeType: "image/png", data }]),
          }),
        ],
        "u",
        ThreadId.make("thread-image-validation"),
      );

    expect(() => makeTranscript(oversizedBase64)).toThrow("too large");
    expect(() => makeTranscript("AAAA====")).toThrow("invalid base64");
  });

  it("limits the number of images across retained messages", () => {
    const content = Array.from({ length: PI_TRANSCRIPT_MAX_IMAGES + 1 }, () => ({
      type: "image",
      mimeType: "image/png",
      data: "AA==",
    }));
    expect(() =>
      normalizePiActiveTranscript(
        [entry("u", null, { type: "message", message: piMessage("user", content) })],
        "u",
        ThreadId.make("thread-image-count"),
      ),
    ).toThrow(`more than ${PI_TRANSCRIPT_MAX_IMAGES} images`);
  });

  it("limits aggregate decoded image bytes across retained messages", () => {
    const bytesPerImage = 10 * 1024 * 1024;
    const fullGroups = Math.floor(bytesPerImage / 3);
    const remainder = bytesPerImage % 3;
    const base64 = `${"A".repeat(fullGroups * 4)}${remainder === 1 ? "AA==" : "AAA="}`;
    const imageCountAtLimit = PI_TRANSCRIPT_MAX_IMAGE_BYTES / bytesPerImage;
    const content = Array.from({ length: imageCountAtLimit + 1 }, () => ({
      type: "image",
      mimeType: "image/png",
      data: base64,
    }));

    expect(() =>
      normalizePiActiveTranscript(
        [entry("u", null, { type: "message", message: piMessage("user", content) })],
        "u",
        ThreadId.make("thread-image-aggregate"),
      ),
    ).toThrow("100 MiB aggregate limit");
  });

  it("materializes images only for the latest bounded messages", () => {
    const threadId = ThreadId.make("thread-bounded");
    const entries: Array<Record<string, unknown>> = [
      entry("old-image", null, {
        type: "message",
        message: piMessage("user", [{ type: "image", mimeType: "text/plain", data: "aA==" }]),
      }),
    ];
    let parentId = "old-image";
    for (let index = 0; index < 1_999; index += 1) {
      const id = `message-${index}`;
      entries.push(
        entry(id, parentId, {
          type: "message",
          message: piMessage(index % 2 === 0 ? "assistant" : "user", `message ${index}`),
        }),
      );
      parentId = id;
    }
    entries.push(
      entry("retained-image", parentId, {
        type: "message",
        message: piMessage("user", [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }]),
      }),
    );

    const transcript = normalizePiActiveTranscript(entries, "retained-image", threadId);

    expect(transcript.messages).toHaveLength(2_000);
    expect(transcript.messages[0]?.id).toBe("pi:message-0");
    expect(transcript.messages.at(-1)?.id).toBe("pi:retained-image");
    expect(transcript.images).toHaveLength(1);
    expect(transcript.images?.[0]?.attachment.mimeType).toBe("image/png");
  });

  it("pairs a retained tool result with its call across the message truncation boundary", () => {
    const entries: Array<Record<string, unknown>> = [
      entry("user-before-boundary", null, {
        type: "message",
        message: piMessage("user", "start"),
      }),
      entry("call-before-boundary", "user-before-boundary", {
        type: "message",
        message: piMessage("assistant", [
          { type: "text", text: "calling" },
          {
            type: "toolCall",
            id: "boundary-call",
            name: "read",
            arguments: { path: "boundary.ts" },
          },
        ]),
      }),
    ];
    let parentId = "call-before-boundary";
    for (let index = 0; index < 2_000; index += 1) {
      const id = `retained-${index}`;
      entries.push(
        entry(id, parentId, {
          type: "message",
          message: piMessage(index % 2 === 0 ? "user" : "assistant", `message ${index}`),
        }),
      );
      parentId = id;
    }
    entries.push(
      entry("boundary-result", parentId, {
        type: "message",
        message: piMessage("toolResult", [{ type: "text", text: "done" }], {
          toolCallId: "boundary-call",
          toolName: "read",
          isError: false,
        }),
      }),
    );

    const transcript = normalizePiActiveTranscript(entries, "boundary-result");
    expect(transcript.messages).toHaveLength(2_000);
    expect(transcript.messages.some(({ id }) => id === "pi:call-before-boundary")).toBe(false);
    expect(transcript.activities).toEqual([
      expect.objectContaining({
        id: "pi:call-before-boundary:tool:boundary-call",
        payload: expect.objectContaining({
          data: expect.objectContaining({ args: { path: "boundary.ts" }, result: "done" }),
        }),
      }),
    ]);
  });

  it("rejects a missing leaf and parent cycles", () => {
    expect(() => normalizePiActiveTranscript([], "missing")).toThrow("was not found");
    expect(() =>
      normalizePiActiveTranscript(
        [entry("a", "b", { type: "custom" }), entry("b", "a", { type: "custom" })],
        "a",
      ),
    ).toThrow("parent cycle");
  });
});
