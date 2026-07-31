import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as operations from "../operations/piNative.ts";
import { createEnvironmentCommand } from "./runtime.ts";

export function createPiNativeEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const command = <Input, A, Failure>(
    label: string,
    execute: (
      input: Input,
    ) => import("effect/Effect").Effect<
      A,
      Failure,
      import("../connection/supervisor.ts").EnvironmentSupervisor
    >,
  ) => createEnvironmentCommand(runtime, { label: `environment-data:pi-native:${label}`, execute });

  return {
    getTree: command("get-tree", operations.getTree),
    navigateTree: command("navigate-tree", operations.navigateTree),
    abortBranchSummary: command("abort-branch-summary", operations.abortBranchSummary),
    setEntryLabel: command("set-entry-label", operations.setEntryLabel),
    reload: command("reload", operations.reload),
    compact: command("compact", operations.compact),
    getStateAndStats: command("get-state-and-stats", operations.getStateAndStats),
    setSessionName: command("set-session-name", operations.setSessionName),
    getLastAssistantText: command("get-last-assistant-text", operations.getLastAssistantText),
    exportHtml: command("export-html", operations.exportHtml),
    getSettings: command("get-settings", operations.getSettings),
    updateSettings: command("update-settings", operations.updateSettings),
    getScopedModels: command("get-scoped-models", operations.getScopedModels),
    updateScopedModels: command("update-scoped-models", operations.updateScopedModels),
    listResumeSessions: command("list-resume-sessions", operations.listResumeSessions),
    resume: command("resume", operations.resume),
    importSession: command("import-session", operations.importSession),
    fork: command("fork", operations.fork),
    clone: command("clone", operations.clone),
    getTrust: command("get-trust", operations.getTrust),
    setTrust: command("set-trust", operations.setTrust),
    getChangelog: command("get-changelog", operations.getChangelog),
    getAuthState: command("get-auth-state", operations.getAuthState),
    beginAuthLogin: command("begin-auth-login", operations.beginAuthLogin),
    getAuthFlow: command("get-auth-flow", operations.getAuthFlow),
    respondAuthFlow: command("respond-auth-flow", operations.respondAuthFlow),
    cancelAuthFlow: command("cancel-auth-flow", operations.cancelAuthFlow),
    logout: command("logout", operations.logout),
    share: command("share", operations.share),
  };
}
