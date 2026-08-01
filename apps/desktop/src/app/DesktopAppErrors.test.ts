import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import {
  buildRuntimeLayerWithFatalStartupReport,
  catchFatalStartupCause,
  describeFatalStartupError,
  handleFatalStartupError,
  DesktopBackendPortUnavailableError,
  DesktopDevelopmentBackendPortRequiredError,
} from "./DesktopApp.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as DesktopState from "./DesktopState.ts";

describe("DesktopApp errors", () => {
  it("preserves unavailable backend port context", () => {
    const error = new DesktopBackendPortUnavailableError({
      startPort: 3_773,
      maxPort: 65_535,
      hosts: ["127.0.0.1", "0.0.0.0", "::"],
    });

    assert.equal(error.startPort, 3_773);
    assert.equal(error.maxPort, 65_535);
    assert.deepEqual(error.hosts, ["127.0.0.1", "0.0.0.0", "::"]);
    assert.equal(
      error.message,
      "No desktop backend port is available on hosts 127.0.0.1, 0.0.0.0, :: between 3773 and 65535.",
    );
  });

  it("reports the required development port", () => {
    const error = new DesktopDevelopmentBackendPortRequiredError();

    assert.equal(error.message, "T3CODE_PORT is required in desktop development.");
  });

  it("formats startup failures before the application layer is available", () => {
    const error = new Error("safe storage unavailable");
    error.stack = "Error: safe storage unavailable\n    at startup";

    assert.deepEqual(describeFatalStartupError("runtime-layer", error), {
      title: "piCode failed to start",
      content:
        "Stage: runtime-layer\nsafe storage unavailable\nError: safe storage unavailable\n    at startup",
      message: "safe storage unavailable",
      detail: "\nError: safe storage unavailable\n    at startup",
    });
  });

  it.effect("runs fatal actions once for failures and preserves interruptions", () =>
    Effect.gen(function* () {
      let dialogCount = 0;
      let quitCount = 0;
      const onFatal = () =>
        Effect.sync(() => {
          dialogCount += 1;
          quitCount += 1;
          return "recovered" as const;
        });

      const recovered = yield* catchFatalStartupCause(Effect.fail("storage failed"), onFatal);
      assert.equal(recovered, "recovered");
      assert.equal(dialogCount, 1);
      assert.equal(quitCount, 1);

      const interrupted = yield* catchFatalStartupCause(Effect.interrupt, onFatal).pipe(
        Effect.exit,
      );
      assert.isTrue(Exit.isFailure(interrupted));
      if (Exit.isFailure(interrupted)) {
        assert.isTrue(Cause.hasInterruptsOnly(interrupted.cause));
      }
      assert.equal(dialogCount, 1);
      assert.equal(quitCount, 1);
    }),
  );

  it.effect("reports runtime-layer acquisition failures but not release failures", () =>
    Effect.gen(function* () {
      let reportCount = 0;
      const reportFatal = () =>
        Effect.sync(() => {
          reportCount += 1;
        });

      const acquisitionExit = yield* Effect.scoped(
        buildRuntimeLayerWithFatalStartupReport(
          Layer.effectDiscard(Effect.die("acquisition failed")),
          reportFatal,
        ),
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(acquisitionExit));
      assert.equal(reportCount, 1);

      const releaseExit = yield* Effect.scoped(
        buildRuntimeLayerWithFatalStartupReport(
          Layer.effectDiscard(
            Effect.acquireRelease(Effect.void, () => Effect.die("release failed")),
          ),
          reportFatal,
        ),
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(releaseExit));
      assert.equal(reportCount, 1);
    }),
  );

  it.effect(
    "shows one service-backed startup dialog before requesting shutdown and quitting",
    () => {
      const calls: Array<string> = [];
      const electronApp = ElectronApp.ElectronApp.of({
        ...ElectronApp.make,
        quit: Effect.sync(() => {
          calls.push("quit");
        }),
      });
      const electronDialog = ElectronDialog.ElectronDialog.of({
        ...ElectronDialog.make,
        showErrorBox: (title: string, content: string) =>
          Effect.sync(() => {
            calls.push("dialog");
            assert.equal(title, "piCode failed to start");
            assert.equal(content, "Stage: startup\nstorage failed");
          }),
      });

      return Effect.gen(function* () {
        const shutdown = yield* DesktopShutdown.DesktopShutdown;
        yield* handleFatalStartupError("startup", "storage failed");
        assert.deepEqual(calls, ["dialog", "quit"]);
        assert.equal(yield* shutdown.awaitRequest.pipe(Effect.as(true)), true);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            DesktopState.layer,
            DesktopShutdown.layer,
            Layer.succeed(ElectronApp.ElectronApp, electronApp),
            Layer.succeed(ElectronDialog.ElectronDialog, electronDialog),
          ),
        ),
      );
    },
  );
});
