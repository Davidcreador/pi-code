import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const RECORD_VERSION = 1;

export function encodeDevElectronPids(record, desktopRoot) {
  return `${JSON.stringify({ version: RECORD_VERSION, desktopRoot, ...record })}\n`;
}

export function decodeDevElectronPids(value, desktopRoot) {
  try {
    const parsed = JSON.parse(value);
    const app = parsed?.app;
    if (
      parsed?.version !== RECORD_VERSION ||
      parsed.desktopRoot !== desktopRoot ||
      typeof parsed.ownerId !== "string" ||
      parsed.ownerId.length === 0 ||
      !Number.isSafeInteger(parsed.runnerPid) ||
      parsed.runnerPid <= 0 ||
      (app !== null &&
        (!Number.isSafeInteger(app?.pid) ||
          app.pid <= 0 ||
          typeof app.launchId !== "string" ||
          app.launchId.length === 0))
    ) {
      return null;
    }
    return {
      ownerId: parsed.ownerId,
      runnerPid: parsed.runnerPid,
      app: app === null ? null : { pid: app.pid, launchId: app.launchId },
    };
  } catch {
    return null;
  }
}

export function readDevElectronPids(pidFilePath, desktopRoot) {
  try {
    return decodeDevElectronPids(NodeFS.readFileSync(pidFilePath, "utf8"), desktopRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function writeNewRecord(pidFilePath, record, desktopRoot) {
  const fd = NodeFS.openSync(pidFilePath, "wx");
  try {
    NodeFS.writeFileSync(fd, encodeDevElectronPids(record, desktopRoot), "utf8");
  } finally {
    NodeFS.closeSync(fd);
  }
}

function replaceRecord(pidFilePath, record, desktopRoot) {
  const temporaryPath = `${pidFilePath}.${record.ownerId}.tmp`;
  try {
    NodeFS.writeFileSync(temporaryPath, encodeDevElectronPids(record, desktopRoot), "utf8");
    NodeFS.renameSync(temporaryPath, pidFilePath);
  } finally {
    NodeFS.rmSync(temporaryPath, { force: true });
  }
}

export function claimDevElectronPids(pidFilePath, record, desktopRoot, isPidAlive) {
  NodeFS.mkdirSync(NodePath.dirname(pidFilePath), { recursive: true });
  try {
    writeNewRecord(pidFilePath, record, desktopRoot);
    return { claimed: true };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }

  const existing = readDevElectronPids(pidFilePath, desktopRoot);
  if (existing === null) return { claimed: false, reason: "invalid-record" };
  if (isPidAlive(existing.runnerPid) || (existing.app !== null && isPidAlive(existing.app.pid))) {
    return { claimed: false, reason: "active-process" };
  }
  return { claimed: false, reason: "stale-record" };
}

export function updateDevElectronApp(pidFilePath, ownerId, expectedLaunchId, app, desktopRoot) {
  const current = readDevElectronPids(pidFilePath, desktopRoot);
  if (current?.ownerId !== ownerId || (current.app?.launchId ?? null) !== expectedLaunchId) {
    return false;
  }
  replaceRecord(pidFilePath, { ...current, app }, desktopRoot);
  return true;
}

export function clearDevElectronPids(pidFilePath, ownerId, desktopRoot) {
  if (readDevElectronPids(pidFilePath, desktopRoot)?.ownerId !== ownerId) return false;
  NodeFS.rmSync(pidFilePath, { force: true });
  return true;
}
