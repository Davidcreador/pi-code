import { fileURLToPath } from "node:url";

import type { PiSettings } from "@t3tools/contracts";

import type { PiRpcRecord } from "./piRpc.ts";

const piPackageEntryUrl = import.meta.resolve("@earendil-works/pi-coding-agent");

export const PI_RPC_PROTOCOL_VERSION = 1;
export const PI_RPC_CAPABILITIES = [
  "navigate_tree",
  "abort_branch_summary",
  "reload",
  "set_entry_label",
  "safe_settings",
  "scoped_models",
  "session_management",
  "project_trust",
  "changelog",
  "auth",
] as const;

export interface PiRuntimeCommand {
  readonly binaryPath: string;
  readonly argsPrefix: ReadonlyArray<string>;
  readonly environment?: NodeJS.ProcessEnv;
}

export function resolvePiRuntimeCommand(input: {
  readonly piSettings: PiSettings;
  readonly entry: "cli" | "rpc";
  readonly environment?: NodeJS.ProcessEnv;
  readonly executablePath?: string;
  readonly isElectron?: boolean;
}): PiRuntimeCommand {
  const configuredBinary = input.piSettings.binaryPath.trim();
  if (configuredBinary.length > 0 && configuredBinary !== "pi") {
    return {
      binaryPath: configuredBinary,
      argsPrefix: input.entry === "rpc" ? ["--mode", "rpc"] : [],
      ...(input.environment ? { environment: input.environment } : {}),
    };
  }

  const entryPath = fileURLToPath(
    new URL(input.entry === "rpc" ? "rpc-entry.js" : "cli.js", piPackageEntryUrl),
  );
  const isElectron = input.isElectron ?? process.versions.electron !== undefined;
  const environment = input.environment ?? process.env;
  return {
    binaryPath: input.executablePath ?? process.execPath,
    argsPrefix: [entryPath],
    environment: isElectron ? { ...environment, ELECTRON_RUN_AS_NODE: "1" } : environment,
  };
}

export function piRpcCapabilityIssue(response: PiRpcRecord): string | undefined {
  const data = response.data as Record<string, unknown> | undefined;
  if (data?.protocolVersion !== PI_RPC_PROTOCOL_VERSION) {
    return `expected protocol version ${PI_RPC_PROTOCOL_VERSION}`;
  }
  const capabilities = Array.isArray(data.capabilities) ? data.capabilities : [];
  const missing = PI_RPC_CAPABILITIES.filter((capability) => !capabilities.includes(capability));
  return missing.length > 0 ? `missing capabilities: ${missing.join(", ")}` : undefined;
}
