import { assert, describe, it, vi } from "vite-plus/test";

import {
  recordSpawnedDevApp,
  settlePendingRestartBeforeShutdown,
} from "./dev-electron-lifecycle.mjs";

describe("dev Electron lifecycle", () => {
  it("kills a spawned app when recording returns false or throws", () => {
    const kill = vi.fn();

    assert.throws(() => recordSpawnedDevApp(() => false, kill), /Lost ownership/);
    assert.equal(kill.mock.calls.length, 1);

    const writeFailure = new Error("disk full");
    let thrown;
    try {
      recordSpawnedDevApp(() => {
        throw writeFailure;
      }, kill);
    } catch (error) {
      thrown = error;
    }
    assert.strictEqual(thrown, writeFailure);
    assert.equal(kill.mock.calls.length, 2);
  });

  it("waits for an in-flight restart stop before running the final stop", async () => {
    let releaseRestart;
    const order = [];
    const restartQueue = new Promise((resolve) => {
      releaseRestart = () => {
        order.push("restart-settled");
        resolve();
      };
    });
    const shutdown = settlePendingRestartBeforeShutdown(restartQueue, async () => {
      order.push("final-stop");
    });

    await Promise.resolve();
    assert.deepEqual(order, []);
    releaseRestart();
    await shutdown;
    assert.deepEqual(order, ["restart-settled", "final-stop"]);
  });
});
