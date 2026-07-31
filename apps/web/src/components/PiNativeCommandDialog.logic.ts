import type {
  PiNativeExportHtmlResult,
  PiNativeNavigateTreeResult,
  PiNativeSessionTree,
  PiNativeTreeEntry,
} from "@t3tools/contracts";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";

export type PiNativeDialogPrimaryOperation =
  | "idle"
  | "mutation"
  | "tree-navigation"
  | "tree-navigation-summary";

export interface PiNativeDialogOperationState {
  readonly primary: PiNativeDialogPrimaryOperation;
  readonly abortInFlight: boolean;
}

export interface PiNativeDialogOperationController {
  getState: () => PiNativeDialogOperationState;
  runPrimary: (
    operation: Exclude<PiNativeDialogPrimaryOperation, "idle">,
    action: () => Promise<void>,
  ) => Promise<boolean>;
  runAbort: (action: () => Promise<void>) => Promise<boolean>;
}

export function createPiNativeDialogOperationController(
  onStateChange: (state: PiNativeDialogOperationState) => void,
): PiNativeDialogOperationController {
  let state: PiNativeDialogOperationState = { primary: "idle", abortInFlight: false };
  const update = (next: PiNativeDialogOperationState) => {
    state = next;
    onStateChange(state);
  };

  return {
    getState: () => state,
    runPrimary: async (operation, action) => {
      if (state.primary !== "idle" || state.abortInFlight) return false;
      update({ primary: operation, abortInFlight: false });
      try {
        await action();
      } finally {
        update({ primary: "idle", abortInFlight: state.abortInFlight });
      }
      return true;
    },
    runAbort: async (action) => {
      if (state.primary !== "tree-navigation-summary" || state.abortInFlight) return false;
      update({ ...state, abortInFlight: true });
      try {
        await action();
      } finally {
        update({ ...state, abortInFlight: false });
      }
      return true;
    },
  };
}

export function activeTreeAncestry(tree: PiNativeSessionTree): ReadonlySet<string> {
  const ids = new Set<string>();
  const byId = new Map(tree.entries.map((entry) => [entry.id, entry]));
  let id = tree.leafId;
  while (id) {
    ids.add(id);
    id = byId.get(id)?.parentId ?? null;
  }
  return ids;
}

export function filterTreeEntries(
  entries: readonly PiNativeTreeEntry[],
  search: string,
): readonly PiNativeTreeEntry[] {
  const query = search.trim().toLowerCase();
  if (!query) return entries;
  return entries.filter(
    (entry) =>
      entry.preview.toLowerCase().includes(query) || entry.label?.toLowerCase().includes(query),
  );
}

export async function writePiNativeClipboard(
  text: string,
  clipboard: Pick<Clipboard, "writeText"> | undefined = typeof navigator === "undefined"
    ? undefined
    : navigator.clipboard,
): Promise<void> {
  if (!clipboard?.writeText) throw new Error("Clipboard API unavailable.");
  try {
    await clipboard.writeText(text);
  } catch (cause) {
    throw cause instanceof Error ? cause : new Error("Copy failed.");
  }
}

export function applyTreeNavigationResult(
  result: PiNativeNavigateTreeResult,
  callbacks: { readonly restoreEditorText: (text: string) => void; readonly close: () => void },
): "cancelled" | "completed" {
  if (result.cancelled) return "cancelled";
  if (result.editorText !== undefined) callbacks.restoreEditorText(result.editorText);
  callbacks.close();
  return "completed";
}

export function downloadPiNativeHtmlExport(
  httpBaseUrl: string,
  result: PiNativeExportHtmlResult,
  documentRef: Pick<Document, "createElement"> = document,
): string {
  const url = resolveAssetUrl(httpBaseUrl, result.relativeUrl);
  if (url === null) throw new Error("The export URL is invalid.");
  const anchor = documentRef.createElement("a");
  anchor.href = url;
  anchor.download = result.fileName;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  anchor.click();
  return url;
}
