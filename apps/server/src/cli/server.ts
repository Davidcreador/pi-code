import * as Effect from "effect/Effect";
import { Command, GlobalFlag } from "effect/unstable/cli";

import { waitForDesktopParentExit } from "../bootstrap.ts";
import { ServerConfig, type StartupPresentation } from "../config.ts";
import { runServer } from "../server.ts";
import { type CliServerFlags, resolveServerConfig, sharedServerCommandFlags } from "./config.ts";

export const runServerCommand = (
  flags: CliServerFlags,
  options?: {
    readonly startupPresentation?: StartupPresentation;
    readonly forceAutoBootstrapProjectFromCwd?: boolean;
  },
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveServerConfig(flags, logLevel, options);
    const server = runServer.pipe(Effect.provideService(ServerConfig, config));
    if (config.desktopParentLivenessFd === undefined) {
      return yield* server;
    }
    return yield* Effect.raceFirst(
      server,
      waitForDesktopParentExit(config.desktopParentLivenessFd, config.desktopParentPid),
    );
  });

export const startCommand = Command.make("start", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription("Run the piCode server."),
  Command.withHandler((flags) => runServerCommand(flags)),
);

export const serveCommand = Command.make("serve", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription(
    "Run the piCode server without opening a browser and print headless pairing details.",
  ),
  Command.withHandler((flags) =>
    runServerCommand(flags, {
      startupPresentation: "headless",
      forceAutoBootstrapProjectFromCwd: false,
    }),
  ),
);
