// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeReadline from "node:readline";
import type * as NodeStream from "node:stream";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

export class BootstrapFdStatError extends Schema.TaggedErrorClass<BootstrapFdStatError>()(
  "BootstrapFdStatError",
  {
    fd: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to stat bootstrap file descriptor ${this.fd}.`;
  }
}

export class BootstrapInputStreamOpenError extends Schema.TaggedErrorClass<BootstrapInputStreamOpenError>()(
  "BootstrapInputStreamOpenError",
  {
    fd: Schema.Number,
    platform: Schema.String,
    fdPath: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const path = this.fdPath === undefined ? "" : ` via '${this.fdPath}'`;
    return `Failed to open bootstrap input stream for file descriptor ${this.fd}${path} on '${this.platform}'.`;
  }
}

export class BootstrapEnvelopeReadError extends Schema.TaggedErrorClass<BootstrapEnvelopeReadError>()(
  "BootstrapEnvelopeReadError",
  {
    fd: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read bootstrap envelope from file descriptor ${this.fd}.`;
  }
}

export class BootstrapEnvelopeDecodeError extends Schema.TaggedErrorClass<BootstrapEnvelopeDecodeError>()(
  "BootstrapEnvelopeDecodeError",
  {
    fd: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode bootstrap envelope from file descriptor ${this.fd}.`;
  }
}

export class DesktopParentLivenessSetupError extends Schema.TaggedErrorClass<DesktopParentLivenessSetupError>()(
  "DesktopParentLivenessSetupError",
  {
    reason: Schema.Literals(["missing-bootstrap-fd", "missing-bootstrap-envelope"]),
    fd: Schema.optional(Schema.Number),
  },
) {
  override get message(): string {
    return this.fd === undefined
      ? "Desktop parent liveness requires a bootstrap file descriptor."
      : `Desktop parent liveness received no bootstrap envelope from file descriptor ${this.fd}.`;
  }
}

export const BootstrapError = Schema.Union([
  BootstrapFdStatError,
  BootstrapInputStreamOpenError,
  BootstrapEnvelopeReadError,
  BootstrapEnvelopeDecodeError,
  DesktopParentLivenessSetupError,
]);
export type BootstrapError = typeof BootstrapError.Type;

const preservedBootstrapStreams = new Map<number, NodeStream.Readable>();

export const readBootstrapEnvelope = Effect.fn("readBootstrapEnvelope")(function* <A, I>(
  schema: Schema.Codec<A, I>,
  fd: number,
  options?: {
    timeoutMs?: number;
    preserveFd?: boolean;
  },
): Effect.fn.Return<Option.Option<A>, BootstrapError> {
  const fdReady = yield* isFdReady(fd);
  if (!fdReady) return Option.none();

  const stream = yield* makeBootstrapInputStream(fd, options?.preserveFd === true);

  const timeoutMs = options?.timeoutMs ?? 1000;

  return yield* Effect.callback<
    Option.Option<A>,
    BootstrapEnvelopeReadError | BootstrapEnvelopeDecodeError
  >((resume) => {
    const input = NodeReadline.createInterface({
      input: stream,
      crlfDelay: Infinity,
    });

    let settled = false;
    const cleanup = (destroyStream: boolean) => {
      stream.removeListener("error", handleError);
      input.removeListener("line", handleLine);
      input.removeListener("close", handleClose);
      input.close();
      if (destroyStream) stream.destroy();
    };
    const complete = (
      effect: Effect.Effect<
        Option.Option<A>,
        BootstrapEnvelopeReadError | BootstrapEnvelopeDecodeError
      >,
      preserveStream = false,
    ) => {
      if (settled) return;
      settled = true;
      cleanup(!preserveStream);
      if (preserveStream) preservedBootstrapStreams.set(fd, stream);
      resume(effect);
    };

    const handleError = (error: Error) => {
      complete(
        isUnavailableBootstrapFdError(error)
          ? Effect.succeedNone
          : Effect.fail(new BootstrapEnvelopeReadError({ fd, cause: error })),
      );
    };

    const handleLine = (line: string) => {
      const parsed = decodeJsonResult(schema)(line);
      if (Result.isSuccess(parsed)) {
        complete(Effect.succeedSome(parsed.success), options?.preserveFd === true);
      } else {
        complete(
          Effect.fail(
            new BootstrapEnvelopeDecodeError({
              fd,
              cause: parsed.failure,
            }),
          ),
        );
      }
    };

    const handleClose = () => {
      complete(Effect.succeedNone);
    };

    stream.once("error", handleError);
    input.once("line", handleLine);
    input.once("close", handleClose);

    return Effect.sync(() => {
      if (!settled) cleanup(true);
    });
  }).pipe(Effect.timeoutOption(timeoutMs), Effect.map(Option.flatten));
});

const isUnavailableBootstrapFdError = Predicate.compose(
  Predicate.hasProperty("code"),
  (_) => _.code === "EBADF" || _.code === "ENOENT",
);

const isFdReady = (fd: number) =>
  Effect.try({
    try: () => NodeFS.fstatSync(fd),
    catch: (error) =>
      new BootstrapFdStatError({
        fd,
        cause: error,
      }),
  }).pipe(
    Effect.as(true),
    Effect.catchTags({
      BootstrapFdStatError: (error) =>
        isUnavailableBootstrapFdError(error.cause) ? Effect.succeed(false) : Effect.fail(error),
    }),
  );

const makeBootstrapInputStream = (fd: number, preserveFd = false) =>
  Effect.gen(function* () {
    const platform = yield* HostProcessPlatform;
    const fdPath =
      fd === 0 || (preserveFd && !NodeFS.fstatSync(fd).isFile())
        ? undefined
        : resolveFdPath(fd, platform);
    return yield* Effect.try<NodeStream.Readable, BootstrapInputStreamOpenError>({
      try: () => {
        if (fdPath === undefined) {
          return makeDirectBootstrapStream(fd, preserveFd);
        }

        let streamFd: number | undefined;
        try {
          streamFd = NodeFS.openSync(fdPath, "r");
          return NodeFS.createReadStream("", {
            fd: streamFd,
            encoding: "utf8",
            autoClose: true,
          });
        } catch (error) {
          if (isBootstrapFdPathDuplicationError(error)) {
            if (streamFd !== undefined) {
              NodeFS.closeSync(streamFd);
            }
            return makeDirectBootstrapStream(fd, preserveFd);
          }
          throw error;
        }
      },
      catch: (error) =>
        new BootstrapInputStreamOpenError({
          fd,
          platform,
          ...(fdPath === undefined ? {} : { fdPath }),
          cause: error,
        }),
    });
  });

const makeDirectBootstrapStream = (fd: number, preserveFd: boolean): NodeStream.Readable => {
  if (fd === 0) {
    process.stdin.setEncoding("utf8");
    return process.stdin;
  }
  if (NodeFS.fstatSync(fd).isFile()) {
    return NodeFS.createReadStream("", {
      fd,
      encoding: "utf8",
      autoClose: !preserveFd,
    });
  }
  const stream = new NodeNet.Socket({
    fd,
    readable: true,
    writable: false,
  });
  stream.setEncoding("utf8");
  return stream;
};

// Stdin pipes inherited across the wsl.exe boundary report EACCES when we try
// to re-open them via /proc/self/fd/0 — fall back to reading the fd directly
// in that case, the same way we already do for ENXIO/EINVAL/EPERM.
const isBootstrapFdPathDuplicationError = Predicate.compose(
  Predicate.hasProperty("code"),
  (_) => _.code === "ENXIO" || _.code === "EINVAL" || _.code === "EPERM" || _.code === "EACCES",
);

function waitForStreamEnd(stream: NodeStream.Readable, fd: number) {
  return Effect.callback<void, BootstrapEnvelopeReadError>((resume) => {
    const cleanup = () => {
      stream.removeListener("error", handleError);
      stream.removeListener("end", handleEnd);
      stream.removeListener("close", handleEnd);
    };
    const handleError = (cause: Error) => {
      cleanup();
      resume(Effect.fail(new BootstrapEnvelopeReadError({ fd, cause })));
    };
    const handleEnd = () => {
      cleanup();
      resume(Effect.void);
    };

    stream.once("error", handleError);
    stream.once("end", handleEnd);
    stream.once("close", handleEnd);
    if (stream.readableEnded || stream.destroyed) {
      handleEnd();
    } else {
      stream.resume();
    }

    return Effect.sync(() => {
      cleanup();
      stream.destroy();
    });
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Predicate.hasProperty(error, "code") && error.code === "EPERM";
  }
}

export const waitForDesktopParentExit = Effect.fn("waitForDesktopParentExit")(function* (
  fd: number,
  desktopParentPid?: number,
  initialParentPid = process.ppid,
) {
  const preservedStream = preservedBootstrapStreams.get(fd);
  preservedBootstrapStreams.delete(fd);
  const fdClosed = (
    preservedStream === undefined
      ? makeBootstrapInputStream(fd, true)
      : Effect.succeed(preservedStream)
  ).pipe(
    Effect.flatMap((stream) => waitForStreamEnd(stream, fd)),
    Effect.catchCause((cause) =>
      Effect.logError("Desktop parent liveness pipe failed; stopping the server.", {
        fd,
        cause,
      }),
    ),
  );
  const parentExited = Effect.sleep("2 seconds").pipe(
    Effect.andThen(
      Effect.sync(() =>
        desktopParentPid === undefined
          ? initialParentPid <= 1 || process.ppid !== initialParentPid
          : !isProcessAlive(desktopParentPid),
      ),
    ),
    Effect.repeat({ while: (exited) => !exited }),
    Effect.asVoid,
  );

  yield* Effect.raceFirst(fdClosed, parentExited);
});

function resolveFdPath(fd: number, platform: NodeJS.Platform): string | undefined {
  if (platform === "linux") {
    return `/proc/self/fd/${fd}`;
  }
  if (platform === "win32") {
    return undefined;
  }
  return `/dev/fd/${fd}`;
}
