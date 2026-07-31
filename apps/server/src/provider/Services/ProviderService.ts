/**
 * ProviderService - Service interface for provider sessions, turns, and checkpoints.
 *
 * Acts as the cross-provider facade used by transports (WebSocket/RPC). It
 * resolves provider adapters through `ProviderAdapterRegistry`, routes
 * session-scoped calls via `ProviderSessionDirectory`, and exposes one unified
 * provider event stream to callers.
 *
 * Uses Effect `Context.Service` for dependency injection and returns typed
 * domain errors for validation, session, codex, and checkpoint workflows.
 *
 * @module ProviderService
 */
import type {
  PiNativeAuthFlow,
  PiNativeAuthFlowInput,
  PiNativeAuthResponseInput,
  PiNativeAuthState,
  PiNativeBeginAuthInput,
  PiNativeCompactInput,
  PiNativeCompactResult,
  PiNativeExportHtmlInput,
  PiNativeLastAssistantText,
  PiNativeLogoutInput,
  PiNativeForkInput,
  PiNativeImportInput,
  PiNativeNavigateTreeInput,
  PiNativeResumeInput,
  PiNativeResumeSessionsResult,
  PiNativeScopedModelsResult,
  PiNativeSessionMutationResult,
  PiNativeSetTrustInput,
  PiNativeSettingsInput,
  PiNativeSettingsResult,
  PiNativeShareInput,
  PiNativeShareResult,
  PiNativeTrustResult,
  PiNativeUpdateScopedModelsInput,
  PiNativeUpdateSettingsInput,
  PiNativeChangelogResult,
  PiNativeNavigateTreeResult,
  PiNativeSessionStateAndStats,
  PiNativeSessionTree,
  PiNativeSetEntryLabelInput,
  PiNativeSetSessionNameInput,
  ProviderInterruptTurnInput,
  ProviderInstanceId,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  ThreadId,
  ProviderTurnStartResult,
} from "@t3tools/contracts";
import type { PiSessionHtmlExport } from "./PiNativeAdapter.ts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import type { ProviderServiceError } from "../Errors.ts";
import type { PiActiveTranscript } from "../piTranscript.ts";
import type { ProviderAdapterCapabilities } from "./ProviderAdapter.ts";
import type { ProviderInstanceRoutingInfo } from "./ProviderAdapterRegistry.ts";

/**
 * ProviderServiceShape - Service API for provider session and turn orchestration.
 */
