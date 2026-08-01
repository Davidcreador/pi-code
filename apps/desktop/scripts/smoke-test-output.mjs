import * as NodePath from "node:path";

export const DESKTOP_READY_PATTERN = "main window ready";

export function makeDesktopSmokeEnvironment(environment, smokeRoot) {
  const smokeHome = NodePath.join(smokeRoot, "home");
  return {
    ...environment,
    HOME: smokeHome,
    XDG_CONFIG_HOME: NodePath.join(smokeHome, ".config"),
    APPDATA: NodePath.join(smokeHome, "AppData", "Roaming"),
    LOCALAPPDATA: NodePath.join(smokeHome, "AppData", "Local"),
    D4_HOME: NodePath.join(smokeRoot, "d4"),
    VITE_DEV_SERVER_URL: "",
    ELECTRON_ENABLE_LOGGING: "1",
  };
}

export function evaluateDesktopSmokeOutput(output, options = {}) {
  const fatalPatterns = [
    "Cannot find module",
    "MODULE_NOT_FOUND",
    "Refused to execute",
    "Uncaught Error",
    "Uncaught TypeError",
    "Uncaught ReferenceError",
  ];
  const failures = fatalPatterns.filter((pattern) => output.includes(pattern));
  if (!output.includes(DESKTOP_READY_PATTERN)) {
    failures.push("Desktop main-window readiness signal was not observed");
  }
  if (options.timedOut === true) {
    failures.push("Desktop smoke test timed out");
  }
  return failures;
}
