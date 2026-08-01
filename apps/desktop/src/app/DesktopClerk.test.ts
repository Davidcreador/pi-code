import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { beforeEach, vi } from "vite-plus/test";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";

const { createClerkBridgeMock, storageAdapter, storageMock } = vi.hoisted(() => ({
  createClerkBridgeMock: vi.fn(),
  storageAdapter: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
  storageMock: vi.fn(),
}));

vi.mock("@clerk/electron", () => ({
  createClerkBridge: createClerkBridgeMock,
}));

vi.mock("@clerk/electron/storage", () => ({
  storage: storageMock,
}));

import * as DesktopClerk from "./DesktopClerk.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const makeDesktopClerkLayer = (isDevelopment = true) => {
  const environment = DesktopEnvironment.DesktopEnvironment.of({
    stateDir: "/tmp/t3-state",
    isDevelopment,
    userDataDirName: isDevelopment ? "d4-dev" : "d4",
  } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);

  return DesktopClerk.layer.pipe(
    Layer.provide(Layer.succeed(DesktopEnvironment.DesktopEnvironment, environment)),
  );
};

describe("DesktopClerk", () => {
  beforeEach(() => {
    createClerkBridgeMock.mockReset();
    storageMock.mockReset();
  });

  it("derives the Clerk Frontend API hostname used by the desktop CSP", () => {
    const publishableKey = `pk_test_${btoa("clerk.t3.codes$")}`;

    assert.equal(
      DesktopClerk.resolveDesktopClerkFrontendApiHostname(publishableKey),
      "clerk.t3.codes",
    );
    assert.equal(DesktopClerk.resolveDesktopClerkFrontendApiHostname(""), undefined);
    assert.equal(DesktopClerk.resolveDesktopClerkFrontendApiHostname("invalid"), undefined);
  });

  it.effect("acquires and releases the SDK bridge with the layer", () => {
    const cleanup = vi.fn();
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup });

    return Effect.gen(function* () {
      yield* Effect.scoped(Layer.build(makeDesktopClerkLayer()));

      assert.deepEqual(createClerkBridgeMock.mock.calls, [
        [
          {
            storage: storageAdapter,
            passkeys: true,
            renderer: { scheme: "d4-dev", host: "app" },
          },
        ],
      ]);
      assert.equal(cleanup.mock.calls.length, 1);
      storageMock.mockClear();
      createClerkBridgeMock.mockClear();
    });
  });

  it.effect("preserves bridge initialization failures", () => {
    const cause = new Error("bridge initialization failed");
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockImplementationOnce(() => {
      throw cause;
    });

    return Effect.gen(function* () {
      const error = yield* Effect.scoped(Layer.build(makeDesktopClerkLayer())).pipe(Effect.flip);

      assert.instanceOf(error, DesktopClerk.DesktopClerkBridgeInitializationError);
      assert.equal(error.stateDir, "/tmp/t3-state");
      assert.equal(error.isDevelopment, true);
      assert.strictEqual(error.cause, cause);
      assert.equal(
        error.message,
        'Failed to initialize the desktop Clerk bridge for state directory "/tmp/t3-state" (development: true).',
      );
    });
  });

  it.effect("preserves bridge cleanup failures", () => {
    const cause = new Error("bridge cleanup failed");
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({
      cleanup: () => {
        throw cause;
      },
    });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(Effect.scoped(Layer.build(makeDesktopClerkLayer(false))));

      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, DesktopClerk.DesktopClerkBridgeCleanupError);
        assert.equal(error.stateDir, "/tmp/t3-state");
        assert.equal(error.isDevelopment, false);
        assert.strictEqual(error.cause, cause);
        assert.equal(
          error.message,
          'Failed to clean up the desktop Clerk bridge for state directory "/tmp/t3-state" (development: false).',
        );
      }
    });
  });

  it.effect(
    "shows an error before quitting and interrupts when the instance lock is denied",
    () => {
      const calls: Array<string> = [];
      const showErrorBox = vi.fn((title: string, content: string) =>
        Effect.sync(() => {
          calls.push("dialog");
          assert.equal(title, "piCode is already running");
          assert.equal(
            content,
            "piCode is already running — or an older d4 build is. Quit the other app and try again.",
          );
        }),
      );
      const on = vi.fn(() => Effect.die("unexpected second-instance listener registration"));
      const electronApp = ElectronApp.ElectronApp.of({
        requestSingleInstanceLock: Effect.succeed(false),
        quit: Effect.sync(() => {
          calls.push("quit");
        }),
        on,
      } as unknown as ElectronApp.ElectronApp["Service"]);
      const electronDialog = ElectronDialog.ElectronDialog.of({
        showErrorBox,
      } as unknown as ElectronDialog.ElectronDialog["Service"]);
      const electronWindow = ElectronWindow.ElectronWindow.of(
        {} as ElectronWindow.ElectronWindow["Service"],
      );
      storageMock.mockReturnValue(storageAdapter);
      createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn() });

      return Effect.gen(function* () {
        const clerk = yield* DesktopClerk.DesktopClerk;
        const exit = yield* Effect.exit(clerk.configure);

        assert.equal(exit._tag, "Failure");
        if (exit._tag === "Failure") {
          assert.isTrue(Cause.hasInterruptsOnly(exit.cause));
        }
        assert.deepEqual(calls, ["dialog", "quit"]);
        assert.equal(showErrorBox.mock.calls.length, 1);
        assert.equal(on.mock.calls.length, 0);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            makeDesktopClerkLayer(),
            Layer.succeed(ElectronApp.ElectronApp, electronApp),
            Layer.succeed(ElectronDialog.ElectronDialog, electronDialog),
            Layer.succeed(ElectronWindow.ElectronWindow, electronWindow),
          ),
        ),
        Effect.scoped,
      );
    },
  );

  it.each([
    { isDevelopment: true, scheme: "d4-dev" },
    { isDevelopment: false, scheme: "d4" },
  ])("configures the SDK with the $scheme renderer origin", ({ isDevelopment, scheme }) => {
    const bridge = { cleanup: vi.fn() };
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue(bridge);

    assert.equal(DesktopClerk.createDesktopClerkBridge("/tmp/t3-state", isDevelopment), bridge);
    assert.deepEqual(storageMock.mock.calls, [[{ path: "/tmp/t3-state" }]]);
    assert.deepEqual(createClerkBridgeMock.mock.calls, [
      [
        {
          storage: storageAdapter,
          passkeys: true,
          renderer: { scheme, host: "app" },
        },
      ],
    ]);
    storageMock.mockClear();
    createClerkBridgeMock.mockClear();
  });
});
