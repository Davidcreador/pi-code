import {
  PI_NATIVE_WS_METHODS,
  type PiNativeAuthFlowInput,
  type PiNativeAuthResponseInput,
  type PiNativeBeginAuthInput,
  type PiNativeCompactInput,
  type PiNativeExportHtmlInput,
  type PiNativeForkInput,
  type PiNativeImportInput,
  type PiNativeLogoutInput,
  type PiNativeNavigateTreeInput,
  type PiNativeResumeInput,
  type PiNativeSetEntryLabelInput,
  type PiNativeSetSessionNameInput,
  type PiNativeSetTrustInput,
  type PiNativeShareInput,
  type PiNativeSettingsInput,
  type PiNativeThreadInput,
  type PiNativeUpdateScopedModelsInput,
  type PiNativeUpdateSettingsInput,
} from "@t3tools/contracts";

import { request } from "../rpc/client.ts";

export const getTree = (input: PiNativeThreadInput) => request(PI_NATIVE_WS_METHODS.getTree, input);
export const navigateTree = (input: PiNativeNavigateTreeInput) =>
  request(PI_NATIVE_WS_METHODS.navigateTree, input);
export const abortBranchSummary = (input: PiNativeThreadInput) =>
  request(PI_NATIVE_WS_METHODS.abortBranchSummary, input);
export const setEntryLabel = (input: PiNativeSetEntryLabelInput) =>
  request(PI_NATIVE_WS_METHODS.setEntryLabel, input);
export const reload = (input: PiNativeThreadInput) => request(PI_NATIVE_WS_METHODS.reload, input);
export const compact = (input: PiNativeCompactInput) =>
  request(PI_NATIVE_WS_METHODS.compact, input);
export const getStateAndStats = (input: PiNativeThreadInput) =>
  request(PI_NATIVE_WS_METHODS.getStateAndStats, input);
export const setSessionName = (input: PiNativeSetSessionNameInput) =>
  request(PI_NATIVE_WS_METHODS.setSessionName, input);
export const getLastAssistantText = (input: PiNativeThreadInput) =>
  request(PI_NATIVE_WS_METHODS.getLastAssistantText, input);
export const exportHtml = (input: PiNativeExportHtmlInput) =>
  request(PI_NATIVE_WS_METHODS.exportHtml, input);
export const getSettings = (input: PiNativeSettingsInput) =>
  request(PI_NATIVE_WS_METHODS.getSettings, input);
export const updateSettings = (input: PiNativeUpdateSettingsInput) =>
  request(PI_NATIVE_WS_METHODS.updateSettings, input);
export const getScopedModels = (input: PiNativeSettingsInput) =>
  request(PI_NATIVE_WS_METHODS.getScopedModels, input);
export const updateScopedModels = (input: PiNativeUpdateScopedModelsInput) =>
  request(PI_NATIVE_WS_METHODS.updateScopedModels, input);
export const listResumeSessions = (input: PiNativeThreadInput) =>
  request(PI_NATIVE_WS_METHODS.listResumeSessions, input);
export const resume = (input: PiNativeResumeInput) => request(PI_NATIVE_WS_METHODS.resume, input);
export const importSession = (input: PiNativeImportInput) =>
  request(PI_NATIVE_WS_METHODS.importSession, input);
export const fork = (input: PiNativeForkInput) => request(PI_NATIVE_WS_METHODS.fork, input);
export const clone = (input: PiNativeThreadInput) => request(PI_NATIVE_WS_METHODS.clone, input);
export const getTrust = (input: PiNativeThreadInput) =>
  request(PI_NATIVE_WS_METHODS.getTrust, input);
export const setTrust = (input: PiNativeSetTrustInput) =>
  request(PI_NATIVE_WS_METHODS.setTrust, input);
export const getChangelog = (input: PiNativeThreadInput) =>
  request(PI_NATIVE_WS_METHODS.getChangelog, input);
export const getAuthState = (input: PiNativeThreadInput) =>
  request(PI_NATIVE_WS_METHODS.getAuthState, input);
export const beginAuthLogin = (input: PiNativeBeginAuthInput) =>
  request(PI_NATIVE_WS_METHODS.beginAuthLogin, input);
export const getAuthFlow = (input: PiNativeAuthFlowInput) =>
  request(PI_NATIVE_WS_METHODS.getAuthFlow, input);
export const respondAuthFlow = (input: PiNativeAuthResponseInput) =>
  request(PI_NATIVE_WS_METHODS.respondAuthFlow, input);
export const cancelAuthFlow = (input: PiNativeAuthFlowInput) =>
  request(PI_NATIVE_WS_METHODS.cancelAuthFlow, input);
export const logout = (input: PiNativeLogoutInput) => request(PI_NATIVE_WS_METHODS.logout, input);
export const share = (input: PiNativeShareInput) => request(PI_NATIVE_WS_METHODS.share, input);
