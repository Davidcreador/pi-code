import type { PiNativeNavigateTreeResult, PiNativeSessionTree } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  activeTreeAncestry,
  applyTreeNavigationResult,
  createPiNativeDialogOperationController,
  downloadPiNativeHtmlExport,
  filterTreeEntries,
  writePiNativeClipboard,
} from "./PiNativeCommandDialog.logic";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const tree = {
  leafId: "child",
  entries: [
    { id: "root", parentId: null, preview: "Initial prompt", label: "Start" },
    { id: "child", parentId: "root", preview: "Current response", label: undefined },
    { id: "branch", parentId: "root", preview: "Alternative response", label: "Other" },
  ],
} as unknown as PiNativeSessionTree;

describe("Pi native dialog tree behavior", () => {
  it("filters entries without losing active ancestry selection", () => {
    expect([...activeTreeAncestry(tree)]).toEqual(["child", "root"]);
    expect(filterTreeEntries(tree.entries, "other").map((entry) => entry.id)).toEqual(["branch"]);
    expect(filterTreeEntries(tree.entries, "CURRENT").map((entry) => entry.id)).toEqual(["child"]);
  });

  it("restores editor text before closing after successful navigation", () => {
    const calls: string[] = [];
    const result = {
      cancelled: false,
      leafId: "root",
      editorText: "unfinished prompt",
    } as PiNativeNavigateTreeResult;

    expect(
      applyTreeNavigationResult(result, {
        restoreEditorText: (text) => calls.push(`restore:${text}`),
        close: () => calls.push("close"),
      }),
    ).toBe("completed");
    expect(calls).toEqual(["restore:unfinished prompt", "close"]);
  });
});

describe("Pi native dialog clipboard behavior", () => {
  it("reports an unavailable clipboard explicitly", async () => {
    await expect(writePiNativeClipboard("response", undefined)).rejects.toThrow(
      "Clipboard API unavailable.",
    );
  });

  it("preserves clipboard write errors for the dialog error region", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("Clipboard permission denied.");
    });

    await expect(writePiNativeClipboard("response", { writeText })).rejects.toThrow(
      "Clipboard permission denied.",
    );
    expect(writeText).toHaveBeenCalledWith("response");
  });
});

describe("Pi native dialog operation controller", () => {
  it("latches summary navigation until navigation settles when abort finishes first", async () => {
    const navigation = deferred();
    const abort = deferred();
    const states: string[] = [];
    const controller = createPiNativeDialogOperationController((state) => {
      states.push(`${state.primary}:${state.abortInFlight}`);
    });

    const navigationRun = controller.runPrimary(
      "tree-navigation-summary",
      () => navigation.promise,
    );
    const abortRun = controller.runAbort(() => abort.promise);
    expect(controller.getState()).toEqual({
      primary: "tree-navigation-summary",
      abortInFlight: true,
    });
    expect(await controller.runPrimary("mutation", async () => undefined)).toBe(false);
    expect(await controller.runAbort(async () => undefined)).toBe(false);

    abort.resolve();
    expect(await abortRun).toBe(true);
    expect(controller.getState()).toEqual({
      primary: "tree-navigation-summary",
      abortInFlight: false,
    });

    navigation.resolve();
    expect(await navigationRun).toBe(true);
    expect(controller.getState()).toEqual({ primary: "idle", abortInFlight: false });
    expect(states).toEqual([
      "tree-navigation-summary:false",
      "tree-navigation-summary:true",
      "tree-navigation-summary:false",
      "idle:false",
    ]);
  });

  it("dispatches one common mutation and propagates its error after clearing busy state", async () => {
    const action = vi.fn(async () => {
      throw new Error("reload failed");
    });
    const controller = createPiNativeDialogOperationController(() => undefined);

    await expect(controller.runPrimary("mutation", action)).rejects.toThrow("reload failed");
    expect(action).toHaveBeenCalledOnce();
    expect(controller.getState()).toEqual({ primary: "idle", abortInFlight: false });
  });
});

describe("Pi native HTML export", () => {
  it("downloads the opaque artifact URL without exposing a host path", () => {
    const click = vi.fn();
    const anchor = { href: "", download: "", target: "", rel: "", click };
    const url = downloadPiNativeHtmlExport(
      "https://environment.example/base/",
      {
        handle: "opaque-export-id",
        fileName: "session.html",
        relativeUrl: "/api/assets/signed-token/session.html",
        expiresAt: Date.now() + 1_000,
      },
      { createElement: vi.fn(() => anchor) } as unknown as Pick<Document, "createElement">,
    );

    expect(url).toBe("https://environment.example/api/assets/signed-token/session.html");
    expect(anchor).toMatchObject({
      href: url,
      download: "session.html",
      target: "_blank",
      rel: "noopener noreferrer",
    });
    expect(click).toHaveBeenCalledOnce();
  });
});
