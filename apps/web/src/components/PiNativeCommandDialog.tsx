import type {
  EnvironmentId,
  PiNativeSessionStateAndStats,
  PiNativeSessionTree,
  ThreadId,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type * as Cause from "effect/Cause";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import type { NativeSlashCommand } from "../nativeSlashCommands";
import { piNativeEnvironment } from "../state/piNative";
import { usePreparedConnection } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import {
  activeTreeAncestry,
  applyTreeNavigationResult,
  createPiNativeDialogOperationController,
  downloadPiNativeHtmlExport,
  filterTreeEntries,
  type PiNativeDialogOperationState,
  writePiNativeClipboard,
} from "./PiNativeCommandDialog.logic";

function failureMessage(
  result: { readonly _tag: string; readonly cause?: Cause.Cause<unknown> },
  fallback: string,
): string | null {
  if (result._tag !== "Failure" || result.cause === undefined) return null;
  const error = squashAtomCommandFailure({ cause: result.cause });
  return error instanceof Error ? error.message : fallback;
}

export function PiNativeCommandDialog(props: {
  command: NativeSlashCommand | null;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  onClose: () => void;
  onNewThread: () => void;
  onQuit: () => Promise<void>;
  onRestoreEditorText: (text: string) => void;
}) {
  const getTree = useAtomCommand(piNativeEnvironment.getTree, { reportFailure: false });
  const navigateTree = useAtomCommand(piNativeEnvironment.navigateTree, { reportFailure: false });
  const abortBranchSummary = useAtomCommand(piNativeEnvironment.abortBranchSummary, {
    reportFailure: false,
  });
  const setEntryLabel = useAtomCommand(piNativeEnvironment.setEntryLabel, { reportFailure: false });
  const reload = useAtomCommand(piNativeEnvironment.reload, { reportFailure: false });
  const compact = useAtomCommand(piNativeEnvironment.compact, { reportFailure: false });
  const getStateAndStats = useAtomCommand(piNativeEnvironment.getStateAndStats, {
    reportFailure: false,
  });
  const setSessionName = useAtomCommand(piNativeEnvironment.setSessionName, {
    reportFailure: false,
  });
  const getLastAssistantText = useAtomCommand(piNativeEnvironment.getLastAssistantText, {
    reportFailure: false,
  });
  const exportHtml = useAtomCommand(piNativeEnvironment.exportHtml, { reportFailure: false });
  const preparedConnection = usePreparedConnection(props.environmentId);
  const [tree, setTree] = useState<PiNativeSessionTree | null>(null);
  const [session, setSession] = useState<PiNativeSessionStateAndStats | null>(null);
  const [search, setSearch] = useState("");
  const [targetId, setTargetId] = useState<string | null>(null);
  const [instructions, setInstructions] = useState("");
  const [summarize, setSummarize] = useState(false);
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  const [operation, setOperation] = useState<PiNativeDialogOperationState>({
    primary: "idle",
    abortInFlight: false,
  });
  const operationControllerRef = useRef<ReturnType<
    typeof createPiNativeDialogOperationController
  > | null>(null);
  operationControllerRef.current ??= createPiNativeDialogOperationController(setOperation);
  const operationController = operationControllerRef.current;
  const busy = operation.primary !== "idle" || operation.abortInFlight;
  const summarizing = operation.primary === "tree-navigation-summary";
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const input = useMemo(
    () => ({ environmentId: props.environmentId, input: { threadId: props.threadId } }),
    [props.environmentId, props.threadId],
  );

  const loadState = useCallback(async () => {
    const result = await getStateAndStats(input);
    const failure = failureMessage(result, "Could not read Pi session state.");
    if (failure) throw new Error(failure);
    if (result._tag === "Success") {
      setSession(result.value);
      return result.value;
    }
    throw new Error("Could not read Pi session state.");
  }, [getStateAndStats, input]);

  const requireIdle = useCallback(async () => {
    const current = await loadState();
    if (current.state.isStreaming || current.state.isCompacting) {
      throw new Error(
        current.state.isCompacting
          ? "Pi is compacting this session."
          : "Pi is streaming a response.",
      );
    }
  }, [loadState]);

  useEffect(() => {
    setError(null);
    setNotice(null);
    setTree(null);
    setSession(null);
    setTargetId(null);
    setSearch("");
    setInstructions("");
    setSummarize(false);
    setName("");
    setLabel("");
    if (!props.command) return;
    if (props.command === "new") {
      props.onNewThread();
      props.onClose();
      return;
    }
    if (props.command === "copy") {
      void getLastAssistantText(input)
        .then(async (result) => {
          const failure = failureMessage(result, "Could not read the last assistant response.");
          if (failure) return setError(failure);
          if (result._tag === "Success" && result.value.text) {
            await writePiNativeClipboard(result.value.text);
            setNotice("Last assistant response copied.");
          } else setNotice("There is no assistant response to copy.");
        })
        .catch((cause: unknown) =>
          setError(cause instanceof Error ? cause.message : "Copy failed."),
        );
      return;
    }
    if (props.command === "tree") {
      void getTree(input).then((result) => {
        const failure = failureMessage(result, "Could not load the session tree.");
        if (failure) return setError(failure);
        if (result._tag === "Success") {
          setTree(result.value);
          setTargetId(result.value.leafId);
          setLabel(
            result.value.entries.find((entry) => entry.id === result.value.leafId)?.label ?? "",
          );
        }
      });
      void loadState().catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Could not load session state."),
      );
      return;
    }
    if (props.command === "session" || props.command === "stats" || props.command === "name") {
      void loadState()
        .then((current) => {
          if (props.command === "name") setName(current.state.sessionName ?? "");
        })
        .catch((cause: unknown) =>
          setError(cause instanceof Error ? cause.message : "Could not load session state."),
        );
    }
  }, [
    getLastAssistantText,
    getTree,
    input,
    loadState,
    props.command,
    props.onClose,
    props.onNewThread,
  ]);

  const activeAncestry = useMemo(
    () => (tree ? activeTreeAncestry(tree) : new Set<string>()),
    [tree],
  );
  const entries = useMemo(
    () => (tree ? filterTreeEntries(tree.entries, search) : []),
    [search, tree],
  );
  const selectedEntry = tree?.entries.find((entry) => entry.id === targetId) ?? null;
  const reportOperation = async (action: () => Promise<void>) => {
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Pi operation failed.");
    }
  };
  const run = (action: () => Promise<void>) =>
    operationController.runPrimary("mutation", () => reportOperation(action));
  const runMutation = (action: () => Promise<void>) =>
    operationController.runPrimary("mutation", () =>
      reportOperation(async () => {
        await requireIdle();
        await action();
      }),
    );
  const copyText = (text: string, description: string) =>
    run(async () => {
      await writePiNativeClipboard(text);
      setNotice(`${description} copied.`);
    });

  const title =
    props.command === "tree"
      ? "Session tree"
      : props.command === "session" || props.command === "stats"
        ? "Session statistics"
        : `/${props.command ?? ""}`;

  return (
    <Dialog
      open={
        props.command !== null &&
        props.command !== "model" &&
        props.command !== "plan" &&
        props.command !== "default" &&
        props.command !== "new"
      }
      onOpenChange={(open) => {
        if (!open && !busy) props.onClose();
      }}
    >
      <DialogPopup className="w-full max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="max-h-[70vh] space-y-4">
          {error ? (
            <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {notice ? (
            <p role="status" className="rounded-lg bg-muted p-3 text-sm">
              {notice}
            </p>
          ) : null}
          {props.command === "tree" ? (
            <>
              <Input
                type="search"
                placeholder="Search entries and labels"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <div className="max-h-72 space-y-1 overflow-y-auto">
                {entries.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => {
                      setTargetId(entry.id);
                      setLabel(entry.label ?? "");
                    }}
                    className={`block w-full rounded-lg border p-3 text-left text-sm ${targetId === entry.id ? "border-ring bg-accent" : "border-border"}`}
                  >
                    <span className="flex gap-2">
                      <strong>{entry.label ?? entry.kind}</strong>
                      {activeAncestry.has(entry.id) ? (
                        <span className="text-muted-foreground">active</span>
                      ) : null}
                    </span>
                    <span className="line-clamp-2 text-muted-foreground">
                      {entry.preview || "No text preview"}
                    </span>
                  </button>
                ))}
              </div>
              {selectedEntry ? (
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <Input
                      placeholder="Entry label"
                      value={label}
                      onChange={(event) => setLabel(event.target.value)}
                    />
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void runMutation(async () => {
                          const result = await setEntryLabel({
                            environmentId: props.environmentId,
                            input: {
                              threadId: props.threadId,
                              targetId: selectedEntry.id,
                              label: label.trim() || undefined,
                            },
                          });
                          const failure = failureMessage(result, "Could not update label.");
                          if (failure) throw new Error(failure);
                          const refreshed = await getTree(input);
                          const refreshFailure = failureMessage(
                            refreshed,
                            "Could not refresh the session tree.",
                          );
                          if (refreshFailure) throw new Error(refreshFailure);
                          if (refreshed._tag === "Success") setTree(refreshed.value);
                        })
                      }
                    >
                      Save label
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {selectedEntry.preview ? (
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() => void copyText(selectedEntry.preview, "Preview")}
                      >
                        Copy preview
                      </Button>
                    ) : null}
                    {selectedEntry.editorText ? (
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() => void copyText(selectedEntry.editorText ?? "", "Editor text")}
                      >
                        Copy editor text
                      </Button>
                    ) : null}
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={summarize}
                      disabled={busy}
                      onChange={(event) => setSummarize(event.target.checked)}
                    />{" "}
                    Summarize abandoned branch
                  </label>
                  {summarize ? (
                    <Textarea
                      placeholder="Optional summary instructions"
                      value={instructions}
                      disabled={busy}
                      onChange={(event) => setInstructions(event.target.value)}
                    />
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}
          {props.command === "compact" ? (
            <>
              <p className="text-sm text-muted-foreground">
                Compact the current context. Optional instructions are appended to Pi's compaction
                prompt.
              </p>
              <Textarea
                placeholder="Optional compaction instructions"
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
              />
            </>
          ) : null}
          {props.command === "reload" ? <p>Reload the current Pi session?</p> : null}
          {props.command === "name" ? (
            <Input
              autoFocus
              placeholder="Session name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          ) : null}
          {(props.command === "session" || props.command === "stats") && session ? (
            <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg bg-muted p-3 text-xs">
              {JSON.stringify(session, null, 2)}
            </pre>
          ) : null}
          {props.command === "export" ? (
            <p>Export this session as a server-generated HTML file?</p>
          ) : null}
          {props.command === "quit" ? (
            <p>{window.desktopBridge?.quitApp ? "Quit d4?" : "Stop the current session?"}</p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          {summarizing ? (
            <Button
              variant="destructive"
              disabled={operation.abortInFlight}
              onClick={() =>
                void operationController.runAbort(() =>
                  reportOperation(async () => {
                    const result = await abortBranchSummary(input);
                    const failure = failureMessage(result, "Could not cancel branch summary.");
                    if (failure) throw new Error(failure);
                    setNotice("Branch summary cancellation requested.");
                  }),
                )
              }
            >
              {operation.abortInFlight ? "Cancelling…" : "Cancel summary"}
            </Button>
          ) : (
            <Button variant="outline" disabled={busy} onClick={props.onClose}>
              Close
            </Button>
          )}
          {props.command === "tree" && selectedEntry ? (
            <Button
              disabled={busy || summarizing}
              onClick={() =>
                void operationController.runPrimary(
                  summarize ? "tree-navigation-summary" : "tree-navigation",
                  () =>
                    reportOperation(async () => {
                      await requireIdle();
                      const result = await navigateTree({
                        environmentId: props.environmentId,
                        input: {
                          threadId: props.threadId,
                          targetId: selectedEntry.id,
                          summarize,
                          customInstructions: instructions.trim() || undefined,
                        },
                      });
                      const failure = failureMessage(
                        result,
                        "Could not navigate the session tree.",
                      );
                      if (failure) throw new Error(failure);
                      if (result._tag === "Success") {
                        if (result.value.cancelled) {
                          setNotice(
                            result.value.aborted
                              ? "Branch summary aborted."
                              : "Tree navigation cancelled.",
                          );
                          return;
                        }
                        applyTreeNavigationResult(result.value, {
                          restoreEditorText: props.onRestoreEditorText,
                          close: props.onClose,
                        });
                      }
                    }),
                )
              }
            >
              Navigate
            </Button>
          ) : null}
          {props.command === "compact" ? (
            <Button
              disabled={busy}
              onClick={() =>
                void runMutation(async () => {
                  const result = await compact({
                    environmentId: props.environmentId,
                    input: {
                      threadId: props.threadId,
                      customInstructions: instructions.trim() || undefined,
                    },
                  });
                  const failure = failureMessage(result, "Could not compact the session.");
                  if (failure) throw new Error(failure);
                  setNotice("Session compacted.");
                })
              }
            >
              Compact
            </Button>
          ) : null}
          {props.command === "reload" ? (
            <Button
              disabled={busy}
              onClick={() =>
                void runMutation(async () => {
                  const result = await reload(input);
                  const failure = failureMessage(result, "Could not reload the session.");
                  if (failure) throw new Error(failure);
                  props.onClose();
                })
              }
            >
              Reload
            </Button>
          ) : null}
          {props.command === "name" ? (
            <Button
              disabled={busy || !name.trim()}
              onClick={() =>
                void runMutation(async () => {
                  const result = await setSessionName({
                    environmentId: props.environmentId,
                    input: { threadId: props.threadId, name: name.trim() },
                  });
                  const failure = failureMessage(result, "Could not name the session.");
                  if (failure) throw new Error(failure);
                  props.onClose();
                })
              }
            >
              Save
            </Button>
          ) : null}
          {props.command === "export" ? (
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const result = await exportHtml(input);
                  const failure = failureMessage(result, "Could not export the session.");
                  if (failure) throw new Error(failure);
                  if (result._tag === "Success") {
                    if (preparedConnection._tag === "None") {
                      throw new Error("The environment connection is unavailable.");
                    }
                    downloadPiNativeHtmlExport(preparedConnection.value.httpBaseUrl, result.value);
                    setNotice(`Exported ${result.value.fileName}.`);
                  }
                })
              }
            >
              Export
            </Button>
          ) : null}
          {props.command === "quit" ? (
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await props.onQuit();
                  props.onClose();
                })
              }
            >
              {window.desktopBridge?.quitApp ? "Quit d4" : "Stop session"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
