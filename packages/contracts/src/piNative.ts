import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { IsoDateTime, NonNegativeInt, ThreadId } from "./baseSchemas.ts";

const OptionalString = Schema.optional(Schema.String);
export const PiNativeThreadInput = Schema.Struct({ threadId: ThreadId });
export type PiNativeThreadInput = typeof PiNativeThreadInput.Type;

export const PiNativeTreeEntryKind = Schema.Literals([
  "message",
  "thinking_level_change",
  "model_change",
  "compaction",
  "branch_summary",
  "custom",
  "custom_message",
  "label",
  "session_info",
]);
export type PiNativeTreeEntryKind = typeof PiNativeTreeEntryKind.Type;

export const PiNativeTreeEntry = Schema.Struct({
  id: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  childIds: Schema.Array(Schema.String),
  order: NonNegativeInt,
  kind: PiNativeTreeEntryKind,
  role: OptionalString,
  timestamp: IsoDateTime,
  label: OptionalString,
  preview: Schema.String,
  editorText: OptionalString,
});
export type PiNativeTreeEntry = typeof PiNativeTreeEntry.Type;

export const PiNativeSessionTree = Schema.Struct({
  entries: Schema.Array(PiNativeTreeEntry),
  leafId: Schema.NullOr(Schema.String),
});
export type PiNativeSessionTree = typeof PiNativeSessionTree.Type;

export const PiNativeNavigateTreeInput = Schema.Struct({
  threadId: ThreadId,
  targetId: Schema.String,
  summarize: Schema.optional(Schema.Boolean),
  customInstructions: OptionalString,
  replaceInstructions: Schema.optional(Schema.Boolean),
  label: OptionalString,
});
export type PiNativeNavigateTreeInput = typeof PiNativeNavigateTreeInput.Type;

export const PiNativeBranchSummary = Schema.Struct({
  id: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  timestamp: IsoDateTime,
  fromId: Schema.String,
  summary: Schema.String,
});
export type PiNativeBranchSummary = typeof PiNativeBranchSummary.Type;

export const PiNativeNavigateTreeResult = Schema.Struct({
  editorText: OptionalString,
  cancelled: Schema.Boolean,
  aborted: Schema.optional(Schema.Boolean),
  summaryEntry: Schema.optional(PiNativeBranchSummary),
  leafId: Schema.NullOr(Schema.String),
});
export type PiNativeNavigateTreeResult = typeof PiNativeNavigateTreeResult.Type;

export const PiNativeSetEntryLabelInput = Schema.Struct({
  threadId: ThreadId,
  targetId: Schema.String,
  label: OptionalString,
});
export type PiNativeSetEntryLabelInput = typeof PiNativeSetEntryLabelInput.Type;

export const PiNativeCompactInput = Schema.Struct({
  threadId: ThreadId,
  customInstructions: OptionalString,
});
export type PiNativeCompactInput = typeof PiNativeCompactInput.Type;

export const PiNativeCompactResult = Schema.Struct({
  summary: Schema.String,
  firstKeptEntryId: Schema.String,
  tokensBefore: Schema.Number,
  estimatedTokensAfter: Schema.optional(Schema.Number),
});
export type PiNativeCompactResult = typeof PiNativeCompactResult.Type;

export const PiNativeModel = Schema.Struct({
  provider: Schema.String,
  id: Schema.String,
});

export const PiNativeSessionState = Schema.Struct({
  model: Schema.optional(PiNativeModel),
  thinkingLevel: Schema.String,
  isStreaming: Schema.Boolean,
  isCompacting: Schema.Boolean,
  steeringMode: Schema.Literals(["all", "one-at-a-time"]),
  followUpMode: Schema.Literals(["all", "one-at-a-time"]),
  sessionId: Schema.String,
  sessionName: OptionalString,
  autoCompactionEnabled: Schema.Boolean,
  messageCount: NonNegativeInt,
  pendingMessageCount: NonNegativeInt,
});
export type PiNativeSessionState = typeof PiNativeSessionState.Type;

export const PiNativeTokenStats = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
  total: Schema.Number,
});

export const PiNativeContextUsage = Schema.Struct({
  tokens: Schema.NullOr(Schema.Number),
  contextWindow: Schema.Number,
  percent: Schema.NullOr(Schema.Number),
});

export const PiNativeSessionStats = Schema.Struct({
  sessionId: Schema.String,
  userMessages: NonNegativeInt,
  assistantMessages: NonNegativeInt,
  toolCalls: NonNegativeInt,
  toolResults: NonNegativeInt,
  totalMessages: NonNegativeInt,
  tokens: PiNativeTokenStats,
  cost: Schema.Number,
  contextUsage: Schema.optional(PiNativeContextUsage),
});
export type PiNativeSessionStats = typeof PiNativeSessionStats.Type;

