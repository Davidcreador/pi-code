import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { DesktopUpdateState } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";

interface UpdatesHarnessOptions {
  readonly checkForUpdates?: Effect.Effect<
    void,
    ElectronUpdater.ElectronUpdaterCheckForUpdatesError
  >;
  readonly setUpdateChannelError?: DesktopAppSettings.DesktopSettingsWriteError;
  readonly setDisableDifferentialDownload?: Effect.Effect<void>;
  readonly stopBackend?: Effect.Effect<void>;
  readonly startBackend?: Effect.Effect<void>;
  readonly includeSecondaryBackend?: boolean;
  readonly waitForBackendReady?: Effect.Effect<boolean>;
  readonly quitAndInstall?: Effect.Effect<void, ElectronUpdater.ElectronUpdaterQuitAndInstallError>;
  readonly sendState?: (state: DesktopUpdateState) => Effect.Effect<void>;
  readonly appVersion?: string;
  readonly env?: Record<string, string | undefined>;
}

const flushCallbacks = Effect.yieldNow;

function makeHarness(options: UpdatesHarnessOptions = {}) {
  let checkCount = 0;
  let allowDowngrade = false;
  let fullChangelog = false;
  const checkAllowDowngrade: boolean[] = [];
  const feedUrls: ElectronUpdater.ElectronUpdaterFeedUrl[] = [];
  const installCalls: string[] = [];
  const listeners = new Map<string, Set<(...args: readonly unknown[]) => void>>();
  const sentStates: DesktopUpdateState[] = [];

  const addListener = (eventName: string, listener: (...args: readonly unknown[]) => void) => {
    const eventListeners = listeners.get(eventName) ?? new Set();
    eventListeners.add(listener);
    listeners.set(eventName, eventListeners);
  };

  const removeListener = (eventName: string, listener: (...args: readonly unknown[]) => void) => {
    const eventListeners = listeners.get(eventName);
    if (!eventListeners) {
      return;
    }
    eventListeners.delete(listener);
    if (eventListeners.size === 0) {
      listeners.delete(eventName);
    }
  };

  const updaterLayer = Layer.succeed(ElectronUpdater.ElectronUpdater, {
    setFeedURL: (options) =>
      Effect.sync(() => {
        feedUrls.push(options);
      }),
    setAutoDownload: () => Effect.void,
    setAutoInstallOnAppQuit: () => Effect.void,
    setChannel: () => Effect.void,
    setAllowPrerelease: () => Effect.void,
    allowDowngrade: Effect.sync(() => allowDowngrade),
    setAllowDowngrade: (value) =>
      Effect.sync(() => {
        allowDowngrade = value;
      }),
    setFullChangelog: (value) =>
      Effect.sync(() => {
        fullChangelog = value;
      }),
    setDisableDifferentialDownload: () => options.setDisableDifferentialDownload ?? Effect.void,
    checkForUpdates: Effect.sync(() => {
      checkCount += 1;
      checkAllowDowngrade.push(allowDowngrade);
    }).pipe(Effect.andThen(options.checkForUpdates ?? Effect.void)),
    downloadUpdate: Effect.void,
    quitAndInstall: () =>
      Effect.sync(() => {
        installCalls.push("quit-and-install");
      }).pipe(Effect.andThen(options.quitAndInstall ?? Effect.void)),
    on: (eventName, listener) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          addListener(eventName, listener as unknown as (...args: readonly unknown[]) => void);
        }),
        () =>
          Effect.sync(() => {
            removeListener(eventName, listener as unknown as (...args: readonly unknown[]) => void);
          }),
      ).pipe(Effect.asVoid),
  } satisfies ElectronUpdater.ElectronUpdater["Service"]);

  const windowLayer = Layer.succeed(ElectronWindow.ElectronWindow, {
    create: () => Effect.die("unexpected BrowserWindow creation"),
    main: Effect.succeed(Option.none()),
    currentMainOrFirst: Effect.succeed(Option.none()),
    focusedMainOrFirst: Effect.succeed(Option.none()),
    setMain: () => Effect.void,
    clearMain: () => Effect.void,
    reveal: () => Effect.void,
    sendAll: (_channel, state) => {
      const updateState = state as DesktopUpdateState;
      return Effect.sync(() => {
        sentStates.push(updateState);
        if (updateState.errorContext === "install") {
          installCalls.push("broadcast-install-failure");
        }
      }).pipe(Effect.andThen(options.sendState?.(updateState) ?? Effect.void));
    },
    destroyAll: Effect.sync(() => {
      installCalls.push("destroy-windows");
    }),
    syncAllAppearance: () => Effect.void,
  } satisfies ElectronWindow.ElectronWindow["Service"]);

  const stubBackendInstance: DesktopBackendPool.DesktopBackendInstance = {
    id: DesktopBackendPool.PRIMARY_INSTANCE_ID,
    label: Effect.succeed("Windows"),
    start: Effect.sync(() => {
      installCalls.push("start-primary");
    }).pipe(Effect.andThen(options.startBackend ?? Effect.void)),
    stop: () =>
      Effect.sync(() => {
        installCalls.push("stop-primary");
      }).pipe(Effect.andThen(options.stopBackend ?? Effect.void)),
    currentConfig: Effect.succeed(Option.none()),
    snapshot: Effect.succeed({
      desiredRunning: false,
      startInProgress: false,
      ready: false,
      activePid: Option.none(),
      restartAttempt: 0,
      restartScheduled: false,
    }),
    waitForReady: () =>
      Effect.sync(() => {
        installCalls.push("wait-primary-ready");
      }).pipe(Effect.andThen(options.waitForBackendReady ?? Effect.succeed(true))),
  };
  const secondaryBackendInstance: DesktopBackendPool.DesktopBackendInstance = {
    ...stubBackendInstance,
    id: DesktopBackendPool.BackendInstanceId("wsl:ubuntu"),
    label: Effect.succeed("WSL (Ubuntu)"),
    start: Effect.sync(() => {
      installCalls.push("start-secondary");
    }),
    stop: () =>
      Effect.sync(() => {
        installCalls.push("stop-secondary");
      }),
  };
  const backendLayer = DesktopBackendPool.layerTest(
    options.includeSecondaryBackend
      ? [stubBackendInstance, secondaryBackendInstance]
      : [stubBackendInstance],
  );

  const desktopWindowLayer = Layer.succeed(
    DesktopWindow.DesktopWindow,
    DesktopWindow.DesktopWindow.of({
      revealOrCreateMain: Effect.sync(() => {
        installCalls.push("reveal-main-window");
        return {} as Electron.BrowserWindow;
      }),
    } as unknown as DesktopWindow.DesktopWindow["Service"]),
  );

  const electronAppLayer = Layer.succeed(
    ElectronApp.ElectronApp,
    ElectronApp.ElectronApp.of({
      quit: Effect.sync(() => {
        installCalls.push("fatal-quit");
      }),
    } as ElectronApp.ElectronApp["Service"]),
  );

  const electronDialogLayer = Layer.succeed(
    ElectronDialog.ElectronDialog,
    ElectronDialog.ElectronDialog.of({
      showErrorBox: () =>
        Effect.sync(() => {
          installCalls.push("fatal-dialog");
        }),
    } as unknown as ElectronDialog.ElectronDialog["Service"]),
  );

  const environmentLayer = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: `/tmp/t3-desktop-updates-home-${process.pid}`,
    platform: "darwin",
    processArch: "x64",
    appVersion: options.appVersion ?? "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        DesktopConfig.layerTest({
          D4_HOME: `/tmp/t3-desktop-updates-test-${process.pid}`,
          T3CODE_DESKTOP_MOCK_UPDATES: "true",
          T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT: "4141",
          ...options.env,
        }),
      ),
    ),
  );

  const setUpdateChannelError = options.setUpdateChannelError;
  const settingsLayer = setUpdateChannelError
    ? Layer.succeed(DesktopAppSettings.DesktopAppSettings, {
        get: Effect.succeed(DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS),
        load: Effect.succeed(DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS),
        setMainWindowBounds: () => Effect.die("unexpected main window bounds update"),
        setServerExposureMode: () => Effect.die("unexpected server exposure update"),
        setTailscaleServe: () => Effect.die("unexpected Tailscale Serve update"),
        setUpdateChannel: () => Effect.fail(setUpdateChannelError),
        setWslBackendEnabled: () => Effect.die("unexpected WSL backend toggle"),
        setWslDistro: () => Effect.die("unexpected WSL distro change"),
        setWslOnly: () => Effect.die("unexpected WSL-only toggle"),
        applyWslWindowsFallback: Effect.die("unexpected WSL Windows fallback"),
        applyWslWindowsFallbackInMemory: Effect.die("unexpected WSL Windows fallback"),
      } satisfies DesktopAppSettings.DesktopAppSettings["Service"])
    : DesktopAppSettings.layer;

  const layer = DesktopUpdates.layer.pipe(
    Layer.provideMerge(updaterLayer),
    Layer.provideMerge(windowLayer),
    Layer.provideMerge(desktopWindowLayer),
    Layer.provideMerge(electronAppLayer),
    Layer.provideMerge(electronDialogLayer),
    Layer.provideMerge(backendLayer),
    Layer.provideMerge(DesktopState.layer),
    Layer.provideMerge(settingsLayer),
    Layer.provideMerge(
      DesktopConfig.layerTest({
        D4_HOME: `/tmp/t3-desktop-updates-test-${process.pid}`,
        T3CODE_DESKTOP_MOCK_UPDATES: "true",
        T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT: "4141",
        ...options.env,
      }),
    ),
    Layer.provideMerge(environmentLayer),
    Layer.provideMerge(NodeServices.layer),
  );

  return {
    layer,
    allowDowngrade: () => allowDowngrade,
    checkAllowDowngrade: () => checkAllowDowngrade,
    checkCount: () => checkCount,
    feedUrls: () => feedUrls,
    fullChangelog: () => fullChangelog,
    installCalls: () => installCalls,
    listenerCount: () =>
      Array.from(listeners.values()).reduce(
        (total, eventListeners) => total + eventListeners.size,
        0,
      ),
    sentStates,
    emit: (eventName: string, payload?: unknown) => {
      for (const listener of listeners.get(eventName) ?? []) {
        listener(payload);
      }
    },
  };
}

