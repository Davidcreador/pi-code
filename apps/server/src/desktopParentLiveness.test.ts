// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off globalTimers:off - Process-level integration test exercises real child lifetime and HTTP readiness.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { once } from "node:events";

import { expect, it } from "vite-plus/test";

async function reservePort(): Promise<number> {
  const server = NodeNet.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Expected a TCP test port.");
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

const DESKTOP_SERVER_ARGS = [
  NodePath.join(import.meta.dirname, "bin.ts"),
  "--bootstrap-fd",
  "0",
  "--desktop-parent-liveness",
] as const;

function spawnDesktopServer(baseDir: string) {
  return NodeChildProcess.spawn(process.execPath, DESKTOP_SERVER_ARGS, {
    cwd: NodePath.resolve(import.meta.dirname, "../../.."),
    env: {
      ...process.env,
      D4_HOME: baseDir,
      T3CODE_LOG_LEVEL: "Error",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function waitForReady(
  port: number,
  child: NodeChildProcess.ChildProcess,
  getStderr: () => string,
): Promise<void> {
  for (let attempt = 0; attempt < 20_000; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited before readiness with code ${child.exitCode}: ${getStderr()}`);
    }
    const response = await fetch(`http://127.0.0.1:${port}/.well-known/t3/environment`, {
      signal: AbortSignal.timeout(200),
    }).catch(() => null);
    if (response?.ok) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for the desktop server.");
}

it("exits when its desktop parent liveness stdin closes", async () => {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "picode-parent-liveness-"));
  const port = await reservePort();
  const child = spawnDesktopServer(baseDir);
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  try {
    child.stdin?.write(
      `${JSON.stringify({
        mode: "desktop",
        noBrowser: true,
        port,
        t3Home: baseDir,
        host: "127.0.0.1",
        desktopBootstrapToken: "parent-liveness-test-token",
        desktopParentPid: process.pid,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      })}\n`,
    );
    await waitForReady(port, child, () => stderr);
    expect(child.exitCode).toBeNull();

    const exit = new Promise<readonly [number | null, NodeJS.Signals | null]>((resolve) => {
      child.once("exit", (code, signal) => resolve([code, signal]));
    });
    child.stdin?.end();
    const [exitCode] = await exit;

    expect(exitCode, stderr).toBe(0);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    NodeFS.rmSync(baseDir, { recursive: true, force: true });
  }
}, 30_000);

it("observes EOF delivered with the bootstrap envelope", async () => {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "picode-parent-liveness-"));
  const port = await reservePort();
  const child = spawnDesktopServer(baseDir);

  try {
    const exit = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
    child.stdin?.end(
      `${JSON.stringify({
        mode: "desktop",
        noBrowser: true,
        port,
        t3Home: baseDir,
        host: "127.0.0.1",
        desktopBootstrapToken: "parent-liveness-test-token",
        desktopParentPid: process.pid,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      })}\n`,
    );
    const [exitCode] = await exit;

    expect(exitCode).toBe(0);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    NodeFS.rmSync(baseDir, { recursive: true, force: true });
  }
}, 10_000);

it("fails closed when the liveness pipe closes before bootstrap", async () => {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "picode-parent-liveness-"));
  const child = spawnDesktopServer(baseDir);
  try {
    const exit = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
    child.stdin?.end();
    const [exitCode] = await exit;

    expect(exitCode).not.toBe(0);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    NodeFS.rmSync(baseDir, { recursive: true, force: true });
  }
}, 10_000);
