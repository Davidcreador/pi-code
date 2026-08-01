import { describe, expect, it } from "vite-plus/test";

import { retryTransientBootstrap } from "./auth";

describe("retryTransientBootstrap", () => {
  it("does not retry unrelated TypeErrors", async () => {
    let attempts = 0;

    await expect(
      retryTransientBootstrap(async () => {
        attempts += 1;
        throw new TypeError("Cannot read properties of undefined");
      }),
    ).rejects.toThrow("Cannot read properties of undefined");
    expect(attempts).toBe(1);
  });

  it("retries fetch TypeErrors", async () => {
    let attempts = 0;

    await expect(
      retryTransientBootstrap(async () => {
        attempts += 1;
        if (attempts === 1) throw new TypeError("Failed to fetch");
        return "ready";
      }),
    ).resolves.toBe("ready");
    expect(attempts).toBe(2);
  });
});
