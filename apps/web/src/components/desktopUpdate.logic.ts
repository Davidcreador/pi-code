import type {
  DesktopUpdateActionResult,
  DesktopUpdateCheckResult,
  DesktopUpdateState,
} from "@t3tools/contracts";
import { isWindowsPlatform } from "../lib/utils";

export type DesktopUpdateButtonAction = "download" | "install" | "none";

export function resolveDesktopUpdateButtonAction(
  state: DesktopUpdateState,
): DesktopUpdateButtonAction {
  if (state.errorContext === "install" && state.message) {
    return "none";
  }
  if (state.downloadedVersion) {
    return "install";
  }
  if (state.status === "available") {
    return "download";
  }
  return "none";
}

export function shouldShowDesktopUpdateButton(state: DesktopUpdateState | null): boolean {
  if (!state || !state.enabled) {
    return false;
  }
  if (state.status === "downloading") {
    return true;
  }
  return resolveDesktopUpdateButtonAction(state) !== "none";
}

export function shouldShowArm64IntelBuildWarning(state: DesktopUpdateState | null): boolean {
  return state?.hostArch === "arm64" && state.appArch === "x64";
}

export function isDesktopUpdateButtonDisabled(state: DesktopUpdateState | null): boolean {
  return state?.status === "downloading";
}

export function getArm64IntelBuildWarningDescription(state: DesktopUpdateState): string {
  if (!shouldShowArm64IntelBuildWarning(state)) {
    return "This install is using the correct architecture.";
  }

  const action = resolveDesktopUpdateButtonAction(state);
  if (action === "download") {
    return "This Mac has Apple Silicon, but piCode is still running the Intel build under Rosetta. Download the available update to switch to the native Apple Silicon build.";
  }
  if (action === "install") {
    return "This Mac has Apple Silicon, but piCode is still running the Intel build under Rosetta. Restart to install the downloaded Apple Silicon build.";
  }
  return "This Mac has Apple Silicon, but piCode is still running the Intel build under Rosetta. The next app update will replace it with the native Apple Silicon build.";
}

export function getDesktopUpdateButtonTooltip(state: DesktopUpdateState): string {
  if (state.message && state.errorContext === "download") {
    return state.availableVersion
      ? `Download failed for ${state.availableVersion}: ${state.message} Click to retry.`
      : state.message;
  }
  if (state.message && state.errorContext === "install") {
    return state.downloadedVersion
      ? `Install failed for ${state.downloadedVersion}: ${state.message} Check for updates before retrying.`
      : state.message;
  }
  if (state.status === "available") {
    return `Update ${state.availableVersion ?? "available"} ready to download`;
  }
  if (state.status === "downloading") {
    const progress =
      typeof state.downloadPercent === "number" ? ` (${Math.floor(state.downloadPercent)}%)` : "";
    return `Downloading update${progress}`;
  }
  if (state.status === "downloaded") {
    return `Update ${state.downloadedVersion ?? state.availableVersion ?? "ready"} downloaded. Click to restart and install.`;
  }
  if (state.status === "error") {
    return state.message ?? "Update failed";
  }
  return "Up to date";
}

export function getDesktopUpdateInstallConfirmationMessage(
  state: Pick<DesktopUpdateState, "availableVersion" | "downloadedVersion">,
  platform = "",
): string {
  const version = state.downloadedVersion ?? state.availableVersion;
  const windowsInstallWarning = isWindowsPlatform(platform)
    ? "\n\nOn Windows, piCode may remain closed for several minutes while the update installs, and no installer window may appear. piCode will reopen automatically when installation finishes."
    : "";
  return `Install update${version ? ` ${version}` : ""} and restart piCode?\n\nAny running tasks will be interrupted. Make sure you're ready before continuing.${windowsInstallWarning}`;
}

export function getDesktopUpdateActionError(result: DesktopUpdateActionResult): string | null {
  if (!result.accepted || result.completed) return null;
  if (typeof result.state.message !== "string") return null;
  const message = result.state.message.trim();
  return message.length > 0 ? message : null;
}

export function shouldToastDesktopUpdateActionResult(result: DesktopUpdateActionResult): boolean {
  return getDesktopUpdateActionError(result) !== null;
}

export function shouldHighlightDesktopUpdateError(state: DesktopUpdateState | null): boolean {
  if (!state?.message) return false;
  return state.errorContext === "download" || state.errorContext === "install";
}

export function getDesktopUpdateErrorAffordance(state: DesktopUpdateState | null): {
  readonly label: string;
  readonly message: string;
  readonly canCheck: boolean;
} | null {
  if (!state?.message || !shouldHighlightDesktopUpdateError(state)) return null;
  return {
    label: state.errorContext === "install" ? "Install failed — check again" : "Download failed",
    message: state.message,
    canCheck: canCheckForUpdate(state),
  };
}

export function canCheckForUpdate(state: DesktopUpdateState | null): boolean {
  if (!state || !state.enabled) return false;
  if (state.status === "downloaded") {
    return state.errorContext === "install" && Boolean(state.message?.trim());
  }
  return (
    state.status !== "checking" && state.status !== "downloading" && state.status !== "disabled"
  );
}

export function requestDesktopUpdateCheck(
  state: DesktopUpdateState | null,
  checkForUpdate: (() => Promise<DesktopUpdateCheckResult>) | undefined,
): Promise<DesktopUpdateCheckResult> | null {
  if (!canCheckForUpdate(state) || !checkForUpdate) return null;
  return checkForUpdate();
}