export const PiNativeSessionStateAndStats = Schema.Struct({
  state: PiNativeSessionState,
  stats: PiNativeSessionStats,
});
export type PiNativeSessionStateAndStats = typeof PiNativeSessionStateAndStats.Type;

export const PiNativeSetSessionNameInput = Schema.Struct({
  threadId: ThreadId,
  name: Schema.String,
});
export type PiNativeSetSessionNameInput = typeof PiNativeSetSessionNameInput.Type;

export const PiNativeLastAssistantText = Schema.Struct({ text: Schema.NullOr(Schema.String) });
export type PiNativeLastAssistantText = typeof PiNativeLastAssistantText.Type;

export const PiNativeExportHtmlInput = Schema.Struct({
  threadId: ThreadId,
});
export type PiNativeExportHtmlInput = typeof PiNativeExportHtmlInput.Type;

export const PiNativeExportHtmlResult = Schema.Struct({
  handle: Schema.String,
  fileName: Schema.String,
  relativeUrl: Schema.String,
  expiresAt: Schema.Number,
});
export type PiNativeExportHtmlResult = typeof PiNativeExportHtmlResult.Type;

export const PiNativeSettingsScope = Schema.Literals(["global", "project"]);
export type PiNativeSettingsScope = typeof PiNativeSettingsScope.Type;

export const PiNativeSafeSettings = Schema.Struct({
  steeringMode: Schema.optional(Schema.Literals(["all", "one-at-a-time"])),
  followUpMode: Schema.optional(Schema.Literals(["all", "one-at-a-time"])),
  hideThinkingBlock: Schema.optional(Schema.Boolean),
  showCacheMissNotices: Schema.optional(Schema.Boolean),
  quietStartup: Schema.optional(Schema.Boolean),
  collapseChangelog: Schema.optional(Schema.Boolean),
  enableSkillCommands: Schema.optional(Schema.Boolean),
  doubleEscapeAction: Schema.optional(Schema.Literals(["fork", "tree", "none"])),
  treeFilterMode: Schema.optional(
    Schema.Literals(["default", "no-tools", "user-only", "labeled-only", "all"]),
  ),
  showHardwareCursor: Schema.optional(Schema.Boolean),
  editorPaddingX: Schema.optional(NonNegativeInt),
  outputPad: Schema.optional(Schema.Literals([0, 1])),
  autocompleteMaxVisible: Schema.optional(NonNegativeInt),
  showImages: Schema.optional(Schema.Boolean),
  imageWidthCells: Schema.optional(NonNegativeInt),
  clearOnShrink: Schema.optional(Schema.Boolean),
  showTerminalProgress: Schema.optional(Schema.Boolean),
  autoResizeImages: Schema.optional(Schema.Boolean),
  blockImages: Schema.optional(Schema.Boolean),
  anthropicExtraUsageWarning: Schema.optional(Schema.Boolean),
});
export type PiNativeSafeSettings = typeof PiNativeSafeSettings.Type;

export const PiNativeSettingsInput = Schema.Struct({
  threadId: ThreadId,
  scope: PiNativeSettingsScope,
});
export const PiNativeUpdateSettingsInput = Schema.Struct({
  threadId: ThreadId,
  scope: PiNativeSettingsScope,
  values: PiNativeSafeSettings,
});
export const PiNativeSettingsResult = Schema.Struct({
  scope: PiNativeSettingsScope,
  values: PiNativeSafeSettings,
});
export type PiNativeSettingsInput = typeof PiNativeSettingsInput.Type;
export type PiNativeUpdateSettingsInput = typeof PiNativeUpdateSettingsInput.Type;
export type PiNativeSettingsResult = typeof PiNativeSettingsResult.Type;

export const PiNativeScopedModelDiagnostic = Schema.Struct({
  type: Schema.Literal("warning"),
  code: Schema.Literals(["no-match", "invalid-thinking-level"]),
  message: Schema.String,
  pattern: Schema.String,
});
export const PiNativeScopedModel = Schema.Struct({
  provider: Schema.String,
  id: Schema.String,
  name: Schema.String,
  thinkingLevel: OptionalString,
});
export const PiNativeScopedModelsResult = Schema.Struct({
  scope: PiNativeSettingsScope,
  patterns: Schema.Array(Schema.String),
  models: Schema.Array(PiNativeScopedModel),
  diagnostics: Schema.Array(PiNativeScopedModelDiagnostic),
});
export const PiNativeUpdateScopedModelsInput = Schema.Struct({
  threadId: ThreadId,
  scope: PiNativeSettingsScope,
  patterns: Schema.Array(Schema.String),
});
export type PiNativeScopedModelsResult = typeof PiNativeScopedModelsResult.Type;
export type PiNativeUpdateScopedModelsInput = typeof PiNativeUpdateScopedModelsInput.Type;

