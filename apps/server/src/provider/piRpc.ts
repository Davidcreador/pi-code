/**
 * piRpc — minimal client for `pi --mode rpc` (JSONL over stdio).
 *
 * Commands go to stdin as single-line JSON; responses come back on stdout
 * with `type: "response"` and the echoed `id`; everything else on stdout is
 * an agent event. Framing is strict LF (pi's docs call out that generic line
 * readers splitting on U+2028/U+2029 corrupt records), so splitting happens
 * on `\n` only with an optional trailing `\r` stripped.
 *
 * Protocol reference: https://pi.dev/docs/latest/rpc — see also
 * docs/providers/pi.md for the event mapping consumed by `PiAdapter`.
 *
 * @module provider/piRpc
 */
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export class PiRpcError extends Data.TaggedError("PiRpcError")<{
  readonly operation: string;
  readonly detail: string;
  readonly cause?: unknown;
}> {}

/** One decoded JSONL record from pi's stdout. */
export type PiRpcRecord = Record<string, unknown>;

export interface PiRpcRequestOptions {
  /** `null` disables the timeout for an intentionally long-lived request. */
  readonly timeout?: Duration.Input | null;
}

export interface PiRpcProcess {
  /** Fire-and-forget command (no response correlation). */
  readonly send: (command: PiRpcRecord) => Effect.Effect<void, PiRpcError>;
  /**
   * Send a command with a generated `id` and wait for the matching
   * `type: "response"` record. Fails when the response carries
   * `success: false`, the request times out, or the process exits first.
   */
  readonly request: (
    command: PiRpcRecord,
    options?: PiRpcRequestOptions,
  ) => Effect.Effect<PiRpcRecord, PiRpcError>;
  /** Agent events (every stdout record that is not a correlated response). */
  readonly events: Stream.Stream<PiRpcRecord>;
  /** Resolves with the process exit code; never fails. */
  readonly awaitExit: Effect.Effect<number>;
  readonly terminate: Effect.Effect<void, PiRpcError>;
}

export interface SpawnPiRpcInput {
  readonly binaryPath: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly terminateGrace?: Duration.Input;
}

const DEFAULT_REQUEST_TIMEOUT = Duration.seconds(60);
const DEFAULT_TERMINATE_GRACE = Duration.seconds(5);
const encoder = new TextEncoder();
const decodeJsonLine = Schema.decodeSync(Schema.UnknownFromJsonString);
const encodeJsonLine = Schema.encodeSync(Schema.UnknownFromJsonString);

function parseRecord(line: string): PiRpcRecord | undefined {
  try {
    const value = decodeJsonLine(line);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as PiRpcRecord;
    }
  } catch {
    // pi only writes JSONL on stdout; tolerate stray output rather than
    // killing the session over it.
  }
  return undefined;
}

function responseError(operation: string, response: PiRpcRecord): PiRpcError {
  const detail =
    typeof response.error === "string" && response.error.length > 0
      ? response.error
      : `pi rejected ${operation}`;
  return new PiRpcError({ operation, detail, cause: response });
}

/**
 * Spawn one `pi --mode rpc` process. The process, its stdin pump, and its
 * stdout reader live in the surrounding scope; closing that scope kills the
 * process and shuts the event stream down.
 */
