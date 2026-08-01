import type { VcsDriver } from "../vcs/VcsDriver.ts";

export function isGitRepository(driver: VcsDriver["Service"], cwd: string) {
  return driver.isInsideWorkTree(cwd);
}