export const PiNativeResumeSession = Schema.Struct({
  id: Schema.String,
  name: OptionalString,
  createdAt: IsoDateTime,
  modifiedAt: IsoDateTime,
  messageCount: NonNegativeInt,
  current: Schema.Boolean,
});
export const PiNativeResumeSessionsResult = Schema.Struct({
  sessions: Schema.Array(PiNativeResumeSession),
});
export type PiNativeResumeSessionsResult = typeof PiNativeResumeSessionsResult.Type;
export const PiNativeResumeInput = Schema.Struct({ threadId: ThreadId, sessionId: Schema.String });
export type PiNativeResumeInput = typeof PiNativeResumeInput.Type;

export const PiNativeSessionMutationResult = Schema.Struct({
  cancelled: Schema.Boolean,
  sessionId: Schema.String,
  editorText: OptionalString,
  model: Schema.optional(PiNativeModel),
  thinkingLevel: OptionalString,
});
export type PiNativeSessionMutationResult = typeof PiNativeSessionMutationResult.Type;

export const PI_NATIVE_IMPORT_MAX_BYTES = 1_048_576;
export const PI_NATIVE_IMPORT_MAX_LINES = 20_000;
export const PI_NATIVE_IMPORT_MAX_ENTRIES = 20_000;
export const PiNativeImportInput = Schema.Struct({
  threadId: ThreadId,
  filename: Schema.String,
  content: Schema.String,
});
export type PiNativeImportInput = typeof PiNativeImportInput.Type;
export const PiNativeForkInput = Schema.Struct({ threadId: ThreadId, targetId: Schema.String });
export type PiNativeForkInput = typeof PiNativeForkInput.Type;
export const PiNativeTrustResult = Schema.Struct({ decision: Schema.NullOr(Schema.Boolean) });
export type PiNativeTrustResult = typeof PiNativeTrustResult.Type;
export const PiNativeSetTrustInput = Schema.Struct({
  threadId: ThreadId,
  trusted: Schema.Boolean,
  confirmed: Schema.optional(Schema.Boolean),
});
export type PiNativeSetTrustInput = typeof PiNativeSetTrustInput.Type;
export const PiNativeChangelogEntry = Schema.Struct({
  version: Schema.String,
  markdown: Schema.String,
});
export const PiNativeChangelogResult = Schema.Struct({
  entries: Schema.Array(PiNativeChangelogEntry),
});
export type PiNativeChangelogResult = typeof PiNativeChangelogResult.Type;

