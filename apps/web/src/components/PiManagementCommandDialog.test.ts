import type { PiNativeAuthFlow } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  isPiAuthDialogDismissBlocked,
  nextPiAuthPollFailureCount,
  piAuthPollDelayMs,
  pollPiAuthFlow,
} from "./PiManagementCommandDialog";

const runningFlow: PiNativeAuthFlow = {
  flowId: "flow-1",
  providerId: "provider-1",
  authType: "oauth",
  status: "running",
};

const succeededFlow: PiNativeAuthFlow = {
  ...runningFlow,
  status: "succeeded",
};

describe("Pi authentication polling", () => {
  it("makes a running flow dismissible and retryable after a typed poll failure", async () => {
    const failedPoll = await pollPiAuthFlow(() =>
      Promise.resolve(
        AsyncResult.failure<PiNativeAuthFlow, Error>(Cause.fail(new Error("connection lost"))),
      ),
    );

    expect(failedPoll).toEqual({ status: "failure", message: "connection lost" });
    const failureCount = nextPiAuthPollFailureCount(0, failedPoll);
    expect(isPiAuthDialogDismissBlocked(runningFlow, failureCount)).toBe(false);
    expect(piAuthPollDelayMs(failureCount)).toBe(1_000);
  });

  it("makes a running flow dismissible and retryable after a thrown poll failure", async () => {
    const failedPoll = await pollPiAuthFlow(() => Promise.reject(new Error("request failed")));

    expect(failedPoll).toEqual({ status: "failure", message: "request failed" });
    const failureCount = nextPiAuthPollFailureCount(0, failedPoll);
    expect(isPiAuthDialogDismissBlocked(runningFlow, failureCount)).toBe(false);
    expect(piAuthPollDelayMs(20)).toBe(10_000);
  });

  it("reconciles a later successful poll after a transient failure", async () => {
    const failedPoll = await pollPiAuthFlow(() => Promise.reject(new Error("request failed")));
    const failedCount = nextPiAuthPollFailureCount(0, failedPoll);
    const recoveredPoll = await pollPiAuthFlow(() =>
      Promise.resolve(AsyncResult.success(succeededFlow)),
    );
    const recoveredCount = nextPiAuthPollFailureCount(failedCount, recoveredPoll);

    expect(recoveredPoll).toEqual({ status: "success", flow: succeededFlow });
    expect(recoveredCount).toBe(0);
    expect(isPiAuthDialogDismissBlocked(succeededFlow, recoveredCount)).toBe(false);
  });
});
