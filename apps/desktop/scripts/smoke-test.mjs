import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { resolveElectronLaunchCommand } from "./electron-launcher.mjs";
import {
  DESKTOP_READY_PATTERN,
  evaluateDesktopSmokeOutput,
  makeDesktopSmokeEnvironment,
} from "./smoke-test-output.mjs";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const desktopDir = NodePath.resolve(__dirname, "..");
const mainJs = NodePath.resolve(desktopDir, "dist-electron/main.cjs");
const smokeRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "picode-desktop-smoke-"));
const smokeHome = NodePath.join(smokeRoot, "home");
NodeFS.mkdirSync(smokeHome, { recursive: true });

console.log("\nLaunching Electron smoke test...");

const electronCommand = resolveElectronLaunchCommand([mainJs]);
const child = NodeChildProcess.spawn(electronCommand.electronPath, electronCommand.args, {
  stdio: ["pipe", "pipe", "pipe"],
  env: makeDesktopSmokeEnvironment(process.env, smokeRoot),
});

let output = "";
let ready = false;
let timedOut = false;
let spawnError;
let readyStopTimer;
let forceKillTimer;
let stopRequested = false;
const requestStop = () => {
  if (stopRequested) return;
  stopRequested = true;
  child.kill();
  forceKillTimer = setTimeout(() => {
    child.kill("SIGKILL");
  }, 2_000);
};
const captureOutput = (chunk) => {
  output += chunk.toString();
  if (!ready && !timedOut && output.includes(DESKTOP_READY_PATTERN)) {
    ready = true;
    readyStopTimer = setTimeout(requestStop, 500);
  }
};
child.stdout.on("data", captureOutput);
child.stderr.on("data", captureOutput);
child.on("error", (error) => {
  spawnError = error;
});

const timeout = setTimeout(() => {
  timedOut = true;
  requestStop();
}, 8_000);

child.on("close", () => {
  clearTimeout(timeout);
  clearTimeout(readyStopTimer);
  clearTimeout(forceKillTimer);
  const failures = evaluateDesktopSmokeOutput(output, { timedOut });
  if (spawnError) failures.unshift(`Electron failed to start: ${spawnError.message}`);

  try {
    NodeFS.rmSync(smokeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    failures.push(`Failed to remove isolated smoke state: ${error.message}`);
  }

  if (failures.length > 0) {
    console.error("\nDesktop smoke test failed:");
    for (const failure of failures) {
      console.error(` - ${failure}`);
    }
    console.error("\nFull output:\n" + output);
    process.exit(1);
  }

  console.log("Desktop smoke test passed.");
  process.exit(0);
});