export interface ProviderServiceShape {
  /**
   * Start a provider session.
   */
  readonly startSession: (
    threadId: ThreadId,
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, ProviderServiceError>;

  /**
   * Send a provider turn.
   */
  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, ProviderServiceError>;

  /**
   * Interrupt a running provider turn.
   */
  readonly interruptTurn: (
    input: ProviderInterruptTurnInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Respond to a provider approval request.
   */
  readonly respondToRequest: (
    input: ProviderRespondToRequestInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Respond to a provider structured user-input request.
   */
  readonly respondToUserInput: (
    input: ProviderRespondToUserInputInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Stop a provider session.
   */
  readonly stopSession: (
    input: ProviderStopSessionInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * List active provider sessions.
   *
   * Aggregates runtime session lists from all registered adapters.
   */
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  /**
   * Read capabilities for the adapter bound to a configured provider instance.
   */
  readonly getCapabilities: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderAdapterCapabilities, ProviderServiceError>;

  readonly getInstanceInfo: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderInstanceRoutingInfo, ProviderServiceError>;

  /**
   * Roll back provider conversation state by a number of turns.
   */
  readonly rollbackConversation: (input: {
    readonly threadId: ThreadId;
    readonly numTurns: number;
  }) => Effect.Effect<void, ProviderServiceError>;

  readonly withPiSessionLock: <A, E, R>(
    threadId: ThreadId,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, ProviderServiceError | E, R>;
  readonly getPiSessionTree: (
    threadId: ThreadId,
  ) => Effect.Effect<PiNativeSessionTree, ProviderServiceError>;
  readonly getPiActiveTranscript: (
    threadId: ThreadId,
  ) => Effect.Effect<PiActiveTranscript, ProviderServiceError>;
  readonly navigatePiSessionTree: (
    input: PiNativeNavigateTreeInput,
  ) => Effect.Effect<PiNativeNavigateTreeResult, ProviderServiceError>;
  readonly abortPiBranchSummary: (threadId: ThreadId) => Effect.Effect<void, ProviderServiceError>;
  readonly setPiEntryLabel: (
    input: PiNativeSetEntryLabelInput,
  ) => Effect.Effect<void, ProviderServiceError>;
  readonly reloadPiResources: (threadId: ThreadId) => Effect.Effect<void, ProviderServiceError>;
  readonly compactPiSession: (
    input: PiNativeCompactInput,
  ) => Effect.Effect<PiNativeCompactResult, ProviderServiceError>;
  readonly getPiSessionStateAndStats: (
    threadId: ThreadId,
  ) => Effect.Effect<PiNativeSessionStateAndStats, ProviderServiceError>;
  readonly setPiSessionName: (
    input: PiNativeSetSessionNameInput,
  ) => Effect.Effect<void, ProviderServiceError>;
  readonly getPiLastAssistantText: (
    threadId: ThreadId,
  ) => Effect.Effect<PiNativeLastAssistantText, ProviderServiceError>;
  readonly exportPiSessionHtml: (
    input: PiNativeExportHtmlInput,
  ) => Effect.Effect<PiSessionHtmlExport, ProviderServiceError>;
  readonly getPiSettings: (
    input: PiNativeSettingsInput,
  ) => Effect.Effect<PiNativeSettingsResult, ProviderServiceError>;
  readonly updatePiSettings: (
    input: PiNativeUpdateSettingsInput,
  ) => Effect.Effect<PiNativeSettingsResult, ProviderServiceError>;
  readonly getPiScopedModels: (
    input: PiNativeSettingsInput,
  ) => Effect.Effect<PiNativeScopedModelsResult, ProviderServiceError>;
  readonly updatePiScopedModels: (
    input: PiNativeUpdateScopedModelsInput,
  ) => Effect.Effect<PiNativeScopedModelsResult, ProviderServiceError>;
  readonly listPiResumeSessions: (
    threadId: ThreadId,
  ) => Effect.Effect<PiNativeResumeSessionsResult, ProviderServiceError>;
  readonly resumePiSession: (
    input: PiNativeResumeInput,
  ) => Effect.Effect<PiNativeSessionMutationResult, ProviderServiceError>;
  readonly importPiSession: (
    input: PiNativeImportInput,
  ) => Effect.Effect<PiNativeSessionMutationResult, ProviderServiceError>;
  readonly forkPiSession: (
    input: PiNativeForkInput,
  ) => Effect.Effect<PiNativeSessionMutationResult, ProviderServiceError>;
  readonly clonePiSession: (
    threadId: ThreadId,
  ) => Effect.Effect<PiNativeSessionMutationResult, ProviderServiceError>;
  readonly getPiTrust: (
    threadId: ThreadId,
  ) => Effect.Effect<PiNativeTrustResult, ProviderServiceError>;
  readonly setPiTrust: (
    input: PiNativeSetTrustInput,
  ) => Effect.Effect<PiNativeTrustResult, ProviderServiceError>;
  readonly getPiChangelog: (
    threadId: ThreadId,
  ) => Effect.Effect<PiNativeChangelogResult, ProviderServiceError>;
  readonly getPiAuthState: (
    threadId: ThreadId,
  ) => Effect.Effect<PiNativeAuthState, ProviderServiceError>;
  readonly beginPiAuthLogin: (
    input: PiNativeBeginAuthInput,
  ) => Effect.Effect<PiNativeAuthFlow, ProviderServiceError>;
  readonly getPiAuthFlow: (
    input: PiNativeAuthFlowInput,
  ) => Effect.Effect<PiNativeAuthFlow, ProviderServiceError>;
  readonly respondPiAuthFlow: (
    input: PiNativeAuthResponseInput,
  ) => Effect.Effect<PiNativeAuthFlow, ProviderServiceError>;
  readonly cancelPiAuthFlow: (
    input: PiNativeAuthFlowInput,
  ) => Effect.Effect<PiNativeAuthFlow, ProviderServiceError>;
  readonly logoutPiAuth: (input: PiNativeLogoutInput) => Effect.Effect<void, ProviderServiceError>;
  readonly sharePiSession: (
    input: PiNativeShareInput,
  ) => Effect.Effect<PiNativeShareResult, ProviderServiceError>;

  /**
   * Canonical provider runtime event stream.
   *
   * Fan-out is owned by ProviderService (not by a standalone event-bus service).
   */
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}

/**
 * ProviderService - Service tag for provider orchestration.
 */
export class ProviderService extends Context.Service<ProviderService, ProviderServiceShape>()(
  "t3/provider/Services/ProviderService",
) {}
