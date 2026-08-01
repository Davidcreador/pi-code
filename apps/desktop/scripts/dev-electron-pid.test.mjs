import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "vite-plus/test";

import {
  claimDevElectronPids,
  clearDevElectronPids,
  decodeDevElectronPids,
  readDevElectronPids,
  updateDevElectronApp,
} from "./dev-electron-pid.mjs";

const desktopRoot = "/repo/apps/desktop";
const firstOwner = { ownerId: "owner-1", runnerPid: 1234, app: null };

describe("dev Electron PID file", () => {
  it("accepts only versioned records for the same desktop root", () => {
    const record = JSON.stringify({
      version: 1,
      desktopRoot,
      ownerId: "owner-1",
      runnerPid: 1234,
      app: { pid: 5678, launchId: "launch-1" },
    });

    assert.deepEqual(decodeDevElectronPids(record, desktopRoot), {
      ownerId: "owner-1",
      runnerPid: 1234,
      app: { pid: 5678, launchId: "launch-1" },
    });
    assert.equal(decodeDevElectronPids(record, "/other/apps/desktop"), null);
    assert.equal(decodeDevElectronPids("not json", desktopRoot), null);
  });

  it("claims atomically and reclaims only records whose captured processes exited", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "picode-dev-pid-"));
    const pidFilePath = NodePath.join(directory, "dev-electron.pid");

    try {
      assert.deepEqual(
        claimDevElectronPids(pidFilePath, firstOwner, desktopRoot, () => false),
        { claimed: true },
      );
      assert.deepEqual(
        claimDevElectronPids(
          pidFilePath,
          { ownerId: "owner-2", runnerPid: 5678, app: null },
          desktopRoot,
          () => true,
        ),
        { claimed: false, reason: "active-process" },
      );
      assert.deepEqual(
        claimDevElectronPids(
          pidFilePath,
          { ownerId: "owner-2", runnerPid: 5678, app: null },
          desktopRoot,
          () => false,
        ),
        { claimed: false, reason: "stale-record" },
      );
      NodeFS.rmSync(pidFilePath);
      assert.deepEqual(
        claimDevElectronPids(
          pidFilePath,
          { ownerId: "owner-2", runnerPid: 5678, app: null },
          desktopRoot,
          () => false,
        ),
        { claimed: true },
      );
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not let a delayed old-app exit clear its replacement", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "picode-dev-pid-"));
    const pidFilePath = NodePath.join(directory, "dev-electron.pid");

    try {
      assert.isTrue(
        claimDevElectronPids(pidFilePath, firstOwner, desktopRoot, () => false).claimed,
      );
      assert.isTrue(
        updateDevElectronApp(
          pidFilePath,
          firstOwner.ownerId,
          null,
          { pid: 5678, launchId: "launch-1" },
          desktopRoot,
        ),
      );
      assert.isTrue(
        updateDevElectronApp(
          pidFilePath,
          firstOwner.ownerId,
          "launch-1",
          { pid: 6789, launchId: "launch-2" },
          desktopRoot,
        ),
      );
      assert.isFalse(
        updateDevElectronApp(pidFilePath, firstOwner.ownerId, "launch-1", null, desktopRoot),
      );
      assert.deepEqual(readDevElectronPids(pidFilePath, desktopRoot)?.app, {
        pid: 6789,
        launchId: "launch-2",
      });
      assert.isFalse(clearDevElectronPids(pidFilePath, "other-owner", desktopRoot));
      assert.isTrue(clearDevElectronPids(pidFilePath, firstOwner.ownerId, desktopRoot));
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});
