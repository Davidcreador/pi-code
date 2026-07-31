/**
 * PiProvider — snapshot probing for the pi driver.
 *
 * The pinned Pi runtime answers version; a short-lived RPC process answers
 * the model catalog (`get_available_models`),
 * thinking levels (`get_available_thinking_levels`), and slash commands
 * (`get_commands` — extension commands, prompt templates, and skills, all
 * invokable with a `/` prefix). Pi resolves provider credentials itself, so
 * auth reports authenticated exactly when the catalog is non-empty.
 *
 * @module PiProvider
 */
import type {
  PiSettings,
  ProviderOptionChoice,
  ServerProviderModel,
  ServerProviderSlashCommand,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { buildServerProvider, type ServerProviderDraft } from "../providerSnapshot.ts";
import { PiRpcError, type PiRpcRecord, spawnPiRpc } from "../piRpc.ts";
import { piRpcCapabilityIssue, resolvePiRuntimeCommand } from "../piRuntime.ts";

const PI_PRESENTATION = {
  displayName: "Pi",
  showInteractionModeToggle: false,
} as const;

const checkedAtNow = Effect.map(DateTime.now, DateTime.formatIso);

export const makePendingPiProvider = (piSettings: PiSettings): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* checkedAtNow;
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: [],
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: piSettings.enabled
          ? "Pi provider status has not been checked in this session yet."
          : "Pi is disabled in settings.",
      },
    });
  });

function thinkingLevelChoices(
  record: PiRpcRecord | undefined,
): ReadonlyArray<ProviderOptionChoice> {
  const levels = record?.data as Record<string, unknown> | undefined;
  const values = Array.isArray(levels?.levels) ? levels.levels : [];
  return values
    .filter((level): level is string => typeof level === "string" && level.length > 0)
    .map((level) => ({ id: level, label: level }));
}

/** Slug of the model pi currently has selected (its own default resolution). */
function currentModelSlug(record: PiRpcRecord | undefined): string | undefined {
  const data = record?.data as Record<string, unknown> | undefined;
  const model = data?.model as Record<string, unknown> | undefined;
  return typeof model?.provider === "string" && typeof model?.id === "string"
    ? `${model.provider}/${model.id}`
    : undefined;
}

function modelsFromCatalog(
  record: PiRpcRecord,
  effortChoices: ReadonlyArray<ProviderOptionChoice>,
  defaultSlug: string | undefined,
): ReadonlyArray<ServerProviderModel> {
  const data = record.data as Record<string, unknown> | undefined;
  const entries = Array.isArray(data?.models) ? data.models : [];
  const reasoningCapabilities =
    effortChoices.length > 0
      ? {
          optionDescriptors: [
            {
              id: "effort",
              label: "Thinking",
              type: "select" as const,
              options: effortChoices,
            },
          ],
        }
      : null;
  const models: Array<ServerProviderModel> = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const model = entry as Record<string, unknown>;
    if (typeof model.provider !== "string" || typeof model.id !== "string") {
      continue;
    }
    const slug = `${model.provider}/${model.id}`;
    models.push({
      slug,
      name: typeof model.name === "string" && model.name.length > 0 ? model.name : model.id,
      subProvider: model.provider,
      isCustom: false,
      ...(slug === defaultSlug ? { isDefault: true } : {}),
      capabilities: model.reasoning === true ? reasoningCapabilities : null,
    });
  }
  return models;
}

function slashCommandsFromCatalog(record: PiRpcRecord): ReadonlyArray<ServerProviderSlashCommand> {
  const data = record.data as Record<string, unknown> | undefined;
  const entries = Array.isArray(data?.commands) ? data.commands : [];
  const commands: Array<ServerProviderSlashCommand> = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const command = entry as Record<string, unknown>;
    if (typeof command.name !== "string" || command.name.length === 0) {
      continue;
    }
    commands.push({
      name: command.name,
      ...(typeof command.description === "string" && command.description.length > 0
        ? { description: command.description }
        : {}),
    });
  }
  return commands;
}

export const checkPiProviderStatus = Effect.fn("checkPiProviderStatus")(function* (
  piSettings: PiSettings,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
) {
  const checkedAt = yield* checkedAtNow;
  if (!piSettings.enabled) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: false,
      checkedAt,
      models: [],
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Pi is disabled in settings.",
      },
    });
  }

  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const cliRuntime = resolvePiRuntimeCommand({
    piSettings,
    entry: "cli",
    ...(environment ? { environment } : {}),
  });
  const rpcRuntime = resolvePiRuntimeCommand({
    piSettings,
    entry: "rpc",
    ...(environment ? { environment } : {}),
  });

  const version = yield* spawner
    .string(
      ChildProcess.make(cliRuntime.binaryPath, [...cliRuntime.argsPrefix, "--version"], {
        cwd,
        ...(cliRuntime.environment ? { env: cliRuntime.environment } : { extendEnv: true }),
      }),
    )
    .pipe(
      Effect.map((output) => output.trim()),
      Effect.orElseSucceed(() => ""),
    );

  if (version.length === 0) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: [],
      probe: {
        installed: false,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: `Pi runtime failed to start (${cliRuntime.binaryPath}).`,
      },
    });
  }

  // One throwaway RPC process answers catalog questions, then dies with the
  // scope. `--no-session` keeps it out of pi's session storage.
  const catalog = yield* Effect.scoped(
    Effect.gen(function* () {
      const rpc = yield* spawnPiRpc({
        binaryPath: rpcRuntime.binaryPath,
        args: [...rpcRuntime.argsPrefix, "--no-session"],
        cwd,
        ...(rpcRuntime.environment ? { environment: rpcRuntime.environment } : {}),
      });
      const capabilities = yield* rpc.request({ type: "get_capabilities" });
      const capabilityIssue = piRpcCapabilityIssue(capabilities);
      if (capabilityIssue !== undefined) {
        return yield* new PiRpcError({
          operation: "get_capabilities",
          detail: `Incompatible pi RPC runtime: ${capabilityIssue}.`,
        });
      }
      const models = yield* rpc.request({ type: "get_available_models" });
      const state = yield* rpc.request({ type: "get_state" }).pipe(Effect.option);
      const thinkingLevels = yield* rpc
        .request({ type: "get_available_thinking_levels" })
        .pipe(Effect.option);
      const commands = yield* rpc.request({ type: "get_commands" }).pipe(Effect.option);
      return { models, state, thinkingLevels, commands };
    }),
  ).pipe(Effect.catch((cause) => Effect.succeed({ probeFailure: cause.detail })));

  if ("probeFailure" in catalog) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: [],
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `pi RPC probe failed: ${catalog.probeFailure}`,
      },
    });
  }

  const effortChoices = thinkingLevelChoices(
    catalog.thinkingLevels._tag === "Some" ? catalog.thinkingLevels.value : undefined,
  );
  const models = modelsFromCatalog(
    catalog.models,
    effortChoices,
    currentModelSlug(catalog.state._tag === "Some" ? catalog.state.value : undefined),
  );
  const slashCommands =
    catalog.commands._tag === "Some" ? slashCommandsFromCatalog(catalog.commands.value) : [];

  return buildServerProvider({
    presentation: PI_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    slashCommands,
    probe: {
      installed: true,
      version,
      status: models.length > 0 ? "ready" : "warning",
      auth: { status: models.length > 0 ? "authenticated" : "unknown" },
      ...(models.length === 0
        ? { message: "pi reported no available models. Configure provider API keys for pi." }
        : {}),
    },
  });
});
