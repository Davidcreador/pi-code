import { describe, expect, it } from "vite-plus/test";
import type { DesktopUpdateActionResult, DesktopUpdateState } from "@t3tools/contracts";

import {
  createInitialDesktopUpdateState,
  reduceDesktopUpdateStateOnDownloadComplete,
  reduceDesktopUpdateStateOnDownloadFailure,
  reduceDesktopUpdateStateOnDownloadStart,
  reduceDesktopUpdateStateOnInstallFailure,
  reduceDesktopUpdateStateOnUpdateAvailable,
} from "../../../desktop/src/updates/updateMachine.ts";
import {
  canCheckForUpdate,
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateErrorAffordance,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldHighlightDesktopUpdateError,
  shouldShowArm64IntelBuildWarning,
  shouldShowDesktopUpdateButton,
  shouldToastDesktopUpdateActionResult,
} from "./desktopUpdate.logic";

const runtimeInfo = {
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
} as const;

const baseState: DesktopUpdateState = {
  ...createInitialDesktopUpdateState("1.0.0", runtimeInfo, "latest"),
  enabled: true,
  status: "idle",
};

const availableState = reduceDesktopUpdateStateOnUpdateAvailable(
  baseState,
  "1.1.0",
  "2026-07-31T00:00:00.000Z",
);
const failedDownloadState = reduceDesktopUpdateStateOnDownloadFailure(
  reduceDesktopUpdateStateOnDownloadStart(availableState),
  "network timeout",
);
const downloadedState = reduceDesktopUpdateStateOnDownloadComplete(availableState, "1.1.0");
const failedInstallState = reduceDesktopUpdateStateOnInstallFailure(
  downloadedState,
  "shutdown timeout",
);

describe("desktop update button state", () => {
  it("shows a download action when an update is available", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "available",
      availableVersion: "1.1.0",
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(true);
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
  });

  it("keeps retry action and error treatment after a reducer download failure", () => {
    expect(failedDownloadState.status).toBe("available");
    expect(shouldShowDesktopUpdateButton(failedDownloadState)).toBe(true);
    expect(resolveDesktopUpdateButtonAction(failedDownloadState)).toBe("download");
    expect(getDesktopUpdateButtonTooltip(failedDownloadState)).toContain("network timeout");
    expect(getDesktopUpdateButtonTooltip(failedDownloadState)).toContain("Click to retry");
    expect(shouldHighlightDesktopUpdateError(failedDownloadState)).toBe(true);
  });

  it("replaces install retry with a check action after a reducer install failure", () => {
    expect(failedInstallState.status).toBe("downloaded");
    expect(shouldShowDesktopUpdateButton(failedInstallState)).toBe(false);
    expect(resolveDesktopUpdateButtonAction(failedInstallState)).toBe("none");
    expect(canCheckForUpdate(failedInstallState)).toBe(true);
    expect(getDesktopUpdateButtonTooltip(failedInstallState)).toContain("shutdown timeout");
    expect(getDesktopUpdateButtonTooltip(failedInstallState)).toContain(
      "Check for updates before retrying",
    );
    expect(shouldHighlightDesktopUpdateError(failedInstallState)).toBe(true);
    expect(getDesktopUpdateErrorAffordance(failedInstallState)).toEqual({
      label: "Install failed — check again",
      message: "shutdown timeout",
      canCheck: true,
    });
  });

  it("prefers install when a downloaded version already exists", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "available",
      availableVersion: "1.1.0",
      downloadedVersion: "1.1.0",
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("install");
  });

  it("hides the button for non-actionable check errors", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      message: "network unavailable",
      errorContext: "check",
      canRetry: true,
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(false);
    expect(resolveDesktopUpdateButtonAction(state)).toBe("none");
  });

  it("disables the button while downloading", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "downloading",
      availableVersion: "1.1.0",
      downloadPercent: 42.5,
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(true);
    expect(isDesktopUpdateButtonDisabled(state)).toBe(true);
    expect(getDesktopUpdateButtonTooltip(state)).toContain("42%");
  });
});

describe("getDesktopUpdateActionError", () => {
  it("returns user-visible message for accepted failed attempts", () => {
    const state = reduceDesktopUpdateStateOnDownloadFailure(
      reduceDesktopUpdateStateOnDownloadStart(availableState),
      "checksum mismatch",
    );
    const result: DesktopUpdateActionResult = {
      accepted: true,
      completed: false,
      state,
    };
    expect(getDesktopUpdateActionError(result)).toBe("checksum mismatch");
  });

  it("ignores messages for non-accepted attempts", () => {
    const result: DesktopUpdateActionResult = {
      accepted: false,
      completed: false,
      state: {
        ...baseState,
        status: "error",
        message: "background failure",
        errorContext: "check",
        canRetry: false,
      },
    };
    expect(getDesktopUpdateActionError(result)).toBeNull();
  });

  it("ignores messages for successful attempts", () => {
    const result: DesktopUpdateActionResult = {
      accepted: true,
      completed: true,
      state: {
        ...baseState,
        status: "downloaded",
        downloadedVersion: "1.1.0",
        availableVersion: "1.1.0",
        message: null,
        errorContext: null,
        canRetry: true,
      },
    };
    expect(getDesktopUpdateActionError(result)).toBeNull();
  });
});

