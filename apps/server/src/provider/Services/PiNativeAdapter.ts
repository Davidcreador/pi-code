import type {
  PiNativeAuthFlow,
  PiNativeAuthFlowInput,
  PiNativeAuthResponseInput,
  PiNativeAuthState,
  PiNativeBeginAuthInput,
  PiNativeChangelogResult,
  PiNativeCompactInput,
  PiNativeCompactResult,
  PiNativeExportHtmlInput,
  PiNativeForkInput,
  PiNativeImportInput,
  PiNativeLastAssistantText,
  PiNativeLogoutInput,
  PiNativeNavigateTreeInput,
  PiNativeNavigateTreeResult,
  PiNativeResumeInput,
  PiNativeResumeSessionsResult,
  PiNativeScopedModelsResult,
  PiNativeSessionMutationResult,
  PiNativeSessionStateAndStats,
  PiNativeSessionTree,
  PiNativeSetEntryLabelInput,
  PiNativeSetSessionNameInput,
  PiNativeSetTrustInput,
  PiNativeSettingsInput,
  PiNativeSettingsResult,
  PiNativeShareInput,
  PiNativeShareResult,
  PiNativeTrustResult,
  PiNativeUpdateScopedModelsInput,
  PiNativeUpdateSettingsInput,
  ThreadId,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

import type { PiActiveTranscript } from "../piTranscript.ts";

export interface PiSessionHtmlExport {
  readonly canonicalPath: string;
  readonly fileName: string;
}

export interface PiNativeAdapterShape<TError> {
  readonly withSessionLock: <A, E, R>(
    threadId: ThreadId,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, TError | E, R>;
  readonly getSessionTree: (threadId: ThreadId) => Effect.Effect<PiNativeSessionTree, TError>;
  readonly getActiveTranscript: (threadId: ThreadId) => Effect.Effect<PiActiveTranscript, TError>;
  readonly navigateSessionTree: (
    input: PiNativeNavigateTreeInput,
  ) => Effect.Effect<PiNativeNavigateTreeResult, TError>;
  readonly abortBranchSummary: (threadId: ThreadId) => Effect.Effect<void, TError>;
  readonly setEntryLabel: (input: PiNativeSetEntryLabelInput) => Effect.Effect<void, TError>;
  readonly reloadResources: (threadId: ThreadId) => Effect.Effect<void, TError>;
  readonly compactSession: (
    input: PiNativeCompactInput,
  ) => Effect.Effect<PiNativeCompactResult, TError>;
  readonly getSessionStateAndStats: (
    threadId: ThreadId,
  ) => Effect.Effect<PiNativeSessionStateAndStats, TError>;
  readonly setSessionName: (input: PiNativeSetSessionNameInput) => Effect.Effect<void, TError>;
  readonly getLastAssistantText: (
    threadId: ThreadId,
  ) => Effect.Effect<PiNativeLastAssistantText, TError>;
  readonly exportSessionHtml: (
    input: PiNativeExportHtmlInput,
  ) => Effect.Effect<PiSessionHtmlExport, TError>;
  readonly getSettings: (
    input: PiNativeSettingsInput,
  ) => Effect.Effect<PiNativeSettingsResult, TError>;
  readonly updateSettings: (
    input: PiNativeUpdateSettingsInput,
  ) => Effect.Effect<PiNativeSettingsResult, TError>;
  readonly getScopedModels: (
    input: PiNativeSettingsInput,
  ) => Effect.Effect<PiNativeScopedModelsResult, TError>;
  readonly updateScopedModels: (
    input: PiNativeUpdateScopedModelsInput,
  ) => Effect.Effect<PiNativeScopedModelsResult, TError>;
  readonly listResumeSessions: (
    threadId: ThreadId,
  ) => Effect.Effect<PiNativeResumeSessionsResult, TError>;
  readonly resumeSession: (
    input: PiNativeResumeInput,
  ) => Effect.Effect<PiNativeSessionMutationResult, TError>;
  readonly importSession: (
    input: PiNativeImportInput,
  ) => Effect.Effect<PiNativeSessionMutationResult, TError>;
  readonly forkSession: (
    input: PiNativeForkInput,
  ) => Effect.Effect<PiNativeSessionMutationResult, TError>;
  readonly cloneSession: (
    threadId: ThreadId,
  ) => Effect.Effect<PiNativeSessionMutationResult, TError>;
  readonly getTrust: (threadId: ThreadId) => Effect.Effect<PiNativeTrustResult, TError>;
  readonly setTrust: (input: PiNativeSetTrustInput) => Effect.Effect<PiNativeTrustResult, TError>;
  readonly getChangelog: (threadId: ThreadId) => Effect.Effect<PiNativeChangelogResult, TError>;
  readonly getAuthState: (threadId: ThreadId) => Effect.Effect<PiNativeAuthState, TError>;
  readonly beginAuthLogin: (
    input: PiNativeBeginAuthInput,
  ) => Effect.Effect<PiNativeAuthFlow, TError>;
  readonly getAuthFlow: (input: PiNativeAuthFlowInput) => Effect.Effect<PiNativeAuthFlow, TError>;
  readonly respondAuthFlow: (
    input: PiNativeAuthResponseInput,
  ) => Effect.Effect<PiNativeAuthFlow, TError>;
  readonly cancelAuthFlow: (
    input: PiNativeAuthFlowInput,
  ) => Effect.Effect<PiNativeAuthFlow, TError>;
  readonly logoutAuth: (input: PiNativeLogoutInput) => Effect.Effect<void, TError>;
  readonly shareSession: (input: PiNativeShareInput) => Effect.Effect<PiNativeShareResult, TError>;
}
