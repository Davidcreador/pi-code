import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  desktopDir,
  resolveDevProtocolClient,
  resolveElectronLaunchCommand,
} from "./electron-launcher.mjs";
import {
  claimDevElectronPids,
  clearDevElectronPids,
  updateDevElectronApp,
} from "./dev-electron-pid.mjs";
import {
  recordSpawnedDevApp,
  settlePendingRestartBeforeShutdown,
} from "./dev-electron-lifecycle.mjs";
import { waitForResources } from "./wait-for-resources.mjs";

const devServerUrl = process.env.VITE_DEV_SERVER_URL?.trim();
if (!devServerUrl) {
  throw new Error("VITE_DEV_SERVER_URL is required for desktop development.");
}

const devServer = new URL(devServerUrl);
const port = Number.parseInt(devServer.port, 10);
if (!Number.isInteger(port) || port <= 0) {
  throw new Error(`VITE_DEV_SERVER_URL must include an explicit port: ${devServerUrl}`);
}

const requiredFiles = [
  "dist-electron/main.cjs",
  "dist-electron/preload.cjs",
  "../server/dist/bin.mjs",
];
const watchedDirectories = [
  { directory: "dist-electron", files: new Set(["main.cjs", "preload.cjs"]) },
  { directory: "../server/dist", files: new Set(["bin.mjs"]) },
];
const forcedShutdownTimeoutMs = 3_000;
const restartDebounceMs = 120;
const childTreeGracePeriodMs = 1_200;
const devPidFilePath = NodePath.join(desktopDir, ".electron-runtime", "dev-electron.pid");
const remoteDebuggingPort = process.env.T3CODE_DESKTOP_REMOTE_DEBUGGING_PORT?.trim();
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone dev script has no Effect runtime.
const hostPlatform = NodeOS.platform();

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
const devProtocolClient = resolveDevProtocolClient();
if (devProtocolClient) {
  childEnv.T3CODE_DESKTOP_APP_USER_MODEL_ID = devProtocolClient.appBundleId;
  childEnv.T3CODE_DESKTOP_PROTOCOL_REGISTRATION_MANAGED = "1";
}

const ownerId = NodeCrypto.randomUUID();
let shuttingDown = false;
let restartTimer = null;
let currentApp = null;
let restartQueue = Promise.resolve();
const expectedExits = new WeakSet();
const appLaunchIds = new WeakMap();
const watchers = [];

function isCapturedPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function startApp() {
  if (shuttingDown || currentApp !== null) {
    return;
  }

  const electronArgs = remoteDebuggingPort
    ? [`--remote-debugging-port=${remoteDebuggingPort}`]
    : [];
  const launchArgs = devProtocolClient
    ? electronArgs
    : [...electronArgs, `--t3code-dev-root=${desktopDir}`, "dist-electron/main.cjs"];
  const electronCommand = resolveElectronLaunchCommand(launchArgs);
  const app = NodeChildProcess.spawn(electronCommand.electronPath, electronCommand.args, {
    cwd: desktopDir,
    env: childEnv,
    stdio: ["inherit", "inherit", "inherit", "ipc"],
  });
  const launchId = NodeCrypto.randomUUID();

  currentApp = app;
  appLaunchIds.set(app, launchId);
  if (typeof app.pid === "number") {
    recordSpawnedDevApp(
      () =>
        updateDevElectronApp(devPidFilePath, ownerId, null, { pid: app.pid, launchId }, desktopDir),
      () => {
        app.kill("SIGKILL");
      },
    );
  }

  app.once("error", () => {
    if (currentApp === app) {
      currentApp = null;
    }
    if (typeof app.pid === "number") {
      updateDevElectronApp(devPidFilePath, ownerId, launchId, null, desktopDir);
    }

    if (!shuttingDown) {
      scheduleRestart();
    }
  });

  app.once("exit", (code, signal) => {
    if (currentApp === app) {
      currentApp = null;
    }
    if (typeof app.pid === "number") {
      updateDevElectronApp(devPidFilePath, ownerId, launchId, null, desktopDir);
    }

    const exitedAbnormally = signal !== null || code !== 0;
    if (!shuttingDown && !expectedExits.has(app) && exitedAbnormally) {
      scheduleRestart();
    }
  });
}

async function stopApp() {
  const app = currentApp;
  if (!app) {
    return;
  }

  currentApp = null;
  expectedExits.add(app);
  const launchId = appLaunchIds.get(app);

  await new Promise((resolve) => {
    let settled = false;

    const finish = () => {
      if (settled) {
        return;
      }

      settled = true;
      if (typeof app.pid === "number" && typeof launchId === "string") {
        updateDevElectronApp(devPidFilePath, ownerId, launchId, null, desktopDir);
      }
      resolve();
    };

    app.once("exit", finish);
    let gracefulQuitRequested = false;
    if (app.connected) {
      try {
        app.send({ type: "picode-dev-shutdown" });
        gracefulQuitRequested = true;
      } catch {
        // Fall through to POSIX SIGTERM or the forced timeout.
      }
    }
    if (!gracefulQuitRequested && hostPlatform !== "win32") {
      app.kill("SIGTERM");
    }

    setTimeout(() => {
      if (settled) {
        return;
      }

      app.kill("SIGKILL");
      finish();
    }, forcedShutdownTimeoutMs).unref();
  });
}

function scheduleRestart() {
  if (shuttingDown) {
    return;
  }

  if (restartTimer) {
    clearTimeout(restartTimer);
  }

  restartTimer = setTimeout(() => {
    restartTimer = null;
    restartQueue = restartQueue
      .catch(() => undefined)
      .then(async () => {
        await stopApp();
        if (!shuttingDown) {
          startApp();
        }
      });
  }, restartDebounceMs);
}

function startWatchers() {
  for (const { directory, files } of watchedDirectories) {
    const watcher = NodeFS.watch(
      NodePath.join(desktopDir, directory),
      { persistent: true },
      (_eventType, filename) => {
        if (typeof filename !== "string" || !files.has(filename)) {
          return;
        }

        scheduleRestart();
      },
    );

    watchers.push(watcher);
  }
}

async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;

  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  for (const watcher of watchers) {
    watcher.close();
  }

  await settlePendingRestartBeforeShutdown(restartQueue, stopApp);
  await new Promise((resolve) => {
    setTimeout(resolve, childTreeGracePeriodMs);
  });
  clearDevElectronPids(devPidFilePath, ownerId, desktopDir);

  process.exit(exitCode);
}

process.once("SIGINT", () => {
  void shutdown(130);
});
process.once("SIGTERM", () => {
  void shutdown(143);
});
process.once("SIGHUP", () => {
  void shutdown(129);
});

const claim = claimDevElectronPids(
  devPidFilePath,
  { ownerId, runnerPid: process.pid, app: null },
  desktopDir,
  isCapturedPidAlive,
);
if (!claim.claimed) {
  throw new Error(
    `Could not claim the piCode dev runner PID file (${claim.reason}): ${devPidFilePath}. ` +
      "Stop any active dev runner or app. If none is running, remove that file and try again.",
  );
}

try {
  await waitForResources({
    baseDir: desktopDir,
    files: requiredFiles,
    tcpHost: devServer.hostname,
    tcpPort: port,
  });
  startWatchers();
  startApp();
} catch (error) {
  clearDevElectronPids(devPidFilePath, ownerId, desktopDir);
  throw error;
}
