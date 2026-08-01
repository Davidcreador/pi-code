import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createInitialDesktopUpdateState,
  reduceDesktopUpdateStateOnDownloadComplete,
  reduceDesktopUpdateStateOnInstallFailure,
  reduceDesktopUpdateStateOnUpdateAvailable,
} from "../../../../desktop/src/updates/updateMachine.ts";
import { getDesktopUpdateErrorAffordance, requestDesktopUpdateCheck } from "../desktopUpdate.logic";
import { SidebarUpdateFailureContent } from "./SidebarUpdatePill";

const runtimeInfo = {
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
} as const;

const available = reduceDesktopUpdateStateOnUpdateAvailable(
  {
    ...createInitialDesktopUpdateState("1.0.0", runtimeInfo, "latest"),
    enabled: true,
    status: "idle",
  },
  "1.1.0",
  "2026-07-31T00:00:00.000Z",
);
const failedInstall = reduceDesktopUpdateStateOnInstallFailure(
  reduceDesktopUpdateStateOnDownloadComplete(available, "1.1.0"),
  "backend restart failed",
);

describe("SidebarUpdatePill failed install", () => {
  it("renders a visible check-again affordance and invokes the check bridge", async () => {
    const affordance = getDesktopUpdateErrorAffordance(failedInstall);
    expect(affordance).not.toBeNull();
    if (!affordance) return;

    const markup = renderToStaticMarkup(
      createElement(SidebarUpdateFailureContent, { label: affordance.label }),
    );
    expect(markup).toContain("data-update-error-affordance");
    expect(markup).toContain("Install failed — check again");

    const checkForUpdate = vi.fn(async () => ({
      checked: true,
      state: { ...failedInstall, status: "checking" as const },
    }));
    const result = requestDesktopUpdateCheck(failedInstall, checkForUpdate);

    expect(result).not.toBeNull();
    await expect(result).resolves.toMatchObject({ checked: true });
    expect(checkForUpdate).toHaveBeenCalledOnce();
  });
});