describe("desktop update UI helpers", () => {
  it("toasts only for actionable updater errors", () => {
    expect(
      shouldToastDesktopUpdateActionResult({
        accepted: true,
        completed: false,
        state: { ...baseState, message: "checksum mismatch" },
      }),
    ).toBe(true);
    expect(
      shouldToastDesktopUpdateActionResult({
        accepted: true,
        completed: false,
        state: { ...baseState, message: null },
      }),
    ).toBe(false);
    expect(
      shouldToastDesktopUpdateActionResult({
        accepted: true,
        completed: true,
        state: { ...baseState, message: "checksum mismatch" },
      }),
    ).toBe(false);
  });

  it("shows an Apple Silicon warning for Intel builds under Rosetta", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      hostArch: "arm64",
      appArch: "x64",
      runningUnderArm64Translation: true,
    };

    expect(shouldShowArm64IntelBuildWarning(state)).toBe(true);
    expect(getArm64IntelBuildWarningDescription(state)).toContain("Apple Silicon");
    expect(getArm64IntelBuildWarningDescription(state)).toContain("Intel build");
  });

  it("changes the warning copy when a native build update is ready to download", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      hostArch: "arm64",
      appArch: "x64",
      runningUnderArm64Translation: true,
      status: "available",
      availableVersion: "1.1.0",
    };

    expect(getArm64IntelBuildWarningDescription(state)).toContain("Download the available update");
  });

  it("includes the downloaded version in the install confirmation copy", () => {
    expect(
      getDesktopUpdateInstallConfirmationMessage({
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.1",
      }),
    ).toContain("Install update 1.1.1 and restart piCode?");
  });

  it("falls back to generic install confirmation copy when no version is available", () => {
    expect(
      getDesktopUpdateInstallConfirmationMessage({
        availableVersion: null,
        downloadedVersion: null,
      }),
    ).toContain("Install update and restart piCode?");
  });

  it("warns Windows users that a silent installation can take several minutes", () => {
    const message = getDesktopUpdateInstallConfirmationMessage(
      {
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.0",
      },
      "Win32",
    );

    expect(message).toContain("may remain closed for several minutes");
    expect(message).toContain("no installer window may appear");
    expect(message).toContain("will reopen automatically");
  });

  it("keeps the additional silent installation warning Windows-specific", () => {
    const message = getDesktopUpdateInstallConfirmationMessage(
      {
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.0",
      },
      "MacIntel",
    );

    expect(message).not.toContain("may remain closed for several minutes");
  });
});

describe("canCheckForUpdate", () => {
  it("returns false for null state", () => {
    expect(canCheckForUpdate(null)).toBe(false);
  });

  it("returns false when updates are disabled", () => {
    expect(canCheckForUpdate({ ...baseState, enabled: false, status: "disabled" })).toBe(false);
  });

  it("returns false while checking", () => {
    expect(canCheckForUpdate({ ...baseState, status: "checking" })).toBe(false);
  });

  it("returns false while downloading", () => {
    expect(canCheckForUpdate({ ...baseState, status: "downloading", downloadPercent: 50 })).toBe(
      false,
    );
  });

  it("returns false once an update has been downloaded successfully", () => {
    expect(canCheckForUpdate(downloadedState)).toBe(false);
    expect(resolveDesktopUpdateButtonAction(downloadedState)).toBe("install");
    expect(shouldHighlightDesktopUpdateError(downloadedState)).toBe(false);
  });

  it("returns true after an install failure so the user can manually re-check", () => {
    expect(canCheckForUpdate(failedInstallState)).toBe(true);
  });

  it("returns true when idle", () => {
    expect(canCheckForUpdate({ ...baseState, status: "idle" })).toBe(true);
  });

  it("returns true when up-to-date", () => {
    expect(canCheckForUpdate({ ...baseState, status: "up-to-date" })).toBe(true);
  });

  it("returns true when an update is available", () => {
    expect(
      canCheckForUpdate({ ...baseState, status: "available", availableVersion: "1.1.0" }),
    ).toBe(true);
  });

  it("returns true on error so the user can retry", () => {
    expect(
      canCheckForUpdate({
        ...baseState,
        status: "error",
        errorContext: "check",
        message: "network",
      }),
    ).toBe(true);
  });
});

describe("getDesktopUpdateButtonTooltip", () => {
  it("returns 'Up to date' for non-actionable states", () => {
    expect(getDesktopUpdateButtonTooltip({ ...baseState, status: "idle" })).toBe("Up to date");
    expect(getDesktopUpdateButtonTooltip({ ...baseState, status: "up-to-date" })).toBe(
      "Up to date",
    );
  });
});
