import { PiSettings } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { checkPiProviderStatus } from "./PiProvider.ts";

const fakePiPath = `${import.meta.dirname}/fixtures/fake-pi`;
const settings = Schema.decodeSync(PiSettings)({ binaryPath: fakePiPath });

it.effect("probes an explicit Pi runtime through CLI and RPC entrypoints", () =>
  Effect.gen(function* () {
    const provider = yield* checkPiProviderStatus(settings, process.cwd(), process.env);

    assert.equal(provider.installed, true);
    assert.equal(provider.version, "0.83.0-fake");
  }).pipe(Effect.provide(NodeServices.layer)),
);
