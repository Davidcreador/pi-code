import {
  DesktopUpdateChannelSchema,
  type DesktopRuntimeInfo,
  type DesktopUpdateActionResult,
  type DesktopUpdateChannel,
  type DesktopUpdateCheckResult,
  type DesktopUpdateState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import { normalizeDesktopUpdateReleaseNotes } from "./releaseNotes.ts";
import { resolveDefaultDesktopUpdateChannel } from "./updateChannels.ts";
import {
  createInitialDesktopUpdateState,
  reduceDesktopUpdateStateOnCheckFailure,
  reduceDesktopUpdateStateOnCheckStart,
  reduceDesktopUpdateStateOnDownloadComplete,
  reduceDesktopUpdateStateOnDownloadFailure,
  reduceDesktopUpdateStateOnDownloadProgress,
  reduceDesktopUpdateStateOnDownloadStart,
  reduceDesktopUpdateStateOnInstallFailure,
  reduceDesktopUpdateStateOnNoUpdate,
  reduceDesktopUpdateStateOnUpdateAvailable,
} from "./updateMachine.ts";

const AUTO_UPDATE_STARTUP_DELAY = "15 seconds";
const AUTO_UPDATE_POLL_INTERVAL = "4 minutes";

const AppUpdateYmlConfig = Schema.Record(Schema.String, Schema.String);
type AppUpdateYmlConfig = typeof AppUpdateYmlConfig.Type;

const UpdateInfo = Schema.Struct({
  version: Schema.String,
  // Left unvalidated on purpose: a malformed release-notes payload must never
  // fail the decode and block the update state transition. The shape is
  // validated defensively in normalizeDesktopUpdateReleaseNotes.
  releaseNotes: Schema.optional(Schema.Unknown),
});

const DownloadProgressInfo = Schema.Struct({
  percent: Schema.Number,
});
const decodeAppUpdateYmlConfig = Schema.decodeUnknownEffect(AppUpdateYmlConfig);
const decodeUpdateInfo = Schema.decodeUnknownEffect(UpdateInfo);
const decodeDownloadProgressInfo = Schema.decodeUnknownEffect(DownloadProgressInfo);

const currentIsoTimestamp = DateTime.now.pipe(Effect.map(DateTime.formatIso));

export class DesktopUpdateActionInProgressError extends Schema.TaggedErrorClass<DesktopUpdateActionInProgressError>()(
  "DesktopUpdateActionInProgressError",
  {
    action: Schema.Literals(["check", "download", "install"]),
    requestedChannel: DesktopUpdateChannelSchema,
  },
) {
  override get message(): string {
    return `Cannot change the desktop update channel to ${this.requestedChannel} while an update ${this.action} action is in progress.`;
  }
}

export class DesktopUpdateChannelPersistenceError extends Schema.TaggedErrorClass<DesktopUpdateChannelPersistenceError>()(
  "DesktopUpdateChannelPersistenceError",
  {
    channel: DesktopUpdateChannelSchema,
    cause: Schema.instanceOf(DesktopAppSettings.DesktopSettingsWriteError),
  },
) {
  override get message(): string {
    return `Failed to persist the ${this.channel} desktop update channel.`;
  }
}

export class DesktopUpdatePollerError extends Schema.TaggedErrorClass<DesktopUpdatePollerError>()(
  "DesktopUpdatePollerError",
  {
    poller: Schema.Literals(["startup", "poll"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop update ${this.poller} poller failed.`;
  }
}

export class DesktopUpdateEventHandlingError extends Schema.TaggedErrorClass<DesktopUpdateEventHandlingError>()(
  "DesktopUpdateEventHandlingError",
  {
    event: Schema.Literals(["update-available", "download-progress", "update-downloaded"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to handle desktop update ${this.event} event.`;
  }
}

export class DesktopUpdaterReportedError extends Schema.TaggedErrorClass<DesktopUpdaterReportedError>()(
  "DesktopUpdaterReportedError",
  {
    operation: Schema.Literals(["check", "download", "install", "background"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop updater ${this.operation} operation reported an error.`;
  }
}

export class DesktopUpdateUnexpectedActionError extends Schema.TaggedErrorClass<DesktopUpdateUnexpectedActionError>()(
  "DesktopUpdateUnexpectedActionError",
  {
    action: Schema.Literals(["download", "install"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop update ${this.action} action failed unexpectedly.`;
  }
}

export type DesktopUpdateConfigureError = never;

export const DesktopUpdateSetChannelError = Schema.Union([
  DesktopUpdateActionInProgressError,
  DesktopUpdateChannelPersistenceError,
]);
export type DesktopUpdateSetChannelError = typeof DesktopUpdateSetChannelError.Type;
export const isDesktopUpdateSetChannelError = Schema.is(DesktopUpdateSetChannelError);

export class DesktopUpdates extends Context.Service<
  DesktopUpdates,
  {
    readonly getState: Effect.Effect<DesktopUpdateState>;
    readonly emitState: Effect.Effect<void>;
    readonly disabledReason: Effect.Effect<Option.Option<string>>;
    readonly configure: Effect.Effect<void, DesktopUpdateConfigureError, Scope.Scope>;
    readonly setChannel: (
      channel: DesktopUpdateChannel,
    ) => Effect.Effect<DesktopUpdateState, DesktopUpdateSetChannelError>;
    readonly check: (reason: string) => Effect.Effect<DesktopUpdateCheckResult>;
    readonly download: Effect.Effect<DesktopUpdateActionResult>;
    readonly install: Effect.Effect<DesktopUpdateActionResult>;
  }
>()("@t3tools/desktop/updates/DesktopUpdates") {}

const {
  logInfo: logUpdaterInfo,
  logWarning: logUpdaterWarning,
  logError: logUpdaterError,
} = DesktopObservability.makeComponentLogger("desktop-updater");

function parseAppUpdateYml(raw: string): Effect.Effect<Option.Option<AppUpdateYmlConfig>> {
  const entries: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const match = line.match(/^(\w+):\s*(.+)$/);
    if (match?.[1] && match[2]) {
      entries[match[1]] = match[2].trim();
    }
  }

  return decodeAppUpdateYmlConfig(entries).pipe(
    Effect.map((config) => (config.provider ? Option.some(config) : Option.none())),
    Effect.orElseSucceed(() => Option.none<AppUpdateYmlConfig>()),
  );
}

function createBaseUpdateState(
  channel: DesktopUpdateChannel,
  enabled: boolean,
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
): DesktopUpdateState {
  return {
    ...createInitialDesktopUpdateState(environment.appVersion, environment.runtimeInfo, channel),
    enabled,
    status: enabled ? "idle" : "disabled",
  };
}

function getCanRetryFromState(state: DesktopUpdateState): boolean {
  return state.availableVersion !== null || state.downloadedVersion !== null;
}

function isFailedInstallState(state: DesktopUpdateState): boolean {
  return (
    state.status === "downloaded" &&
    state.errorContext === "install" &&
    typeof state.message === "string" &&
    state.message.trim().length > 0
  );
}

function shouldBroadcastDownloadProgress(
  currentState: DesktopUpdateState,
  nextPercent: number,
): boolean {
  if (currentState.status !== "downloading") {
    return true;
  }

  const currentPercent = currentState.downloadPercent;
  if (currentPercent === null) {
    return true;
  }

  const previousStep = Math.floor(currentPercent / 10);
  const nextStep = Math.floor(nextPercent / 10);
  return nextStep !== previousStep || nextPercent === 100;
}

function getAutoUpdateDisabledReason(args: {
  isDevelopment: boolean;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  appImage?: string | undefined;
  disabledByEnv: boolean;
  hasUpdateFeedConfig: boolean;
}): string | null {
  if (!args.hasUpdateFeedConfig) {
    return "Automatic updates are not available because no update feed is configured.";
  }
  if (args.isDevelopment || !args.isPackaged) {
    return "Automatic updates are only available in packaged production builds.";
  }
  if (args.disabledByEnv) {
    return "Automatic updates are disabled by the T3CODE_DISABLE_AUTO_UPDATE setting.";
  }
  if (args.platform === "linux" && !args.appImage) {
    return "Automatic updates on Linux require running the AppImage build.";
  }
  return null;
}

function isArm64HostRunningIntelBuild(runtimeInfo: DesktopRuntimeInfo): boolean {
  return runtimeInfo.hostArch === "arm64" && runtimeInfo.appArch === "x64";
}

export const make = Effect.gen(function* () {
  const config = yield* DesktopConfig.DesktopConfig;
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const desktopState = yield* DesktopState.DesktopState;
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const electronUpdater = yield* ElectronUpdater.ElectronUpdater;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;

  const stateTransitionSemaphore = yield* Semaphore.make(1);
  const installFailureSemaphore = yield* Semaphore.make(1);
  const appUpdateYmlConfigRef = yield* Ref.make<Option.Option<AppUpdateYmlConfig>>(Option.none());
  const updateCheckInFlightRef = yield* Ref.make(false);
  const updateDownloadInFlightRef = yield* Ref.make(false);
  const updateInstallInFlightRef = yield* Ref.make(false);
  const installFailureClaimedRef = yield* Ref.make(false);
  const updaterConfiguredRef = yield* Ref.make(false);
  const lastLoggedDownloadMilestoneRef = yield* Ref.make(-1);
  const updateStateRef = yield* Ref.make<DesktopUpdateState>(
    createInitialDesktopUpdateState(
      environment.appVersion,
      environment.runtimeInfo,
      environment.defaultDesktopSettings.updateChannel,
    ),
  );

  const broadcastState = (state: DesktopUpdateState): Effect.Effect<void> =>
    electronWindow.sendAll(IpcChannels.UPDATE_STATE_CHANNEL, state);

  const emitState = stateTransitionSemaphore.withPermits(1)(
    Ref.get(updateStateRef).pipe(Effect.flatMap(broadcastState)),
  );

  const replaceState = (state: DesktopUpdateState): Effect.Effect<void> =>
    stateTransitionSemaphore.withPermits(1)(
      Ref.set(updateStateRef, state).pipe(Effect.andThen(broadcastState(state))),
    );

  const updateState = (
    f: (state: DesktopUpdateState) => DesktopUpdateState,
  ): Effect.Effect<DesktopUpdateState> =>
    stateTransitionSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const result = yield* Ref.modify(updateStateRef, (state) => {
          const nextState = f(state);
          return [{ changed: nextState !== state, state: nextState }, nextState];
        });
        if (result.changed) {
          yield* broadcastState(result.state);
        }
        return result.state;
      }),
    );

  const readAppUpdateYml = fileSystem.readFileString(environment.appUpdateYmlPath, "utf-8").pipe(
    Effect.option,
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none<AppUpdateYmlConfig>()),
        onSome: parseAppUpdateYml,
      }),
    ),
  );

  const hasUpdateFeedConfig = Ref.get(appUpdateYmlConfigRef).pipe(
    Effect.map((appUpdateYmlConfig) => Option.isSome(appUpdateYmlConfig) || config.mockUpdates),
  );

  const resolveDisabledReason = Effect.gen(function* () {
    const hasFeedConfig = yield* hasUpdateFeedConfig;
    return Option.fromNullishOr(
      getAutoUpdateDisabledReason({
        isDevelopment: environment.isDevelopment,
        isPackaged: environment.isPackaged,
        platform: environment.platform,
        appImage: Option.getOrUndefined(config.appImagePath),
        disabledByEnv: config.disableAutoUpdate,
        hasUpdateFeedConfig: hasFeedConfig,
      }),
    );
  });

  const resolveUpdaterErrorContext = Effect.gen(function* () {
    if (yield* Ref.get(updateInstallInFlightRef)) return "install" as const;
    if (yield* Ref.get(updateDownloadInFlightRef)) return "download" as const;
    if (yield* Ref.get(updateCheckInFlightRef)) return "check" as const;
    return (yield* Ref.get(updateStateRef)).errorContext;
  });

  const activeUpdateAction = Effect.gen(function* () {
    if (yield* Ref.get(updateInstallInFlightRef)) return Option.some("install" as const);
    if (yield* Ref.get(updateDownloadInFlightRef)) return Option.some("download" as const);
    if (yield* Ref.get(updateCheckInFlightRef)) return Option.some("check" as const);
    return Option.none<"check" | "download" | "install">();
  });

  const runningUpdateChannel = resolveDefaultDesktopUpdateChannel(environment.appVersion);
  const allowsDowngradeForChannel = (channel: DesktopUpdateChannel): boolean =>
    channel === "nightly" || channel !== runningUpdateChannel;

  const applyAutoUpdaterChannel = Effect.fn("desktop.updates.applyAutoUpdaterChannel")(function* (
    channel: DesktopUpdateChannel,
  ) {
    yield* Effect.annotateCurrentSpan({ channel });
    const allowsPrerelease = channel === "nightly";
    const allowsDowngrade = allowsDowngradeForChannel(channel);
    yield* electronUpdater.setChannel(channel);
    yield* electronUpdater.setAllowPrerelease(allowsPrerelease);
    yield* electronUpdater.setAllowDowngrade(allowsDowngrade);
    yield* electronUpdater.setFullChangelog(allowsPrerelease);
    yield* logUpdaterInfo("using update channel", {
      channel,
      allowPrerelease: allowsPrerelease,
      allowDowngrade: allowsDowngrade,
      fullChangelog: allowsPrerelease,
    });
  });

  const shouldEnableAutoUpdates = resolveDisabledReason.pipe(Effect.map(Option.isNone));

  const checkForUpdates = Effect.fn("desktop.updates.checkForUpdates")(function* (reason: string) {
    yield* Effect.annotateCurrentSpan({ reason });
    if (yield* Ref.get(desktopState.quitting)) return false;
    if (!(yield* Ref.get(updaterConfiguredRef))) return false;
    if (yield* Ref.get(updateCheckInFlightRef)) return false;

    const state = yield* Ref.get(updateStateRef);
    const retryingFailedInstall = isFailedInstallState(state);
    if (
      state.status === "downloading" ||
      (state.status === "downloaded" && !retryingFailedInstall)
    ) {
      yield* logUpdaterInfo("skipping update check while update is active", {
        reason,
        status: state.status,
      });
      return false;
    }

    yield* Ref.set(updateCheckInFlightRef, true);
    const checkedAt = yield* currentIsoTimestamp;
    const checkingState = yield* updateState((current) => {
      const currentFailedInstall = isFailedInstallState(current);
      if (current.status === "downloaded" && !currentFailedInstall) {
        return current;
      }
      return reduceDesktopUpdateStateOnCheckStart(
        currentFailedInstall
          ? { ...current, availableVersion: null, downloadedVersion: null }
          : current,
        checkedAt,
      );
    });
    if (checkingState.status !== "checking") {
      yield* Ref.set(updateCheckInFlightRef, false);
      return false;
    }
    yield* Ref.set(installFailureClaimedRef, false);
    yield* electronUpdater.setAllowDowngrade(allowsDowngradeForChannel(state.channel));
    yield* logUpdaterInfo("checking for updates", { reason });

    return yield* electronUpdater.checkForUpdates.pipe(
      Effect.as(true),
      Effect.catchTags({
        ElectronUpdaterCheckForUpdatesError: Effect.fn(
          "desktop.updates.handleCheckForUpdatesFailure",
        )(function* (error) {
          const failedAt = yield* currentIsoTimestamp;
          yield* updateState((current) =>
            reduceDesktopUpdateStateOnCheckFailure(current, error.message, failedAt),
          );
          yield* logUpdaterError(error.message, {
            errorTag: error._tag,
            channel: error.channel,
          });
          return true;
        }),
      }),
      Effect.ensuring(Ref.set(updateCheckInFlightRef, false)),
    );
  });

  const downloadAvailableUpdate = Effect.gen(function* () {
    const state = yield* Ref.get(updateStateRef);
    if (
      !(yield* Ref.get(updaterConfiguredRef)) ||
      (yield* Ref.get(updateDownloadInFlightRef)) ||
      state.status !== "available"
    ) {
      return { accepted: false, completed: false };
    }

    yield* Ref.set(updateDownloadInFlightRef, true);
    return yield* Effect.gen(function* () {
      yield* updateState(reduceDesktopUpdateStateOnDownloadStart);
      yield* electronUpdater.setDisableDifferentialDownload(
        isArm64HostRunningIntelBuild(environment.runtimeInfo),
      );
      yield* logUpdaterInfo("downloading update");
      yield* electronUpdater.downloadUpdate;
      return { accepted: true, completed: true };
    }).pipe(
      Effect.catchTags({
        ElectronUpdaterDownloadUpdateError: Effect.fn("desktop.updates.handleDownloadFailure")(
          function* (error) {
            yield* updateState((current) =>
              reduceDesktopUpdateStateOnDownloadFailure(current, error.message),
            );
            yield* logUpdaterError(error.message, {
              errorTag: error._tag,
              channel: error.channel,
            });
            return { accepted: true, completed: false };
          },
        ),
      }),
      Effect.onInterrupt(() =>
        updateState((current) => (current.status === "downloading" ? state : current)).pipe(
          Effect.asVoid,
        ),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        const error = new DesktopUpdateUnexpectedActionError({ action: "download", cause });
        return Effect.gen(function* () {
          yield* updateState((current) =>
            reduceDesktopUpdateStateOnDownloadFailure(current, error.message),
          );
          yield* logUpdaterError(error.message, {
            errorTag: error._tag,
            action: error.action,
          });
          return { accepted: true, completed: false };
        });
      }),
      Effect.ensuring(Ref.set(updateDownloadInFlightRef, false)),
    );
  }).pipe(Effect.withSpan("desktop.updates.downloadAvailableUpdate"));

  const recoverAfterInstallFailure = Effect.gen(function* () {
    yield* Ref.set(desktopState.quitting, false);
    const instances = yield* pool.list;
    yield* Effect.forEach(instances, (instance) => instance.start, { concurrency: "unbounded" });
    const primary = yield* pool.primary;
    const ready = yield* primary.waitForReady(Duration.seconds(15));
    if (!ready) {
      return yield* Effect.die("Primary backend did not become ready after restart.");
    }
    yield* desktopWindow.revealOrCreateMain;
  }).pipe(Effect.withSpan("desktop.updates.recoverAfterInstallFailure"));

  const recoverOrQuitAfterInstallFailure = recoverAfterInstallFailure.pipe(
    Effect.as(true),
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        yield* Ref.set(desktopState.quitting, true);
        yield* logUpdaterError("failed to recover after update installation failure", {
          cause: Cause.pretty(cause),
        });
        yield* electronDialog
          .showErrorBox(
            "piCode could not recover from the update failure",
            "The update could not be installed, and piCode could not reopen safely. The app will quit. Please reopen it and try again.",
          )
          .pipe(Effect.ensuring(electronApp.quit));
        return false;
      }).pipe(Effect.catchCause(() => Effect.succeed(false))),
    ),
  );

  const handleInstallFailure = Effect.fn("desktop.updates.handleInstallFailure")(function* (
    message: string,
    annotations: Readonly<Record<string, unknown>>,
  ) {
    yield* installFailureSemaphore.withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (yield* Ref.get(installFailureClaimedRef)) {
            return;
          }
          yield* Ref.set(installFailureClaimedRef, true);
          yield* logUpdaterError(message, annotations);
          const recovered = yield* recoverOrQuitAfterInstallFailure;
          if (recovered) {
            yield* updateState((current) =>
              reduceDesktopUpdateStateOnInstallFailure(current, message),
            );
          }
        }).pipe(Effect.ensuring(Ref.set(updateInstallInFlightRef, false))),
      ),
    );
  });

  const installDownloadedUpdate = Effect.gen(function* () {
    const state = yield* Ref.get(updateStateRef);
    if (
      (yield* Ref.get(desktopState.quitting)) ||
      !(yield* Ref.get(updaterConfiguredRef)) ||
      state.status !== "downloaded" ||
      isFailedInstallState(state)
    ) {
      return { accepted: false, completed: false };
    }

    yield* Ref.set(installFailureClaimedRef, false);
    yield* Ref.set(desktopState.quitting, true);
    yield* Ref.set(updateInstallInFlightRef, true);

    return yield* Effect.gen(function* () {
      // Stop every backend in the pool, not just the primary. With
      // parallel WSL + Windows backends, leaving the WSL instance up
      // means quitAndInstall's app.quit() exits before the pool's
      // scope cascade has a chance to run its stop finalizer, so the
      // WSL child gets hard-killed by the OS instead of receiving
      // SIGTERM + grace. Stops run concurrently with the same 5s
      // budget the primary had on its own.
      const instances = yield* pool.list;
      yield* Effect.forEach(
        instances,
        (instance) => instance.stop({ timeout: Duration.seconds(5) }),
        { concurrency: "unbounded" },
      );
      yield* electronWindow.destroyAll;
      yield* electronUpdater.quitAndInstall({
        isSilent: true,
        isForceRunAfter: true,
      });
      return { accepted: true, completed: false };
    }).pipe(
      Effect.catchTags({
        ElectronUpdaterQuitAndInstallError: Effect.fn(
          "desktop.updates.handleQuitAndInstallFailure",
        )(function* (error) {
          yield* handleInstallFailure(error.message, {
            errorTag: error._tag,
            channel: error.channel,
            isSilent: error.isSilent,
            isForceRunAfter: error.isForceRunAfter,
          });
          return { accepted: true, completed: false };
        }),
      }),
      Effect.onInterrupt(() =>
        handleInstallFailure("Desktop update install action was interrupted.", {
          action: "install",
          interrupted: true,
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          if (Cause.hasInterruptsOnly(cause)) {
            return yield* Effect.failCause(cause);
          }
          const error = new DesktopUpdateUnexpectedActionError({ action: "install", cause });
          yield* handleInstallFailure(error.message, {
            errorTag: error._tag,
            action: error.action,
          });
          return { accepted: true, completed: false };
        }),
      ),
    );
  }).pipe(Effect.withSpan("desktop.updates.installDownloadedUpdate"));

  const startUpdatePollers: Effect.Effect<void, never, Scope.Scope> = Effect.gen(function* () {
    yield* Effect.sleep(AUTO_UPDATE_STARTUP_DELAY).pipe(
      Effect.andThen(checkForUpdates("startup")),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const error = new DesktopUpdatePollerError({ poller: "startup", cause });
        return logUpdaterError(error.message, {
          errorTag: error._tag,
          poller: error.poller,
        });
      }),
      Effect.forkScoped,
    );
    yield* Effect.sleep(AUTO_UPDATE_POLL_INTERVAL).pipe(
      Effect.andThen(checkForUpdates("poll")),
      Effect.forever,
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const error = new DesktopUpdatePollerError({ poller: "poll", cause });
        return logUpdaterError(error.message, {
          errorTag: error._tag,
          poller: error.poller,
        });
      }),
      Effect.forkScoped,
    );
  }).pipe(Effect.withSpan("desktop.updates.startPollers"));

  const handleUpdateAvailable = Effect.fn("desktop.updates.handleUpdateAvailable")(function* (
    raw: unknown,
  ) {
    yield* decodeUpdateInfo(raw).pipe(
      Effect.flatMap(
        Effect.fn("desktop.updates.applyUpdateAvailable")(function* (info) {
          const state = yield* Ref.get(updateStateRef);
          if (resolveDefaultDesktopUpdateChannel(info.version) !== state.channel) {
            yield* logUpdaterInfo("ignoring update that does not match selected channel", {
              version: info.version,
              channel: state.channel,
            });
            const checkedAt = yield* currentIsoTimestamp;
            yield* updateState((current) => reduceDesktopUpdateStateOnNoUpdate(current, checkedAt));
            yield* Ref.set(lastLoggedDownloadMilestoneRef, -1);
            return;
          }

          const checkedAt = yield* currentIsoTimestamp;
          const releaseNotes = normalizeDesktopUpdateReleaseNotes(info.releaseNotes, info.version);
          yield* updateState((current) =>
            reduceDesktopUpdateStateOnUpdateAvailable(
              current,
              info.version,
              checkedAt,
              releaseNotes,
            ),
          );
          yield* Ref.set(lastLoggedDownloadMilestoneRef, -1);
          yield* logUpdaterInfo("update available", {
            version: info.version,
            releaseNoteGroups: releaseNotes.length,
          });
        }),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const error = new DesktopUpdateEventHandlingError({ event: "update-available", cause });
        return logUpdaterWarning(error.message, {
          errorTag: error._tag,
          event: error.event,
        });
      }),
    );
  });

  const handleUpdateNotAvailable = Effect.gen(function* () {
    const checkedAt = yield* currentIsoTimestamp;
    yield* updateState((current) => reduceDesktopUpdateStateOnNoUpdate(current, checkedAt));
    yield* Ref.set(lastLoggedDownloadMilestoneRef, -1);
    yield* logUpdaterInfo("no updates available");
  }).pipe(Effect.withSpan("desktop.updates.handleUpdateNotAvailable"));

  const handleUpdaterError = Effect.fn("desktop.updates.handleUpdaterError")(function* (
    cause: unknown,
  ) {
    const activeAction = yield* activeUpdateAction;
    const error = new DesktopUpdaterReportedError({
      operation: Option.getOrElse(activeAction, () => "background" as const),
      cause,
    });
    const currentState = yield* Ref.get(updateStateRef);
    if (
      (yield* Ref.get(updateInstallInFlightRef)) ||
      ((yield* Ref.get(installFailureClaimedRef)) && isFailedInstallState(currentState))
    ) {
      yield* handleInstallFailure(error.message, {
        errorTag: error._tag,
        operation: error.operation,
      });
      return;
    }

    if (!(yield* Ref.get(updateCheckInFlightRef)) && !(yield* Ref.get(updateDownloadInFlightRef))) {
      const errorContext = yield* resolveUpdaterErrorContext;
      const checkedAt = yield* currentIsoTimestamp;
      yield* updateState((current) => ({
        ...current,
        status: "error",
        message: error.message,
        checkedAt,
        downloadPercent: null,
        errorContext,
        canRetry: getCanRetryFromState(current),
      }));
    }

    yield* logUpdaterError(error.message, {
      errorTag: error._tag,
      operation: error.operation,
    });
  });

  const handleDownloadProgress = Effect.fn("desktop.updates.handleDownloadProgress")(function* (
    raw: unknown,
  ) {
    yield* decodeDownloadProgressInfo(raw).pipe(
      Effect.flatMap(
        Effect.fn("desktop.updates.applyDownloadProgress")(function* (progress) {
          const percent = Math.floor(progress.percent);
          yield* updateState((current) =>
            current.status === "downloaded" ||
            (!shouldBroadcastDownloadProgress(current, progress.percent) &&
              current.message === null)
              ? current
              : reduceDesktopUpdateStateOnDownloadProgress(current, progress.percent),
          );
          const milestone = percent - (percent % 10);
          const lastLoggedMilestone = yield* Ref.get(lastLoggedDownloadMilestoneRef);
          if (milestone > lastLoggedMilestone) {
            yield* Ref.set(lastLoggedDownloadMilestoneRef, milestone);
            yield* logUpdaterInfo("download progress", { percent });
          }
        }),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const error = new DesktopUpdateEventHandlingError({ event: "download-progress", cause });
        return logUpdaterWarning(error.message, {
          errorTag: error._tag,
          event: error.event,
        });
      }),
    );
  });

  const handleUpdateDownloaded = Effect.fn("desktop.updates.handleUpdateDownloaded")(function* (
    raw: unknown,
  ) {
    yield* decodeUpdateInfo(raw).pipe(
      Effect.flatMap(
        Effect.fn("desktop.updates.applyUpdateDownloaded")(function* (info) {
          yield* updateState((current) =>
            reduceDesktopUpdateStateOnDownloadComplete(current, info.version),
          );
          yield* logUpdaterInfo("update downloaded", { version: info.version });
        }),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const error = new DesktopUpdateEventHandlingError({ event: "update-downloaded", cause });
        return logUpdaterWarning(error.message, {
          errorTag: error._tag,
          event: error.event,
        });
      }),
    );
  });

  return DesktopUpdates.of({
    getState: Ref.get(updateStateRef),
    emitState,
    disabledReason: resolveDisabledReason,
    configure: Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      const runEffect = (effect: Effect.Effect<void>) => {
        void Effect.runPromiseWith(context)(effect);
      };

      const appUpdateYmlConfig = yield* readAppUpdateYml;
      yield* Ref.set(appUpdateYmlConfigRef, appUpdateYmlConfig);

      if (config.mockUpdates) {
        yield* electronUpdater.setFeedURL({
          provider: "generic",
          url: `http://localhost:${config.mockUpdateServerPort}`,
        } as ElectronUpdater.ElectronUpdaterFeedUrl);
      }

      const settings = yield* desktopSettings.get;
      const enabled = yield* shouldEnableAutoUpdates;
      yield* replaceState(createBaseUpdateState(settings.updateChannel, enabled, environment));
      if (!enabled) {
        return;
      }
      yield* Ref.set(updaterConfiguredRef, true);

      yield* electronUpdater.setAutoDownload(false);
      yield* electronUpdater.setAutoInstallOnAppQuit(false);
      yield* applyAutoUpdaterChannel(settings.updateChannel);
      yield* electronUpdater.setDisableDifferentialDownload(
        isArm64HostRunningIntelBuild(environment.runtimeInfo),
      );

      if (isArm64HostRunningIntelBuild(environment.runtimeInfo)) {
        yield* logUpdaterInfo(
          "Apple Silicon host detected while running Intel build; updates will switch to arm64 packages",
        );
      }

      yield* electronUpdater.on("checking-for-update", () => {
        runEffect(
          logUpdaterInfo("looking for updates").pipe(
            Effect.withSpan("desktop.updates.handleCheckingForUpdate"),
          ),
        );
      });
      yield* electronUpdater.on("update-available", (info: unknown) => {
        runEffect(handleUpdateAvailable(info));
      });
      yield* electronUpdater.on("update-not-available", () => {
        runEffect(handleUpdateNotAvailable);
      });
      yield* electronUpdater.on("error", (error: unknown) => {
        runEffect(handleUpdaterError(error));
      });
      yield* electronUpdater.on("download-progress", (progress: unknown) => {
        runEffect(handleDownloadProgress(progress));
      });
      yield* electronUpdater.on("update-downloaded", (info: unknown) => {
        runEffect(handleUpdateDownloaded(info));
      });

      yield* startUpdatePollers;
    }).pipe(Effect.withSpan("desktop.updates.configure")),
    setChannel: Effect.fn("desktop.updates.setChannel")(function* (
      nextChannel: DesktopUpdateChannel,
    ) {
      yield* Effect.annotateCurrentSpan({ channel: nextChannel });
      const activeAction = yield* activeUpdateAction;
      if (Option.isSome(activeAction)) {
        return yield* new DesktopUpdateActionInProgressError({
          action: activeAction.value,
          requestedChannel: nextChannel,
        });
      }

      const state = yield* Ref.get(updateStateRef);
      if (nextChannel === state.channel) {
        return state;
      }

      yield* desktopSettings
        .setUpdateChannel(nextChannel)
        .pipe(
          Effect.mapError(
            (cause) => new DesktopUpdateChannelPersistenceError({ channel: nextChannel, cause }),
          ),
        );

      const enabled = yield* shouldEnableAutoUpdates;
      yield* replaceState(createBaseUpdateState(nextChannel, enabled, environment));

      if (!enabled || !(yield* Ref.get(updaterConfiguredRef))) {
        return yield* Ref.get(updateStateRef);
      }

      yield* applyAutoUpdaterChannel(nextChannel);
      yield* checkForUpdates("channel-change");
      return yield* Ref.get(updateStateRef);
    }),
    check: Effect.fn("desktop.updates.check")(function* (reason: string) {
      yield* Effect.annotateCurrentSpan({ reason });
      if (!(yield* Ref.get(updaterConfiguredRef))) {
        return {
          checked: false,
          state: yield* Ref.get(updateStateRef),
        };
      }
      const checked = yield* checkForUpdates(reason);
      return {
        checked,
        state: yield* Ref.get(updateStateRef),
      };
    }),
    download: Effect.gen(function* () {
      const result = yield* downloadAvailableUpdate;
      return {
        accepted: result.accepted,
        completed: result.completed,
        state: yield* Ref.get(updateStateRef),
      };
    }).pipe(Effect.withSpan("desktop.updates.download")),
    install: Effect.gen(function* () {
      if (yield* Ref.get(desktopState.quitting)) {
        return {
          accepted: false,
          completed: false,
          state: yield* Ref.get(updateStateRef),
        };
      }
      const result = yield* installDownloadedUpdate;
      return {
        accepted: result.accepted,
        completed: result.completed,
        state: yield* Ref.get(updateStateRef),
      };
    }).pipe(Effect.withSpan("desktop.updates.install")),
  });
});

export const layer = Layer.effect(DesktopUpdates, make);
