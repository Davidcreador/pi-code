import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  PI_NATIVE_WS_METHODS,
  PiNativeExportHtmlInput,
  PiNativeImportInput,
  PiNativeNavigateTreeResult,
  PiNativeSetTrustInput,
  PiNativeShareInput,
  PiNativeUpdateSettingsInput,
  PiNativeSessionTree,
} from "./piNative.ts";

const decodeTree = Schema.decodeUnknownSync(PiNativeSessionTree);
const decodeNavigation = Schema.decodeUnknownSync(PiNativeNavigateTreeResult);

describe("Pi-native contracts", () => {
  it("accepts presentation-safe tree data", () => {
    expect(
      decodeTree({
        entries: [
          {
            id: "u1",
            parentId: null,
            childIds: ["a1"],
            order: 0,
            kind: "message",
            role: "user",
            timestamp: "2026-01-01T00:00:00.000Z",
            label: "start",
            preview: "hello",
            editorText: "hello",
          },
        ],
        leafId: "u1",
      }),
    ).toMatchObject({ leafId: "u1", entries: [{ editorText: "hello" }] });
  });

  it("preserves navigation cancellation and abort fields", () => {
    expect(decodeNavigation({ cancelled: true, aborted: true, leafId: null })).toEqual({
      cancelled: true,
      aborted: true,
      leafId: null,
    });
  });

  it("does not expose an export output path over RPC", () => {
    expect(
      Schema.decodeUnknownSync(PiNativeExportHtmlInput)({
        threadId: "11111111-1111-4111-8111-111111111111",
        outputPath: "/tmp/caller-controlled.html",
      }),
    ).toEqual({ threadId: "11111111-1111-4111-8111-111111111111" });
  });

  it("rejects unsafe settings keys and caller-controlled import paths", () => {
    expect(
      Schema.decodeUnknownSync(PiNativeUpdateSettingsInput)({
        threadId: "11111111-1111-4111-8111-111111111111",
        scope: "global",
        values: { shellPath: "/bin/evil" },
      }).values,
    ).toEqual({});
    expect(
      Schema.decodeUnknownSync(PiNativeImportInput)({
        threadId: "11111111-1111-4111-8111-111111111111",
        filename: "uploaded.jsonl",
        content: "{}\n",
        sourcePath: "/etc/passwd",
      }),
    ).not.toHaveProperty("sourcePath");
  });

  it("requires trust confirmation to be typed separately from the decision", () => {
    expect(
      Schema.decodeUnknownSync(PiNativeSetTrustInput)({
        threadId: "11111111-1111-4111-8111-111111111111",
        trusted: true,
        confirmed: true,
        path: "/tmp",
      }),
    ).not.toHaveProperty("path");
  });

  it("requires explicit confirmation for sharing", () => {
    expect(() =>
      Schema.decodeUnknownSync(PiNativeShareInput)({
        threadId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toThrow();
  });

  it("uses a distinct typed method for every requested operation", () => {
    expect(new Set(Object.values(PI_NATIVE_WS_METHODS)).size).toBe(29);
  });
});