export const spawnPiRpc = Effect.fn("spawnPiRpc")(function* (input: SpawnPiRpcInput) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const processScope = yield* Scope.Scope;

  const handle = yield* spawner
    .spawn(
      ChildProcess.make(input.binaryPath, input.args, {
        cwd: input.cwd,
        killSignal: "SIGTERM",
        forceKillAfter: input.terminateGrace ?? DEFAULT_TERMINATE_GRACE,
        ...(input.environment ? { env: input.environment } : { extendEnv: true }),
      }),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new PiRpcError({
            operation: "spawn",
            detail: `Failed to spawn ${input.binaryPath}: ${cause.message}`,
            cause,
          }),
      ),
    );

  const stdinQueue = yield* Queue.unbounded<Uint8Array>();
  const events = yield* Queue.unbounded<PiRpcRecord>();
  const pending = new Map<string, Deferred.Deferred<PiRpcRecord, PiRpcError>>();
  const exitFinalized = yield* Deferred.make<void>();
  const terminationComplete = yield* Deferred.make<void, PiRpcError>();
  let exitFinalizationStarted = false;
  let terminationStarted = false;
  let transportFailure: PiRpcError | undefined;
  let exited = false;
  let requestSeq = 0;

  const breakTransport = (cause: unknown) =>
    Effect.suspend(() => {
      if (exited || transportFailure !== undefined) return Effect.void;
      const failure = new PiRpcError({
        operation: "stdin",
        detail: "pi stdin transport closed unexpectedly",
        cause,
      });
      transportFailure = failure;
      const waiting = [...pending.values()];
      pending.clear();
      return Effect.forEach(waiting, (deferred) => Deferred.fail(deferred, failure), {
        discard: true,
      }).pipe(Effect.andThen(Queue.shutdown(stdinQueue)));
    });

  yield* Stream.run(Stream.fromQueue(stdinQueue), handle.stdin).pipe(
    Effect.exit,
    Effect.flatMap((exit) => breakTransport(exit)),
    Effect.forkScoped,
  );

  const routeRecord = (record: PiRpcRecord) =>
    Effect.suspend(() => {
      if (record.type === "response" && typeof record.id === "string") {
        const deferred = pending.get(record.id);
        if (deferred === undefined) return Effect.void;
        pending.delete(record.id);
        return record.success === false
          ? Deferred.fail(deferred, responseError(String(record.command ?? "command"), record))
          : Deferred.succeed(deferred, record);
      }
      return Queue.offer(events, record);
    });

  // Strict LF framing: buffer partial lines across chunks, strip an optional
  // trailing `\r`, ignore anything that is not a JSON object line.
  let lineBuffer = "";
  yield* handle.stdout.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) => {
      lineBuffer += chunk;
      const parts = lineBuffer.split("\n");
      lineBuffer = parts.pop() ?? "";
      const records: Array<PiRpcRecord> = [];
      for (const part of parts) {
        const line = part.endsWith("\r") ? part.slice(0, -1) : part;
        if (line.length === 0) {
          continue;
        }
        const record = parseRecord(line);
        if (record !== undefined) {
          records.push(record);
        }
      }
      return Effect.forEach(records, routeRecord, { discard: true });
    }),
    Effect.ignore,
    Effect.forkScoped,
  );

  // Drain stderr so the child never blocks on a full pipe. pi logs human
  // diagnostics there; they are irrelevant to the protocol.
  yield* handle.stderr.pipe(Stream.runDrain, Effect.ignore, Effect.forkScoped);

  const awaitExit = handle.exitCode.pipe(
    Effect.map((code) => Number(code)),
    Effect.orElseSucceed(() => -1),
  );

  const finalizeExit = (code: number) =>
    Effect.suspend(() => {
      if (exitFinalizationStarted) return Deferred.await(exitFinalized);
      exitFinalizationStarted = true;
      exited = true;
      const failure = new PiRpcError({
        operation: "request",
        detail: `pi exited with code ${code} before responding`,
      });
      const waiting = [...pending.values()];
      pending.clear();
      return Effect.forEach(waiting, (deferred) => Deferred.fail(deferred, failure), {
        discard: true,
      }).pipe(
        Effect.andThen(Queue.shutdown(events)),
        Effect.andThen(Queue.shutdown(stdinQueue)),
        Effect.andThen(Deferred.succeed(exitFinalized, undefined)),
        Effect.asVoid,
        Effect.uninterruptible,
      );
    });

  yield* awaitExit.pipe(Effect.flatMap(finalizeExit), Effect.forkScoped);

  const terminateProcess = Effect.gen(function* () {
    const running = yield* handle.isRunning;
    if (!running) {
      yield* awaitExit.pipe(Effect.flatMap(finalizeExit));
      return;
    }

    yield* handle.kill({
      killSignal: "SIGTERM",
      forceKillAfter: input.terminateGrace ?? DEFAULT_TERMINATE_GRACE,
    });
    yield* awaitExit.pipe(Effect.flatMap(finalizeExit));
  }).pipe(
    Effect.mapError(
      (cause) =>
        new PiRpcError({
          operation: "terminate",
          detail: "Failed to terminate pi RPC process.",
          cause,
        }),
    ),
  );

  const terminate = Effect.uninterruptibleMask((restore) =>
    Effect.suspend(() => {
      const awaitTermination = restore(Deferred.await(terminationComplete));
      if (terminationStarted) return awaitTermination;
      terminationStarted = true;
      return terminateProcess.pipe(
        Effect.exit,
        Effect.flatMap((exit) => Deferred.done(terminationComplete, exit)),
        Effect.forkIn(processScope),
        Effect.andThen(awaitTermination),
      );
    }),
  );

  const send = (command: PiRpcRecord) =>
    Effect.suspend(() => {
      if (transportFailure !== undefined) {
        return Effect.fail(
          new PiRpcError({
            operation: String(command.type ?? "send"),
            detail: transportFailure.detail,
            cause: transportFailure,
          }),
        );
      }
      if (exited) {
        return Effect.fail(
          new PiRpcError({
            operation: String(command.type ?? "send"),
            detail: "pi process already exited",
          }),
        );
      }
      return Queue.offer(stdinQueue, encoder.encode(`${encodeJsonLine(command)}\n`)).pipe(
        Effect.mapError(
          () =>
            new PiRpcError({
              operation: String(command.type ?? "send"),
              detail: "pi stdin closed",
            }),
        ),
        Effect.asVoid,
      );
    });

  const request = (command: PiRpcRecord, options?: PiRpcRequestOptions) =>
    Effect.gen(function* () {
      const id = `t3-${++requestSeq}`;
      const operation = String(command.type ?? "request");
      const deferred = yield* Deferred.make<PiRpcRecord, PiRpcError>();
      pending.set(id, deferred);
      return yield* Effect.gen(function* () {
        yield* send({ ...command, id });
        const response = Deferred.await(deferred);
        return yield* options?.timeout === null
          ? response
          : response.pipe(
              Effect.timeoutOrElse({
                duration: options?.timeout ?? DEFAULT_REQUEST_TIMEOUT,
                orElse: () =>
                  Effect.fail(
                    new PiRpcError({
                      operation,
                      detail: `pi RPC request '${operation}' timed out`,
                    }),
                  ),
              }),
            );
      }).pipe(Effect.ensuring(Effect.sync(() => pending.delete(id))));
    });

  return {
    send,
    request,
    events: Stream.fromQueue(events),
    awaitExit,
    terminate,
  } satisfies PiRpcProcess;
});
