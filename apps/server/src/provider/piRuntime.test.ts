// @effect-diagnostics nodeBuiltinImport:off
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";

import { describe, expect, it } from "vite-plus/test";

import type { PiSettings } from "@t3tools/contracts";

import { PI_RPC_CAPABILITIES, piRpcCapabilityIssue, resolvePiRuntimeCommand } from "./piRuntime.ts";

const settings = (binaryPath: string): PiSettings => ({ enabled: true, binaryPath });

describe("piRuntime", () => {
  it("uses the bundled RPC entry for the default binary setting", () => {
    const runtime = resolvePiRuntimeCommand({
      piSettings: settings("pi"),
      entry: "rpc",
      environment: { HOME: "/tmp/home" },
      executablePath: "/app/d4",
      isElectron: false,
    });

    expect(runtime.binaryPath).toBe("/app/d4");
    expect(runtime.argsPrefix).toHaveLength(1);
    expect(runtime.argsPrefix[0]).toMatch(/pi-coding-agent[/\\]dist[/\\]rpc-entry\.js$/);
    expect(runtime.environment).toEqual({ HOME: "/tmp/home" });
  });

  it("resolves the bundled CLI entry", () => {
    const runtime = resolvePiRuntimeCommand({
      piSettings: settings("pi"),
      entry: "cli",
      executablePath: "/usr/bin/node",
      isElectron: false,
    });

    expect(runtime.binaryPath).toBe("/usr/bin/node");
    expect(runtime.argsPrefix[0]).toMatch(/pi-coding-agent[/\\]dist[/\\]cli\.js$/);
  });

  it("runs the bundled entry through Electron's Node mode", () => {
    const runtime = resolvePiRuntimeCommand({
      piSettings: settings(""),
      entry: "rpc",
      environment: { HOME: "/tmp/home" },
      executablePath: "/app/d4",
      isElectron: true,
    });

    expect(runtime.environment).toEqual({ HOME: "/tmp/home", ELECTRON_RUN_AS_NODE: "1" });
  });

  it("preserves an explicit external binary override", () => {
    const environment = { PATH: "/custom/bin" };
    const runtime = resolvePiRuntimeCommand({
      piSettings: settings(" /custom/pi "),
      entry: "rpc",
      environment,
    });

    expect(runtime).toEqual({
      binaryPath: "/custom/pi",
      argsPrefix: ["--mode", "rpc"],
      environment,
    });
  });

  it("assigns a fresh session id to every imported JSONL", async () => {
    const agentDir = mkdtempSync(path.join(tmpdir(), "d4-pi-import-test-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "d4-pi-import-cwd-"));
    const child = spawn(
      path.resolve(import.meta.dirname, "../../node_modules/.bin/pi"),
      ["--mode", "rpc", "--session-id", "import-test"],
      { cwd, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, stdio: "pipe" },
    );
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const request = async (id: string, filename: string, content: string) => {
      child.stdin.write(`${JSON.stringify({ id, type: "import_session", filename, content })}\n`);
      while (true) {
        const line = await lines.next();
        if (line.done) throw new Error("Pi RPC exited before import completed");
        const response = JSON.parse(line.value) as {
          id?: string;
          success?: boolean;
          error?: string;
          data?: { sessionId?: string };
        };
        if (response.id !== id) continue;
        if (!response.success || response.data?.sessionId === undefined) {
          throw new Error(response.error ?? "Pi RPC import failed");
        }
        return response.data.sessionId;
      }
    };

    try {
      const sourceId = "019f0622-9c14-798a-ac93-8df93b753755";
      const content = [
        {
          type: "session",
          version: 3,
          id: sourceId,
          timestamp: "2026-01-01T00:00:00.000Z",
          cwd,
        },
        {
          type: "model_change",
          id: "e63ee113",
          parentId: null,
          timestamp: "2026-01-01T00:00:01.000Z",
          provider: "openai",
          modelId: "gpt-5",
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n");
      const first = await request("first", "first.jsonl", `${content}\n`);
      const second = await request("second", "second.jsonl", `${content}\n`);

      expect(first).not.toBe(sourceId);
      expect(second).not.toBe(sourceId);
      expect(second).not.toBe(first);
    } finally {
      if (child.exitCode === null) {
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        child.kill();
        await exited;
      }
      rmSync(agentDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30_000);

  it("validates the native-control protocol", () => {
    expect(
      piRpcCapabilityIssue({
        data: { protocolVersion: 1, capabilities: [...PI_RPC_CAPABILITIES] },
      }),
    ).toBeUndefined();
    expect(
      piRpcCapabilityIssue({ data: { protocolVersion: 1, capabilities: ["navigate_tree"] } }),
    ).toBe(
      "missing capabilities: abort_branch_summary, reload, set_entry_label, safe_settings, scoped_models, session_management, project_trust, changelog, auth",
    );
    expect(piRpcCapabilityIssue({ data: { protocolVersion: 2, capabilities: [] } })).toBe(
      "expected protocol version 1",
    );
  });
});