describe("DesktopUpdates", () => {
  it("preserves complete causes for update poller and event failures", () => {
    const cause = Cause.combine(
      Cause.fail(new Error("updater failed")),
      Cause.die(new Error("updater defect")),
    );
    const pollerError = new DesktopUpdates.DesktopUpdatePollerError({
      poller: "startup",
      cause,
    });
    const eventError = new DesktopUpdates.DesktopUpdateEventHandlingError({
      event: "download-progress",
      cause,
    });
    const reportedError = new DesktopUpdates.DesktopUpdaterReportedError({
      operation: "download",
      cause,
    });
    const unexpectedActionError = new DesktopUpdates.DesktopUpdateUnexpectedActionError({
      action: "install",
      cause,
    });

    assert.strictEqual(pollerError.cause, cause);
    assert.equal(pollerError.poller, "startup");
    assert.equal(pollerError.message, "Desktop update startup poller failed.");
    assert.strictEqual(eventError.cause, cause);
    assert.equal(eventError.event, "download-progress");
    assert.equal(eventError.message, "Failed to handle desktop update download-progress event.");
    assert.strictEqual(reportedError.cause, cause);
    assert.equal(reportedError.operation, "download");
    assert.equal(reportedError.message, "Desktop updater download operation reported an error.");
    assert.strictEqual(unexpectedActionError.cause, cause);
    assert.equal(unexpectedActionError.action, "install");
    assert.equal(
      unexpectedActionError.message,
      "Desktop update install action failed unexpectedly.",
    );
  });

  it.effect("configures the updater and runs startup checks on the test clock", () => {
    const harness = makeHarness();

    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;

          const state = yield* updates.getState;
          assert.equal(state.enabled, true);
          assert.equal(state.status, "idle");
          assert.deepEqual(harness.feedUrls(), [
            { provider: "generic", url: "http://localhost:4141" },
          ]);
          assert.equal(harness.listenerCount(), 6);
          assert.equal(harness.allowDowngrade(), false);
          assert.equal(harness.checkCount(), 0);

          yield* TestClock.adjust(Duration.millis(15_000));
          assert.equal(harness.checkCount(), 1);
          assert.deepEqual(harness.checkAllowDowngrade(), [false]);
        }),
      );

      assert.equal(harness.listenerCount(), 0);
    }).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("updates and broadcasts state from updater events", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;

        const state = yield* updates.getState;
        assert.equal(state.status, "available");
        assert.equal(state.availableVersion, "1.2.4");
        assert.isNotNull(state.checkedAt);
        assert.equal(harness.sentStates.at(-1)?.status, "available");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("keeps downloaded state when progress bursts while its broadcast is blocked", () =>
    Effect.gen(function* () {
      const downloadedBroadcastStarted = yield* Deferred.make<void>();
      const releaseDownloadedBroadcast = yield* Deferred.make<void>();
      const harness = makeHarness({
        sendState: (state) =>
          state.status === "downloaded"
            ? Deferred.succeed(downloadedBroadcastStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseDownloadedBroadcast)),
              )
            : Effect.void,
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;

          harness.emit("download-progress", { percent: 50 });
          yield* flushCallbacks;
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* Deferred.await(downloadedBroadcastStarted);

          for (const percent of [60, 70, 80, 90, 99]) {
            harness.emit("download-progress", { percent });
          }
          yield* flushCallbacks;
          yield* Deferred.succeed(releaseDownloadedBroadcast, undefined);
          yield* flushCallbacks;

          const state = yield* updates.getState;
          assert.equal(state.status, "downloaded");
          assert.equal(state.availableVersion, "1.2.4");
          assert.equal(state.downloadedVersion, "1.2.4");
          assert.equal(state.downloadPercent, 100);
          assert.equal(harness.sentStates.at(-1)?.status, "downloaded");
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("delivers downloaded after an earlier blocked progress broadcast", () =>
    Effect.gen(function* () {
      const progressBroadcastStarted = yield* Deferred.make<void>();
      const releaseProgressBroadcast = yield* Deferred.make<void>();
      const downloadedBroadcasted = yield* Deferred.make<void>();
      const harness = makeHarness({
        sendState: (state) => {
          if (state.status === "downloading" && state.downloadPercent === 50) {
            return Deferred.succeed(progressBroadcastStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseProgressBroadcast)),
            );
          }
          return state.status === "downloaded"
            ? Deferred.succeed(downloadedBroadcasted, undefined).pipe(Effect.asVoid)
            : Effect.void;
        },
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;

          harness.emit("download-progress", { percent: 50 });
          yield* Deferred.await(progressBroadcastStarted);
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* flushCallbacks;

          yield* Deferred.succeed(releaseProgressBroadcast, undefined);
          yield* Deferred.await(downloadedBroadcasted);

          const state = yield* updates.getState;
          assert.equal(state.status, "downloaded");
          assert.equal(state.downloadedVersion, "1.2.4");
          assert.equal(state.downloadPercent, 100);
          assert.equal(harness.sentStates.at(-1)?.status, "downloaded");
          assert.equal(harness.sentStates.at(-1)?.downloadPercent, 100);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("keeps downgrade checks enabled after switching a nightly build to latest", () => {
    const harness = makeHarness({ appVersion: "1.2.4-nightly.20260731.1" });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        yield* updates.setChannel("nightly");
        yield* updates.setChannel("latest");
        assert.equal(harness.allowDowngrade(), true);

        harness.emit("update-available", { version: "1.2.3" });
        yield* flushCallbacks;
        assert.equal((yield* updates.getState).status, "available");

        yield* updates.check("poll");
        assert.equal(harness.checkAllowDowngrade().at(-1), true);
        assert.equal(harness.allowDowngrade(), true);

        harness.emit("update-available", { version: "1.2.3" });
        yield* flushCallbacks;
        const state = yield* updates.getState;
        assert.equal(state.status, "available");
        assert.equal(state.availableVersion, "1.2.3");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("enables nightly full changelog release notes and broadcasts summaries", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        yield* updates.setChannel("nightly");
        assert.equal(harness.allowDowngrade(), true);
        assert.equal(harness.fullChangelog(), true);

        harness.emit("update-available", {
          version: "1.2.4-nightly.20260709.766",
          releaseNotes: [
            {
              version: "1.2.4-nightly.20260709.766",
              note: `<h2>What's Changed</h2><ul><li>feat(client): persist offline environment data by <a>@juliusmarminge</a> in <a>#3795</a></li></ul><h2>Full Changelog</h2>`,
            },
            {
              version: "1.2.4-nightly.20260709.765",
              note: "- [codex] Upgrade Clerk stack by @juliusmarminge in #3821",
            },
          ],
        });
        yield* flushCallbacks;

        const state = yield* updates.getState;
        assert.equal(state.status, "available");
        assert.deepEqual(state.releaseNotes, [
          {
            version: "1.2.4-nightly.20260709.766",
            items: ["feat(client): persist offline environment data by @juliusmarminge in #3795"],
          },
          {
            version: "1.2.4-nightly.20260709.765",
            items: ["[codex] Upgrade Clerk stack by @juliusmarminge in #3821"],
          },
        ]);
        assert.deepEqual(harness.sentStates.at(-1)?.releaseNotes, state.releaseNotes);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("keeps raw updater event failures out of update state", () => {
    const harness = makeHarness();
    const cause = new Error(
      "request failed for https://user:secret@example.com/update?token=secret",
    );

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        harness.emit("error", cause);
        yield* flushCallbacks;

        const state = yield* updates.getState;
        assert.equal(state.status, "error");
        assert.equal(state.message, "Desktop updater background operation reported an error.");
        assert.notInclude(state.message ?? "", "secret");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("logs bounded updater failure context without exposing the cause", () => {
    const cause = new Error(
      "request failed for https://user:secret@example.com/update?token=secret",
    );
    const updaterError = new ElectronUpdater.ElectronUpdaterCheckForUpdatesError({
      channel: null,
      cause,
    });
    const harness = makeHarness({ checkForUpdates: Effect.fail(updaterError) });
    const loggedAnnotations: Array<Record<string, unknown>> = [];
    const logger = Logger.make(({ fiber }) => {
      const annotations = fiber.getRef(References.CurrentLogAnnotations);
      if (annotations.errorTag === "ElectronUpdaterCheckForUpdatesError") {
        loggedAnnotations.push(annotations);
      }
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        yield* updates.check("manual");

        const state = yield* updates.getState;
        const loggedAnnotation = loggedAnnotations.at(-1);
        assert.isDefined(loggedAnnotation);
        assert.equal(loggedAnnotation.errorTag, "ElectronUpdaterCheckForUpdatesError");
        assert.isNull(loggedAnnotation.channel);
        assert.notProperty(loggedAnnotation, "error");
        assert.notInclude(Object.values(loggedAnnotation).map(String).join(" "), "secret");
        assert.equal(
          state.message,
          "Electron updater failed to check for updates on channel default.",
        );
        assert.notInclude(state.message ?? "", "secret");
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          TestClock.layer(),
          harness.layer,
          Logger.layer([logger], { mergeWithExisting: false }),
        ),
      ),
    );
  });

  it.effect("recovers download state after an unexpected setup failure", () => {
    let disableDifferentialCalls = 0;
    const harness = makeHarness({
      setDisableDifferentialDownload: Effect.suspend(() => {
        disableDifferentialCalls += 1;
        return disableDifferentialCalls === 1
          ? Effect.void
          : Effect.die(new Error("download setup failed"));
      }),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;

        const result = yield* updates.download;
        assert.isTrue(result.accepted);
        assert.isFalse(result.completed);

        const failedState = yield* updates.getState;
        assert.equal(failedState.status, "available");
        assert.equal(failedState.errorContext, "download");
        assert.equal(failedState.message, "Desktop update download action failed unexpectedly.");

        const changedState = yield* updates.setChannel("nightly");
        assert.equal(changedState.channel, "nightly");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("restores download state and permits retry after interruption", () =>
    Effect.gen(function* () {
      const actionStarted = yield* Deferred.make<void>();
      let disableDifferentialCalls = 0;
      const harness = makeHarness({
        setDisableDifferentialDownload: Effect.suspend(() => {
          disableDifferentialCalls += 1;
          if (disableDifferentialCalls === 1) {
            return Effect.void;
          }
          if (disableDifferentialCalls === 2) {
            return Deferred.succeed(actionStarted, undefined).pipe(Effect.andThen(Effect.never));
          }
          return Effect.void;
        }),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          harness.emit("update-available", { version: "1.2.4" });
          yield* flushCallbacks;

          const downloadFiber = yield* updates.download.pipe(Effect.forkScoped);
          yield* Deferred.await(actionStarted);
          yield* Fiber.interrupt(downloadFiber);

          const interruptedState = yield* updates.getState;
          assert.equal(interruptedState.status, "available");
          assert.isNull(interruptedState.message);

          const retry = yield* updates.download;
          assert.isTrue(retry.accepted);
          assert.isTrue(retry.completed);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("recovers the backend and window before broadcasting install failure", () => {
    const updaterError = new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
      channel: "latest",
      isSilent: true,
      isForceRunAfter: true,
      cause: new Error("install failed"),
    });
    const harness = makeHarness({
      quitAndInstall: Effect.fail(updaterError),
      includeSecondaryBackend: true,
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const desktopState = yield* DesktopState.DesktopState;
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        const result = yield* updates.install;
        assert.isTrue(result.accepted);
        assert.isFalse(result.completed);
        assert.isFalse(yield* Ref.get(desktopState.quitting));
        assert.deepEqual(harness.installCalls(), [
          "stop-primary",
          "stop-secondary",
          "destroy-windows",
          "quit-and-install",
          "start-primary",
          "start-secondary",
          "wait-primary-ready",
          "reveal-main-window",
          "broadcast-install-failure",
        ]);

        const failedState = yield* updates.getState;
        assert.equal(failedState.status, "downloaded");
        assert.equal(failedState.errorContext, "install");
        assert.equal(failedState.message, updaterError.message);

        const installRetry = yield* updates.install;
        assert.isFalse(installRetry.accepted);

        const checkResult = yield* updates.check("manual-after-install-failure");
        assert.isTrue(checkResult.checked);
        assert.equal(harness.checkCount(), 1);
        assert.equal(checkResult.state.status, "checking");
        assert.isNull(checkResult.state.availableVersion);
        assert.isNull(checkResult.state.downloadedVersion);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("rejects checks for a successfully downloaded update", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        const checkResult = yield* updates.check("manual");
        assert.isFalse(checkResult.checked);
        assert.equal(harness.checkCount(), 0);
        assert.equal(checkResult.state.status, "downloaded");
        assert.equal(checkResult.state.downloadedVersion, "1.2.4");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("owns updater error and quit rejection with one install recovery", () =>
    Effect.gen(function* () {
      const quitStarted = yield* Deferred.make<void>();
      const releaseQuit = yield* Deferred.make<void>();
      const recoveryBroadcast = yield* Deferred.make<void>();
      const updaterError = new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
        channel: "latest",
        isSilent: true,
        isForceRunAfter: true,
        cause: new Error("install rejected"),
      });
      const harness = makeHarness({
        quitAndInstall: Deferred.succeed(quitStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseQuit)),
          Effect.andThen(Effect.fail(updaterError)),
        ),
        sendState: (state) =>
          state.errorContext === "install"
            ? Deferred.succeed(recoveryBroadcast, undefined).pipe(Effect.asVoid)
            : Effect.void,
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* flushCallbacks;

          const installFiber = yield* updates.install.pipe(Effect.forkScoped);
          yield* Deferred.await(quitStarted);
          harness.emit("error", new Error("updater event failed"));
          yield* Deferred.await(recoveryBroadcast);
          yield* Deferred.succeed(releaseQuit, undefined);
          yield* Fiber.join(installFiber);

          assert.equal(harness.installCalls().filter((call) => call === "start-primary").length, 1);
          assert.equal(
            harness.installCalls().filter((call) => call === "broadcast-install-failure").length,
            1,
          );
          const state = yield* updates.getState;
          assert.equal(state.status, "downloaded");
          assert.equal(state.errorContext, "install");
          assert.equal(state.message, "Desktop updater install operation reported an error.");
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("recovers after install interruption once windows have been destroyed", () =>
    Effect.gen(function* () {
      const quitStarted = yield* Deferred.make<void>();
      const harness = makeHarness({
        quitAndInstall: Deferred.succeed(quitStarted, undefined).pipe(Effect.andThen(Effect.never)),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const desktopState = yield* DesktopState.DesktopState;
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* flushCallbacks;

          const installFiber = yield* updates.install.pipe(Effect.forkScoped);
          yield* Deferred.await(quitStarted);
          yield* Fiber.interrupt(installFiber);

          assert.isFalse(yield* Ref.get(desktopState.quitting));
          assert.deepEqual(harness.installCalls(), [
            "stop-primary",
            "destroy-windows",
            "quit-and-install",
            "start-primary",
            "wait-primary-ready",
            "reveal-main-window",
            "broadcast-install-failure",
          ]);
          const state = yield* updates.getState;
          assert.equal(state.status, "downloaded");
          assert.equal(state.errorContext, "install");
          assert.equal(state.message, "Desktop update install action was interrupted.");
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("shows a fatal error and quits when install recovery cannot become ready", () => {
    const updaterError = new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
      channel: "latest",
      isSilent: true,
      isForceRunAfter: true,
      cause: new Error("install failed"),
    });
    const harness = makeHarness({
      quitAndInstall: Effect.fail(updaterError),
      waitForBackendReady: Effect.succeed(false),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const desktopState = yield* DesktopState.DesktopState;
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        const result = yield* updates.install;
        assert.isTrue(result.accepted);
        assert.isFalse(result.completed);
        assert.isTrue(yield* Ref.get(desktopState.quitting));
        assert.deepEqual(harness.installCalls(), [
          "stop-primary",
          "destroy-windows",
          "quit-and-install",
          "start-primary",
          "wait-primary-ready",
          "fatal-dialog",
          "fatal-quit",
        ]);
        assert.isNull((yield* updates.getState).errorContext);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("persists channel changes through the settings service", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        const state = yield* updates.setChannel("nightly");
        const persistedSettings = yield* settings.get;

        assert.equal(state.channel, "nightly");
        assert.equal(persistedSettings.updateChannel, "nightly");
        assert.equal(persistedSettings.updateChannelConfiguredByUser, true);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("does not persist an unchanged update channel as a user preference", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        const state = yield* updates.setChannel("latest");
        const persistedSettings = yield* settings.get;

        assert.equal(state.channel, "latest");
        assert.equal(persistedSettings.updateChannel, "latest");
        assert.equal(persistedSettings.updateChannelConfiguredByUser, false);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("fails channel changes with a typed error while a check is in progress", () =>
    Effect.gen(function* () {
      const checkStarted = yield* Deferred.make<void>();
      const releaseCheck = yield* Deferred.make<void>();
      const harness = makeHarness({
        checkForUpdates: Deferred.succeed(checkStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseCheck)),
        ),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;

          const checkFiber = yield* updates.check("manual").pipe(Effect.forkScoped);
          yield* Deferred.await(checkStarted);

          const exit = yield* Effect.exit(updates.setChannel("nightly"));
          assert.equal(exit._tag, "Failure");
          if (exit._tag === "Failure") {
            const error = Cause.squash(exit.cause);
            assert.instanceOf(error, DesktopUpdates.DesktopUpdateActionInProgressError);
            assert.equal(error.action, "check");
            assert.equal(error.requestedChannel, "nightly");
          }

          yield* Deferred.succeed(releaseCheck, undefined);
          yield* Fiber.join(checkFiber);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("preserves settings failure context when an update channel cannot be persisted", () => {
    const diskFailure = new Error("disk exploded");
    const settingsFailure = new DesktopAppSettings.DesktopSettingsWriteError({
      operation: "replace-settings-file",
      path: "/tmp/settings.json",
      cause: diskFailure,
    });
    const harness = makeHarness({ setUpdateChannelError: settingsFailure });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        const error = yield* updates.setChannel("nightly").pipe(Effect.flip);

        assert.instanceOf(error, DesktopUpdates.DesktopUpdateChannelPersistenceError);
        assert.isTrue(DesktopUpdates.isDesktopUpdateSetChannelError(error));
        assert.equal(error.channel, "nightly");
        assert.strictEqual(error.cause, settingsFailure);
        assert.strictEqual(error.cause.cause, diskFailure);
        assert.equal(error.message, "Failed to persist the nightly desktop update channel.");
        assert.notInclude(error.message, diskFailure.message);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });
});