export const PiNativeAuthType = Schema.Literals(["oauth", "api_key"]);
export type PiNativeAuthType = typeof PiNativeAuthType.Type;
export const PiNativeAuthProvider = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  methods: Schema.Array(PiNativeAuthType),
  configured: Schema.Boolean,
  storedCredential: Schema.Boolean,
  credentialType: Schema.optional(PiNativeAuthType),
});
export const PiNativeAuthState = Schema.Struct({
  providers: Schema.Array(PiNativeAuthProvider),
});
export type PiNativeAuthState = typeof PiNativeAuthState.Type;
export const PiNativeAuthPrompt = Schema.Struct({
  id: Schema.String,
  type: Schema.Literals(["text", "secret", "select", "manual_code"]),
  message: Schema.String,
  placeholder: OptionalString,
  options: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        label: Schema.String,
        description: OptionalString,
      }),
    ),
  ),
});
export const PiNativeAuthNotification = Schema.Union([
  Schema.Struct({ type: Schema.Literal("progress"), message: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("info"),
    message: Schema.String,
    links: Schema.optional(
      Schema.Array(Schema.Struct({ url: Schema.String, label: OptionalString })),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("auth_url"),
    url: Schema.String,
    instructions: OptionalString,
  }),
  Schema.Struct({
    type: Schema.Literal("device_code"),
    userCode: Schema.String,
    verificationUri: Schema.String,
    expiresInSeconds: Schema.optional(Schema.Number),
  }),
]);
export const PiNativeAuthFlow = Schema.Struct({
  flowId: Schema.String,
  providerId: Schema.String,
  authType: PiNativeAuthType,
  status: Schema.Literals(["running", "succeeded", "failed", "cancelled"]),
  notification: Schema.optional(PiNativeAuthNotification),
  prompt: Schema.optional(PiNativeAuthPrompt),
  error: OptionalString,
});
export type PiNativeAuthFlow = typeof PiNativeAuthFlow.Type;
export const PiNativeBeginAuthInput = Schema.Struct({
  threadId: ThreadId,
  providerId: Schema.String,
  authType: PiNativeAuthType,
});
export const PiNativeAuthFlowInput = Schema.Struct({
  threadId: ThreadId,
  flowId: Schema.String,
});
export const PiNativeAuthResponseInput = Schema.Struct({
  threadId: ThreadId,
  flowId: Schema.String,
  promptId: Schema.String,
  response: Schema.String,
});
export const PiNativeLogoutInput = Schema.Struct({
  threadId: ThreadId,
  providerId: Schema.String,
  confirmed: Schema.Boolean,
});
export type PiNativeBeginAuthInput = typeof PiNativeBeginAuthInput.Type;
export type PiNativeAuthFlowInput = typeof PiNativeAuthFlowInput.Type;
export type PiNativeAuthResponseInput = typeof PiNativeAuthResponseInput.Type;
export type PiNativeLogoutInput = typeof PiNativeLogoutInput.Type;

export const PiNativeShareInput = Schema.Struct({
  threadId: ThreadId,
  confirmed: Schema.Boolean,
});
export const PiNativeShareResult = Schema.Struct({
  url: Schema.String,
  gistUrl: Schema.String,
});
export type PiNativeShareInput = typeof PiNativeShareInput.Type;
export type PiNativeShareResult = typeof PiNativeShareResult.Type;

export class PiNativeError extends Schema.TaggedErrorClass<PiNativeError>()("PiNativeError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export const PI_NATIVE_WS_METHODS = {
  getTree: "piNative.getTree",
  navigateTree: "piNative.navigateTree",
  abortBranchSummary: "piNative.abortBranchSummary",
  setEntryLabel: "piNative.setEntryLabel",
  reload: "piNative.reload",
  compact: "piNative.compact",
  getStateAndStats: "piNative.getStateAndStats",
  setSessionName: "piNative.setSessionName",
  getLastAssistantText: "piNative.getLastAssistantText",
  exportHtml: "piNative.exportHtml",
  getSettings: "piNative.getSettings",
  updateSettings: "piNative.updateSettings",
  getScopedModels: "piNative.getScopedModels",
  updateScopedModels: "piNative.updateScopedModels",
  listResumeSessions: "piNative.listResumeSessions",
  resume: "piNative.resume",
  importSession: "piNative.import",
  fork: "piNative.fork",
  clone: "piNative.clone",
  getTrust: "piNative.getTrust",
  setTrust: "piNative.setTrust",
  getChangelog: "piNative.getChangelog",
  getAuthState: "piNative.getAuthState",
  beginAuthLogin: "piNative.beginAuthLogin",
  getAuthFlow: "piNative.getAuthFlow",
  respondAuthFlow: "piNative.respondAuthFlow",
  cancelAuthFlow: "piNative.cancelAuthFlow",
  logout: "piNative.logout",
  share: "piNative.share",
} as const;

const rpcError = Schema.Union([PiNativeError, EnvironmentAuthorizationError]);

export const PiNativeRpcs = {
  getTree: Rpc.make(PI_NATIVE_WS_METHODS.getTree, {
    payload: PiNativeThreadInput,
    success: PiNativeSessionTree,
    error: rpcError,
  }),
  navigateTree: Rpc.make(PI_NATIVE_WS_METHODS.navigateTree, {
    payload: PiNativeNavigateTreeInput,
    success: PiNativeNavigateTreeResult,
    error: rpcError,
  }),
  abortBranchSummary: Rpc.make(PI_NATIVE_WS_METHODS.abortBranchSummary, {
    payload: PiNativeThreadInput,
    error: rpcError,
  }),
  setEntryLabel: Rpc.make(PI_NATIVE_WS_METHODS.setEntryLabel, {
    payload: PiNativeSetEntryLabelInput,
    error: rpcError,
  }),
  reload: Rpc.make(PI_NATIVE_WS_METHODS.reload, { payload: PiNativeThreadInput, error: rpcError }),
  compact: Rpc.make(PI_NATIVE_WS_METHODS.compact, {
    payload: PiNativeCompactInput,
    success: PiNativeCompactResult,
    error: rpcError,
  }),
  getStateAndStats: Rpc.make(PI_NATIVE_WS_METHODS.getStateAndStats, {
    payload: PiNativeThreadInput,
    success: PiNativeSessionStateAndStats,
    error: rpcError,
  }),
  setSessionName: Rpc.make(PI_NATIVE_WS_METHODS.setSessionName, {
    payload: PiNativeSetSessionNameInput,
    error: rpcError,
  }),
  getLastAssistantText: Rpc.make(PI_NATIVE_WS_METHODS.getLastAssistantText, {
    payload: PiNativeThreadInput,
    success: PiNativeLastAssistantText,
    error: rpcError,
  }),
  exportHtml: Rpc.make(PI_NATIVE_WS_METHODS.exportHtml, {
    payload: PiNativeExportHtmlInput,
    success: PiNativeExportHtmlResult,
    error: rpcError,
  }),
  getSettings: Rpc.make(PI_NATIVE_WS_METHODS.getSettings, {
    payload: PiNativeSettingsInput,
    success: PiNativeSettingsResult,
    error: rpcError,
  }),
  updateSettings: Rpc.make(PI_NATIVE_WS_METHODS.updateSettings, {
    payload: PiNativeUpdateSettingsInput,
    success: PiNativeSettingsResult,
    error: rpcError,
  }),
  getScopedModels: Rpc.make(PI_NATIVE_WS_METHODS.getScopedModels, {
    payload: PiNativeSettingsInput,
    success: PiNativeScopedModelsResult,
    error: rpcError,
  }),
  updateScopedModels: Rpc.make(PI_NATIVE_WS_METHODS.updateScopedModels, {
    payload: PiNativeUpdateScopedModelsInput,
    success: PiNativeScopedModelsResult,
    error: rpcError,
  }),
  listResumeSessions: Rpc.make(PI_NATIVE_WS_METHODS.listResumeSessions, {
    payload: PiNativeThreadInput,
    success: PiNativeResumeSessionsResult,
    error: rpcError,
  }),
  resume: Rpc.make(PI_NATIVE_WS_METHODS.resume, {
    payload: PiNativeResumeInput,
    success: PiNativeSessionMutationResult,
    error: rpcError,
  }),
  importSession: Rpc.make(PI_NATIVE_WS_METHODS.importSession, {
    payload: PiNativeImportInput,
    success: PiNativeSessionMutationResult,
    error: rpcError,
  }),
  fork: Rpc.make(PI_NATIVE_WS_METHODS.fork, {
    payload: PiNativeForkInput,
    success: PiNativeSessionMutationResult,
    error: rpcError,
  }),
  clone: Rpc.make(PI_NATIVE_WS_METHODS.clone, {
    payload: PiNativeThreadInput,
    success: PiNativeSessionMutationResult,
    error: rpcError,
  }),
  getTrust: Rpc.make(PI_NATIVE_WS_METHODS.getTrust, {
    payload: PiNativeThreadInput,
    success: PiNativeTrustResult,
    error: rpcError,
  }),
  setTrust: Rpc.make(PI_NATIVE_WS_METHODS.setTrust, {
    payload: PiNativeSetTrustInput,
    success: PiNativeTrustResult,
    error: rpcError,
  }),
  getChangelog: Rpc.make(PI_NATIVE_WS_METHODS.getChangelog, {
    payload: PiNativeThreadInput,
    success: PiNativeChangelogResult,
    error: rpcError,
  }),
  getAuthState: Rpc.make(PI_NATIVE_WS_METHODS.getAuthState, {
    payload: PiNativeThreadInput,
    success: PiNativeAuthState,
    error: rpcError,
  }),
  beginAuthLogin: Rpc.make(PI_NATIVE_WS_METHODS.beginAuthLogin, {
    payload: PiNativeBeginAuthInput,
    success: PiNativeAuthFlow,
    error: rpcError,
  }),
  getAuthFlow: Rpc.make(PI_NATIVE_WS_METHODS.getAuthFlow, {
    payload: PiNativeAuthFlowInput,
    success: PiNativeAuthFlow,
    error: rpcError,
  }),
  respondAuthFlow: Rpc.make(PI_NATIVE_WS_METHODS.respondAuthFlow, {
    payload: PiNativeAuthResponseInput,
    success: PiNativeAuthFlow,
    error: rpcError,
  }),
  cancelAuthFlow: Rpc.make(PI_NATIVE_WS_METHODS.cancelAuthFlow, {
    payload: PiNativeAuthFlowInput,
    success: PiNativeAuthFlow,
    error: rpcError,
  }),
  logout: Rpc.make(PI_NATIVE_WS_METHODS.logout, {
    payload: PiNativeLogoutInput,
    error: rpcError,
  }),
  share: Rpc.make(PI_NATIVE_WS_METHODS.share, {
    payload: PiNativeShareInput,
    success: PiNativeShareResult,
    error: rpcError,
  }),
} as const;
