import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

it.effect("broadcasts every runtime event to both PubSub consumers", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const events = Array.from({ length: 1_000 }, (_, index) => index);
      const pubsub = yield* PubSub.unbounded<number>();
      const first = yield* Stream.fromPubSub(pubsub).pipe(
        Stream.take(events.length),
        Stream.runCollect,
        Effect.forkScoped({ startImmediately: true }),
      );
      const second = yield* Stream.fromPubSub(pubsub).pipe(
        Stream.take(events.length),
        Stream.runCollect,
        Effect.forkScoped({ startImmediately: true }),
      );

      yield* Effect.forEach(events, (event) => PubSub.publish(pubsub, event), { discard: true });

      expect(yield* Fiber.join(first)).toEqual(events);
      expect(yield* Fiber.join(second)).toEqual(events);
    }),
  ),
);

it.effect("attaches a replacement event pump before reconciliation continues", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<number>();
      const received = yield* Deferred.make<number>();
      yield* Stream.fromPubSub(pubsub).pipe(
        Stream.runForEach((event) => Deferred.succeed(received, event)),
        Effect.forkScoped({ startImmediately: true }),
      );

      yield* PubSub.publish(pubsub, 42);

      expect(yield* Deferred.await(received)).toBe(42);
    }),
  ),
);
