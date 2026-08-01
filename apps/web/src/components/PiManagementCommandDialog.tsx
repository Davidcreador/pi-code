import type {
  EnvironmentId,
  PiNativeAuthFlow,
  PiNativeAuthState,
  PiNativeAuthType,
  PiNativeResumeSessionsResult,
  PiNativeSafeSettings,
  PiNativeScopedModelsResult,
  PiNativeShareResult,
  PiNativeSettingsScope,
  PiNativeSessionTree,
  ThreadId,
} from "@t3tools/contracts";
import { PI_NATIVE_IMPORT_MAX_BYTES } from "@t3tools/contracts";
import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type * as Cause from "effect/Cause";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { PiManagementCommand } from "../nativeSlashCommands";
import { piNativeEnvironment } from "../state/piNative";
import { useAtomCommand } from "../state/use-atom-command";
import { writePiNativeClipboard } from "./PiNativeCommandDialog.logic";
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

type SettingKey = keyof PiNativeSafeSettings;

function formatScopedModelsSummary(result: PiNativeScopedModelsResult): string[] {
  return [
    ...result.models.map(
      (model) =>
        `${model.provider}/${model.id}${model.thinkingLevel ? ` (${model.thinkingLevel})` : ""}`,
    ),
    ...result.diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`),
  ];
}
type SettingSpec =
  | { readonly key: SettingKey; readonly label: string; readonly type: "boolean" }
  | { readonly key: SettingKey; readonly label: string; readonly type: "number" }
  | {
      readonly key: SettingKey;
      readonly label: string;
      readonly type: "select";
      readonly options: ReadonlyArray<string>;
    };

const SETTINGS: ReadonlyArray<SettingSpec> = [
  {
    key: "steeringMode",
    label: "Steering mode",
    type: "select",
    options: ["all", "one-at-a-time"],
  },
  {
    key: "followUpMode",
    label: "Follow-up mode",
    type: "select",
    options: ["all", "one-at-a-time"],
  },
  { key: "hideThinkingBlock", label: "Hide thinking blocks", type: "boolean" },
  { key: "showCacheMissNotices", label: "Show cache-miss notices", type: "boolean" },
  { key: "quietStartup", label: "Quiet startup", type: "boolean" },
  { key: "collapseChangelog", label: "Collapse changelog", type: "boolean" },
  { key: "enableSkillCommands", label: "Enable skill commands", type: "boolean" },
  {
    key: "doubleEscapeAction",
    label: "Double-Escape action",
    type: "select",
    options: ["fork", "tree", "none"],
  },
  {
    key: "treeFilterMode",
    label: "Tree filter",
    type: "select",
    options: ["default", "no-tools", "user-only", "labeled-only", "all"],
  },
  { key: "showHardwareCursor", label: "Show hardware cursor", type: "boolean" },
  { key: "editorPaddingX", label: "Editor horizontal padding", type: "number" },
  { key: "outputPad", label: "Output padding", type: "select", options: ["0", "1"] },
  { key: "autocompleteMaxVisible", label: "Autocomplete rows", type: "number" },
  { key: "showImages", label: "Show terminal images", type: "boolean" },
  { key: "imageWidthCells", label: "Image width in cells", type: "number" },
  { key: "clearOnShrink", label: "Clear images when terminal shrinks", type: "boolean" },
  { key: "showTerminalProgress", label: "Show terminal progress", type: "boolean" },
  { key: "autoResizeImages", label: "Resize images automatically", type: "boolean" },
  { key: "blockImages", label: "Block image inputs", type: "boolean" },
  { key: "anthropicExtraUsageWarning", label: "Anthropic extra-usage warning", type: "boolean" },
];

function failureMessage(
  result: { readonly _tag: string; readonly cause?: Cause.Cause<unknown> },
  fallback: string,
): string | null {
  if (result._tag !== "Failure" || result.cause === undefined) return null;
  const error = squashAtomCommandFailure({ cause: result.cause });
  return error instanceof Error ? error.message : fallback;
}

function safeHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

type PiAuthPollOutcome =
  | { readonly status: "success"; readonly flow: PiNativeAuthFlow }
  | { readonly status: "failure"; readonly message: string };

export async function pollPiAuthFlow<E>(
  request: () => Promise<AtomCommandResult<PiNativeAuthFlow, E>>,
): Promise<PiAuthPollOutcome> {
  try {
    const result = await request();
    const failure = failureMessage(result, "Could not read authentication progress.");
    if (failure) return { status: "failure", message: failure };
    if (result._tag === "Success") return { status: "success", flow: result.value };
    return { status: "failure", message: "Could not read authentication progress." };
  } catch (cause) {
    return {
      status: "failure",
      message: cause instanceof Error ? cause.message : "Could not read authentication progress.",
    };
  }
}

export function nextPiAuthPollFailureCount(
  failureCount: number,
  outcome: PiAuthPollOutcome,
): number {
  return outcome.status === "failure" ? failureCount + 1 : 0;
}

export function piAuthPollDelayMs(failureCount: number): number {
  if (failureCount === 0) return 500;
  return Math.min(1_000 * 2 ** (failureCount - 1), 10_000);
}

export function isPiAuthDialogDismissBlocked(
  flow: PiNativeAuthFlow | null,
  failureCount: number,
): boolean {
  return flow?.status === "running" && failureCount === 0;
}

export function PiManagementCommandDialog(props: {
  command: PiManagementCommand;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  onClose: () => void;
  onRestoreEditorText: (text: string) => void;
}) {
  const getSettings = useAtomCommand(piNativeEnvironment.getSettings, { reportFailure: false });
  const updateSettings = useAtomCommand(piNativeEnvironment.updateSettings, {
    reportFailure: false,
  });
  const getScopedModels = useAtomCommand(piNativeEnvironment.getScopedModels, {
    reportFailure: false,
  });
  const updateScopedModels = useAtomCommand(piNativeEnvironment.updateScopedModels, {
    reportFailure: false,
  });
  const listResumeSessions = useAtomCommand(piNativeEnvironment.listResumeSessions, {
    reportFailure: false,
  });
  const resume = useAtomCommand(piNativeEnvironment.resume, { reportFailure: false });
  const importSession = useAtomCommand(piNativeEnvironment.importSession, { reportFailure: false });
  const fork = useAtomCommand(piNativeEnvironment.fork, { reportFailure: false });
  const clone = useAtomCommand(piNativeEnvironment.clone, { reportFailure: false });
  const getTree = useAtomCommand(piNativeEnvironment.getTree, { reportFailure: false });
  const getTrust = useAtomCommand(piNativeEnvironment.getTrust, { reportFailure: false });
  const setTrust = useAtomCommand(piNativeEnvironment.setTrust, { reportFailure: false });
  const getChangelog = useAtomCommand(piNativeEnvironment.getChangelog, { reportFailure: false });
  const getAuthState = useAtomCommand(piNativeEnvironment.getAuthState, { reportFailure: false });
  const beginAuthLogin = useAtomCommand(piNativeEnvironment.beginAuthLogin, {
    reportFailure: false,
  });
  const getAuthFlow = useAtomCommand(piNativeEnvironment.getAuthFlow, { reportFailure: false });
  const respondAuthFlow = useAtomCommand(piNativeEnvironment.respondAuthFlow, {
    reportFailure: false,
  });
  const cancelAuthFlow = useAtomCommand(piNativeEnvironment.cancelAuthFlow, {
    reportFailure: false,
  });
  const logout = useAtomCommand(piNativeEnvironment.logout, { reportFailure: false });
  const share = useAtomCommand(piNativeEnvironment.share, { reportFailure: false });

  const [scope, setScope] = useState<PiNativeSettingsScope>("global");
  const [settings, setSettings] = useState<PiNativeSafeSettings>({});
  const [settingsPatch, setSettingsPatch] = useState<PiNativeSafeSettings>({});
  const [patterns, setPatterns] = useState("");
  const [modelSummary, setModelSummary] = useState<string[]>([]);
  const [sessions, setSessions] = useState<PiNativeResumeSessionsResult["sessions"]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [tree, setTree] = useState<PiNativeSessionTree | null>(null);
  const [forkTargetId, setForkTargetId] = useState<string | null>(null);
  const [trust, setTrustState] = useState<boolean | null>(null);
  const [changelog, setChangelog] = useState<ReadonlyArray<{ version: string; markdown: string }>>(
    [],
  );
  const [authState, setAuthState] = useState<PiNativeAuthState | null>(null);
  const [authFlow, setAuthFlow] = useState<PiNativeAuthFlow | null>(null);
  const [authPollFailureCount, setAuthPollFailureCount] = useState(0);
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [selectedAuthType, setSelectedAuthType] = useState<PiNativeAuthType | null>(null);
  const [authResponse, setAuthResponse] = useState("");
  const [shareResult, setShareResult] = useState<PiNativeShareResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const threadInput = useMemo(
    () => ({ environmentId: props.environmentId, input: { threadId: props.threadId } }),
    [props.environmentId, props.threadId],
  );

  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Pi operation failed.");
    } finally {
      setBusy(false);
    }
  }, []);

  const finishSessionMutation = useCallback(
    (result: { readonly cancelled: boolean; readonly editorText?: string | undefined }) => {
      if (result.cancelled) {
        setNotice("Session change cancelled.");
        return;
      }
      if (result.editorText !== undefined) props.onRestoreEditorText(result.editorText);
      props.onClose();
    },
    [props],
  );

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setNotice(null);
    setSettingsPatch({});

    const load = async () => {
      if (props.command === "settings") {
        const result = await getSettings({
          environmentId: props.environmentId,
          input: { threadId: props.threadId, scope },
        });
        const failure = failureMessage(result, "Could not load Pi settings.");
        if (failure) throw new Error(failure);
        if (!cancelled && result._tag === "Success") setSettings(result.value.values);
      } else if (props.command === "scoped-models") {
        const result = await getScopedModels({
          environmentId: props.environmentId,
          input: { threadId: props.threadId, scope },
        });
        const failure = failureMessage(result, "Could not load scoped models.");
        if (failure) throw new Error(failure);
        if (!cancelled && result._tag === "Success") {
          setPatterns(result.value.patterns.join("\n"));
          setModelSummary(formatScopedModelsSummary(result.value));
        }
      } else if (props.command === "resume") {
        const result = await listResumeSessions(threadInput);
        const failure = failureMessage(result, "Could not list Pi sessions.");
        if (failure) throw new Error(failure);
        if (!cancelled && result._tag === "Success") {
          setSessions(result.value.sessions);
          setSelectedSessionId(
            result.value.sessions.find((session) => session.current)?.id ??
              result.value.sessions[0]?.id ??
              null,
          );
        }
      } else if (props.command === "fork") {
        const result = await getTree(threadInput);
        const failure = failureMessage(result, "Could not load the session tree.");
        if (failure) throw new Error(failure);
        if (!cancelled && result._tag === "Success") {
          setTree(result.value);
          setForkTargetId(result.value.leafId);
        }
      } else if (props.command === "trust") {
        const result = await getTrust(threadInput);
        const failure = failureMessage(result, "Could not read project trust.");
        if (failure) throw new Error(failure);
        if (!cancelled && result._tag === "Success") setTrustState(result.value.decision);
      } else if (props.command === "changelog") {
        const result = await getChangelog(threadInput);
        const failure = failureMessage(result, "Could not load the Pi changelog.");
        if (failure) throw new Error(failure);
        if (!cancelled && result._tag === "Success") setChangelog(result.value.entries);
      } else if (props.command === "login" || props.command === "logout") {
        const result = await getAuthState(threadInput);
        const failure = failureMessage(result, "Could not load Pi authentication state.");
        if (failure) throw new Error(failure);
        if (!cancelled && result._tag === "Success") {
          setAuthState(result.value);
          const provider =
            props.command === "logout"
              ? result.value.providers.find((candidate) => candidate.storedCredential)
              : result.value.providers[0];
          setSelectedProviderId(provider?.id ?? null);
          setSelectedAuthType(provider?.methods[0] ?? null);
        }
      }
    };

    void load().catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load Pi data.");
    });
    return () => {
      cancelled = true;
    };
  }, [
    getAuthState,
    getChangelog,
    getScopedModels,
    getSettings,
    getTree,
    getTrust,
    listResumeSessions,
    props.command,
    props.environmentId,
    props.threadId,
    scope,
    threadInput,
  ]);

  useEffect(() => {
    if (!authFlow || authFlow.status !== "running") return;
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      void pollPiAuthFlow(() =>
        getAuthFlow({
          environmentId: props.environmentId,
          input: { threadId: props.threadId, flowId: authFlow.flowId },
        }),
      ).then((outcome) => {
        if (cancelled) return;
        if (outcome.status === "failure") {
          setError(outcome.message);
          setAuthPollFailureCount((count) => nextPiAuthPollFailureCount(count, outcome));
          return;
        }

        setAuthFlow(outcome.flow);
        setAuthPollFailureCount((count) => nextPiAuthPollFailureCount(count, outcome));
        setError(null);
        if (outcome.flow.status === "succeeded") setNotice("Authentication completed.");
        if (outcome.flow.status === "cancelled") setNotice("Authentication cancelled.");
        if (outcome.flow.status === "failed") {
          setError(outcome.flow.error ?? "Authentication failed.");
        }
      });
    }, piAuthPollDelayMs(authPollFailureCount));
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [authFlow, authPollFailureCount, getAuthFlow, props.environmentId, props.threadId]);

  useEffect(() => {
    setAuthResponse("");
  }, [authFlow?.prompt?.id]);

  const settingsValue = (key: SettingKey): PiNativeSafeSettings[SettingKey] =>
    settingsPatch[key] ?? settings[key];
  const setSetting = (key: SettingKey, value: PiNativeSafeSettings[SettingKey]) => {
    setSettingsPatch((current) => ({ ...current, [key]: value }));
  };
  const selectedProvider =
    authState?.providers.find((provider) => provider.id === selectedProviderId) ?? null;
  const authActive = authFlow?.status === "running";
  const authDismissBlocked = isPiAuthDialogDismissBlocked(authFlow, authPollFailureCount);
  const authNotificationUrl =
    authFlow?.notification?.type === "auth_url"
      ? safeHttpUrl(authFlow.notification.url)
      : authFlow?.notification?.type === "device_code"
        ? safeHttpUrl(authFlow.notification.verificationUri)
        : undefined;
  const sharedSessionUrl = shareResult ? safeHttpUrl(shareResult.url) : undefined;
  const sharedGistUrl = shareResult ? safeHttpUrl(shareResult.gistUrl) : undefined;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy && !authDismissBlocked) props.onClose();
      }}
    >
      <DialogPopup className="w-full max-w-2xl">
        <DialogHeader>
          <DialogTitle>/{props.command}</DialogTitle>
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

          {props.command === "settings" || props.command === "scoped-models" ? (
            <label className="block space-y-1 text-sm">
              <span>Scope</span>
              <select
                className="h-9 w-full rounded-md border bg-background px-3"
                value={scope}
                disabled={busy}
                onChange={(event) => setScope(event.target.value as PiNativeSettingsScope)}
              >
                <option value="global">Global</option>
                <option value="project">Current project</option>
              </select>
            </label>
          ) : null}

          {props.command === "settings" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {SETTINGS.map((setting) => {
                const value = settingsValue(setting.key);
                if (setting.type === "boolean") {
                  return (
                    <label key={setting.key} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={value === true}
                        disabled={busy}
                        onChange={(event) => setSetting(setting.key, event.target.checked)}
                      />
                      {setting.label}
                    </label>
                  );
                }
                if (setting.type === "number") {
                  return (
                    <label key={setting.key} className="space-y-1 text-sm">
                      <span>{setting.label}</span>
                      <Input
                        type="number"
                        min={0}
                        disabled={busy}
                        value={typeof value === "number" ? value : ""}
                        onChange={(event) => {
                          const parsed = Number.parseInt(event.target.value, 10);
                          if (Number.isFinite(parsed) && parsed >= 0)
                            setSetting(setting.key, parsed);
                        }}
                      />
                    </label>
                  );
                }
                return (
                  <label key={setting.key} className="space-y-1 text-sm">
                    <span>{setting.label}</span>
                    <select
                      className="h-9 w-full rounded-md border bg-background px-3"
                      value={value === undefined ? "" : String(value)}
                      disabled={busy}
                      onChange={(event) =>
                        setSetting(
                          setting.key,
                          (setting.key === "outputPad"
                            ? Number(event.target.value)
                            : event.target.value) as PiNativeSafeSettings[SettingKey],
                        )
                      }
                    >
                      <option value="" disabled>
                        Not set
                      </option>
                      {setting.options.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </label>
                );
              })}
            </div>
          ) : null}

          {props.command === "scoped-models" ? (
            <>
              <Textarea
                value={patterns}
                disabled={busy}
                placeholder="One model pattern per line"
                onChange={(event) => setPatterns(event.target.value)}
              />
              <pre className="max-h-52 overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-3 text-xs">
                {modelSummary.join("\n") || "No scoped models resolved."}
              </pre>
            </>
          ) : null}

          {props.command === "resume" ? (
            <div className="max-h-80 space-y-2 overflow-y-auto">
              {sessions.map((session) => (
                <label
                  key={session.id}
                  className="flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm"
                >
                  <input
                    type="radio"
                    name="pi-session"
                    checked={selectedSessionId === session.id}
                    onChange={() => setSelectedSessionId(session.id)}
                  />
                  <span>
                    <strong>
                      {session.name ?? "Unnamed session"}
                      {session.current ? " (current)" : ""}
                    </strong>
                    <span className="block text-muted-foreground">
                      {session.messageCount} messages ·{" "}
                      {new Date(session.modifiedAt).toLocaleString()}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          ) : null}

          {props.command === "import" ? (
            <label className="block space-y-2 text-sm">
              <span>Pi JSONL session (maximum 1 MiB)</span>
              <input
                type="file"
                accept=".jsonl,application/json,text/plain"
                disabled={busy}
                onChange={(event) => setImportFile(event.target.files?.[0] ?? null)}
              />
            </label>
          ) : null}

          {props.command === "fork" ? (
            <div className="max-h-80 space-y-1 overflow-y-auto">
              {tree?.entries.map((entry) => (
                <label
                  key={entry.id}
                  className="flex cursor-pointer gap-2 rounded-lg border p-3 text-sm"
                >
                  <input
                    type="radio"
                    name="pi-fork"
                    checked={forkTargetId === entry.id}
                    onChange={() => setForkTargetId(entry.id)}
                  />
                  <span>
                    <strong>{entry.label ?? entry.kind}</strong>
                    <span className="line-clamp-2 text-muted-foreground">{entry.preview}</span>
                  </span>
                </label>
              ))}
            </div>
          ) : null}

          {props.command === "clone" ? (
            <p className="text-sm">Clone the current Pi session into a new session?</p>
          ) : null}

          {props.command === "trust" ? (
            <div className="space-y-2 text-sm">
              <p>
                Current project trust:{" "}
                <strong>
                  {trust === null ? "not decided" : trust ? "trusted" : "not trusted"}
                </strong>
              </p>
              <p className="text-muted-foreground">
                Trusting a project allows its Pi extensions, skills, prompts, and other project
                resources to run.
              </p>
            </div>
          ) : null}

          {props.command === "changelog" ? (
            <div className="max-h-[55vh] space-y-4 overflow-y-auto">
              {changelog.map((entry) => (
                <section key={entry.version} className="space-y-2">
                  <h3 className="font-semibold">{entry.version}</h3>
                  <pre className="whitespace-pre-wrap rounded-lg bg-muted p-3 text-xs">
                    {entry.markdown}
                  </pre>
                </section>
              ))}
            </div>
          ) : null}

          {props.command === "login" || props.command === "logout" ? (
            <div className="space-y-4">
              <label className="block space-y-1 text-sm">
                <span>Provider</span>
                <select
                  className="h-9 w-full rounded-md border bg-background px-3"
                  value={selectedProviderId ?? ""}
                  disabled={busy || authFlow?.status === "running"}
                  onChange={(event) => {
                    const provider = authState?.providers.find(
                      (candidate) => candidate.id === event.target.value,
                    );
                    setSelectedProviderId(provider?.id ?? null);
                    setSelectedAuthType(provider?.methods[0] ?? null);
                  }}
                >
                  <option value="" disabled>
                    Select a provider
                  </option>
                  {authState?.providers
                    .filter((provider) => props.command === "login" || provider.storedCredential)
                    .map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.name}
                        {provider.configured ? " · configured" : ""}
                      </option>
                    ))}
                </select>
              </label>
              {props.command === "login" && selectedProvider ? (
                <label className="block space-y-1 text-sm">
                  <span>Authentication method</span>
                  <select
                    className="h-9 w-full rounded-md border bg-background px-3"
                    value={selectedAuthType ?? ""}
                    disabled={busy || authFlow?.status === "running"}
                    onChange={(event) =>
                      setSelectedAuthType(event.target.value as PiNativeAuthType)
                    }
                  >
                    {selectedProvider.methods.map((method) => (
                      <option key={method} value={method}>
                        {method === "oauth" ? "Account / OAuth" : "API key"}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {authFlow?.notification ? (
                <div className="rounded-lg bg-muted p-3 text-sm" role="status">
                  {authFlow.notification.type === "auth_url" ? (
                    <>
                      <p>{authFlow.notification.instructions ?? "Open the sign-in page."}</p>
                      {authNotificationUrl ? (
                        <a
                          className="text-primary underline"
                          href={authNotificationUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open sign-in page
                        </a>
                      ) : null}
                    </>
                  ) : authFlow.notification.type === "device_code" ? (
                    <>
                      <p>
                        Code: <strong>{authFlow.notification.userCode}</strong>
                      </p>
                      {authNotificationUrl ? (
                        <a
                          className="text-primary underline"
                          href={authNotificationUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open verification page
                        </a>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <p>{authFlow.notification.message}</p>
                      {authFlow.notification.type === "info"
                        ? authFlow.notification.links?.map((link) => {
                            const url = safeHttpUrl(link.url);
                            return url ? (
                              <a
                                key={url}
                                className="block text-primary underline"
                                href={url}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {link.label ?? url}
                              </a>
                            ) : null;
                          })
                        : null}
                    </>
                  )}
                </div>
              ) : null}
              {authFlow?.prompt ? (
                <div className="space-y-2">
                  <label className="block space-y-1 text-sm">
                    <span>{authFlow.prompt.message}</span>
                    {authFlow.prompt.type === "select" ? (
                      <select
                        className="h-9 w-full rounded-md border bg-background px-3"
                        value={authResponse}
                        onChange={(event) => setAuthResponse(event.target.value)}
                      >
                        <option value="" disabled>
                          Select an option
                        </option>
                        {authFlow.prompt.options?.map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <Input
                        type={authFlow.prompt.type === "secret" ? "password" : "text"}
                        autoComplete="off"
                        value={authResponse}
                        placeholder={authFlow.prompt.placeholder}
                        onChange={(event) => setAuthResponse(event.target.value)}
                      />
                    )}
                  </label>
                </div>
              ) : null}
              {props.command === "logout" ? (
                <p className="text-sm text-muted-foreground">
                  This removes only the credential saved by Pi. Environment variables and model
                  configuration remain unchanged.
                </p>
              ) : null}
            </div>
          ) : null}

          {props.command === "share" ? (
            <div className="space-y-3 text-sm">
              <p className="rounded-lg bg-destructive/10 p-3 text-destructive">
                This uploads the full session, including prompts and tool output, to a secret GitHub
                gist. Secret gists are unlisted, but anyone with the URL can read them.
              </p>
              <p className="text-muted-foreground">
                The GitHub CLI must be installed and signed in. The exported file is deleted from
                this computer after upload.
              </p>
              {sharedSessionUrl && sharedGistUrl ? (
                <div className="space-y-1 rounded-lg bg-muted p-3">
                  <a
                    className="block text-primary underline"
                    href={sharedSessionUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open shared session
                  </a>
                  <a
                    className="block text-primary underline"
                    href={sharedGistUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open source gist
                  </a>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await writePiNativeClipboard(sharedSessionUrl);
                        setNotice("Share URL copied.");
                      })
                    }
                  >
                    Copy share URL
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy || authDismissBlocked} onClick={props.onClose}>
            Close
          </Button>

          {props.command === "settings" ? (
            <Button
              disabled={busy || Object.keys(settingsPatch).length === 0}
              onClick={() =>
                void run(async () => {
                  const result = await updateSettings({
                    environmentId: props.environmentId,
                    input: { threadId: props.threadId, scope, values: settingsPatch },
                  });
                  const failure = failureMessage(result, "Could not save Pi settings.");
                  if (failure) throw new Error(failure);
                  if (result._tag === "Success") {
                    setSettings(result.value.values);
                    setSettingsPatch({});
                    setNotice("Pi settings saved.");
                  }
                })
              }
            >
              Save settings
            </Button>
          ) : null}

          {props.command === "scoped-models" ? (
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const result = await updateScopedModels({
                    environmentId: props.environmentId,
                    input: {
                      threadId: props.threadId,
                      scope,
                      patterns: patterns
                        .split("\n")
                        .map((value) => value.trim())
                        .filter(Boolean),
                    },
                  });
                  const failure = failureMessage(result, "Could not save scoped models.");
                  if (failure) throw new Error(failure);
                  if (result._tag === "Success") {
                    setPatterns(result.value.patterns.join("\n"));
                    setModelSummary(formatScopedModelsSummary(result.value));
                    setNotice("Scoped models saved.");
                  }
                })
              }
            >
              Save model scope
            </Button>
          ) : null}

          {props.command === "resume" ? (
            <Button
              disabled={
                busy ||
                selectedSessionId === null ||
                sessions.find((session) => session.id === selectedSessionId)?.current === true
              }
              onClick={() =>
                void run(async () => {
                  if (!selectedSessionId) return;
                  const result = await resume({
                    environmentId: props.environmentId,
                    input: { threadId: props.threadId, sessionId: selectedSessionId },
                  });
                  const failure = failureMessage(result, "Could not resume the Pi session.");
                  if (failure) throw new Error(failure);
                  if (result._tag === "Success") finishSessionMutation(result.value);
                })
              }
            >
              Resume
            </Button>
          ) : null}

          {props.command === "import" ? (
            <Button
              disabled={busy || importFile === null}
              onClick={() =>
                void run(async () => {
                  if (!importFile) return;
                  if (importFile.size > PI_NATIVE_IMPORT_MAX_BYTES)
                    throw new Error("The session file exceeds 1 MiB.");
                  const content = await importFile.text();
                  const result = await importSession({
                    environmentId: props.environmentId,
                    input: { threadId: props.threadId, filename: importFile.name, content },
                  });
                  const failure = failureMessage(result, "Could not import the Pi session.");
                  if (failure) throw new Error(failure);
                  if (result._tag === "Success") finishSessionMutation(result.value);
                })
              }
            >
              Import
            </Button>
          ) : null}

          {props.command === "fork" ? (
            <Button
              disabled={busy || forkTargetId === null}
              onClick={() =>
                void run(async () => {
                  if (!forkTargetId) return;
                  const result = await fork({
                    environmentId: props.environmentId,
                    input: { threadId: props.threadId, targetId: forkTargetId },
                  });
                  const failure = failureMessage(result, "Could not fork the Pi session.");
                  if (failure) throw new Error(failure);
                  if (result._tag === "Success") finishSessionMutation(result.value);
                })
              }
            >
              Fork
            </Button>
          ) : null}

          {props.command === "clone" ? (
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const result = await clone(threadInput);
                  const failure = failureMessage(result, "Could not clone the Pi session.");
                  if (failure) throw new Error(failure);
                  if (result._tag === "Success") finishSessionMutation(result.value);
                })
              }
            >
              Clone
            </Button>
          ) : null}

          {props.command === "trust" ? (
            <>
              <Button
                variant="outline"
                disabled={busy || trust === false}
                onClick={() =>
                  void run(async () => {
                    const result = await setTrust({
                      environmentId: props.environmentId,
                      input: { threadId: props.threadId, trusted: false },
                    });
                    const failure = failureMessage(result, "Could not update project trust.");
                    if (failure) throw new Error(failure);
                    if (result._tag === "Success") setTrustState(result.value.decision);
                  })
                }
              >
                Do not trust
              </Button>
              <Button
                disabled={busy || trust === true}
                onClick={() =>
                  void run(async () => {
                    const result = await setTrust({
                      environmentId: props.environmentId,
                      input: { threadId: props.threadId, trusted: true, confirmed: true },
                    });
                    const failure = failureMessage(result, "Could not update project trust.");
                    if (failure) throw new Error(failure);
                    if (result._tag === "Success") setTrustState(result.value.decision);
                  })
                }
              >
                Trust project
              </Button>
            </>
          ) : null}

          {props.command === "login" && !authActive ? (
            <Button
              disabled={
                busy || !selectedProviderId || !selectedAuthType || authFlow?.status === "succeeded"
              }
              onClick={() =>
                void run(async () => {
                  if (!selectedProviderId || !selectedAuthType) return;
                  const result = await beginAuthLogin({
                    environmentId: props.environmentId,
                    input: {
                      threadId: props.threadId,
                      providerId: selectedProviderId,
                      authType: selectedAuthType,
                    },
                  });
                  const failure = failureMessage(result, "Could not start authentication.");
                  if (failure) throw new Error(failure);
                  if (result._tag === "Success") {
                    setAuthFlow(result.value);
                    setAuthPollFailureCount(0);
                  }
                })
              }
            >
              Sign in
            </Button>
          ) : null}

          {props.command === "login" && authFlow?.prompt ? (
            <Button
              disabled={busy || !authResponse}
              onClick={() =>
                void run(async () => {
                  const result = await respondAuthFlow({
                    environmentId: props.environmentId,
                    input: {
                      threadId: props.threadId,
                      flowId: authFlow.flowId,
                      promptId: authFlow.prompt!.id,
                      response: authResponse,
                    },
                  });
                  setAuthResponse("");
                  const failure = failureMessage(result, "Could not answer authentication prompt.");
                  if (failure) throw new Error(failure);
                  if (result._tag === "Success") {
                    setAuthFlow(result.value);
                    setAuthPollFailureCount(0);
                  }
                })
              }
            >
              Continue
            </Button>
          ) : null}

          {props.command === "login" && authActive ? (
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const result = await cancelAuthFlow({
                    environmentId: props.environmentId,
                    input: { threadId: props.threadId, flowId: authFlow.flowId },
                  });
                  const failure = failureMessage(result, "Could not cancel authentication.");
                  if (failure) throw new Error(failure);
                  if (result._tag === "Success") {
                    setAuthFlow(result.value);
                    setAuthPollFailureCount(0);
                  }
                })
              }
            >
              Cancel sign-in
            </Button>
          ) : null}

          {props.command === "logout" ? (
            <Button
              variant="destructive"
              disabled={busy || !selectedProviderId}
              onClick={() =>
                void run(async () => {
                  if (!selectedProviderId) return;
                  const result = await logout({
                    environmentId: props.environmentId,
                    input: {
                      threadId: props.threadId,
                      providerId: selectedProviderId,
                      confirmed: true,
                    },
                  });
                  const failure = failureMessage(result, "Could not remove the stored credential.");
                  if (failure) throw new Error(failure);
                  setNotice("Stored credential removed.");
                  setSelectedProviderId(null);
                })
              }
            >
              Remove credential
            </Button>
          ) : null}

          {props.command === "share" ? (
            <Button
              disabled={busy || shareResult !== null}
              onClick={() =>
                void run(async () => {
                  const result = await share({
                    environmentId: props.environmentId,
                    input: { threadId: props.threadId, confirmed: true },
                  });
                  const failure = failureMessage(result, "Could not share the Pi session.");
                  if (failure) throw new Error(failure);
                  if (result._tag === "Success") {
                    setShareResult(result.value);
                    setNotice("Secret gist created.");
                  }
                })
              }
            >
              Create secret gist
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
