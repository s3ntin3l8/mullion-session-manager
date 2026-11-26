import { afterEach, describe, expect, it } from "vitest";
import { fork, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMcodeHooksJson } from "../../src/services/hook-adapters/mcode.js";

const hooksDir = fileURLToPath(new URL("../../src/hooks/", import.meta.url));
const children: ChildProcess[] = [];
const sockets = new Set<net.Socket>();
let server: net.Server | undefined;
let dir: string;

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, "exit");
    }
  }
  // Detached workers watch the agent and release their sockets within 250ms.
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function listener(onLines: (socket: net.Socket, lines: Record<string, unknown>[]) => void) {
  dir = mkdtempSync(path.join(os.tmpdir(), "stop-bg-"));
  const target = path.join(dir, "hooks.sock");
  server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let buffer = "";
    const lines: Record<string, unknown>[] = [];
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        lines.push(JSON.parse(buffer.slice(0, newline)));
        buffer = buffer.slice(newline + 1);
      }
      if (lines.length >= 2) onLines(socket, lines);
    });
  });
  await new Promise<void>((resolve) => server!.listen(target, resolve));
  return target;
}

function mcodeAgent(target: string, delays: string) {
  writeFileSync(
    path.join(dir, "mullion-hook.json"),
    JSON.stringify(
      {
        socket: target,
        token: "test-token",
        forwarderPath: path.join(hooksDir, "forwarder.mjs"),
        nodePath: process.execPath,
      },
      null,
      2,
    ),
  );
  const command = JSON.parse(buildMcodeHooksJson(path.join(hooksDir, "mcode-hook-shim.sh"))).hooks
    .Stop[0].hooks[0].command;
  // A stand-in for mcode's hook runner: its real command, whitelist-style
  // TMPDIR handoff, 10s ceiling, and a CLI that stays alive after the hook.
  const agent = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { spawn } from 'node:child_process';
       const hook = spawn('sh', ['-c', process.argv[1]], { detached: true, stdio: ['pipe', 'pipe', 'inherit'] });
       const killHookGroup = signal => { try { process.kill(-hook.pid, signal); } catch {} };
       const timeout = setTimeout(() => killHookGroup('SIGKILL'), 10000);
       let output = '';
       hook.stdout.on('data', chunk => output += chunk);
       hook.on('close', code => { clearTimeout(timeout); killHookGroup('SIGKILL'); process.send({ code, output }); });
       hook.stdin.end('{}');
       process.on('message', () => process.exit(0));`,
      command,
    ],
    {
      env: {
        ...process.env,
        // The real mcode whitelist drops these; the shim must restore them
        // from the fixture handoff, never use this hosted session's channel.
        MULLION_HOOK_SOCKET: "",
        MULLION_HOOK_TOKEN: "",
        MULLION_FORWARDER_PATH: "",
        TMPDIR: dir,
        MULLION_FORWARDER_STOP_RETRY_DELAYS_MS: delays,
      },
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    },
  );
  children.push(agent);
  return agent;
}

describe("mcode Stop background delivery (#3189)", () => {
  it("hands a complete delivery over IPC and honours an explicitly supplied identity", async () => {
    const { startBackgroundStop, runBackgroundStop } =
      await import("../../src/hooks/forwarder-background.mjs");
    const ids: unknown[] = [];
    const target = await listener((socket, lines) => {
      ids.push(lines[0].deliveryId);
      expect(lines[0].token).toBe("test-token");
      expect(lines[1]).toEqual({ kind: "progress", phase: "done" });
      socket.end('{"ack":"accepted"}\n{"ack":"delivered"}\n');
    });
    expect(
      await startBackgroundStop(target, "test-token", [{ kind: "progress", phase: "done" }]),
    ).toBe(true);
    await expect.poll(() => ids.length).toBe(1);
    await runBackgroundStop({
      socketPath: target,
      token: "test-token",
      messages: [{ kind: "progress", phase: "done" }],
      ownerPid: process.pid,
      deliveryId: "handed-off-id",
    });
    expect(ids[1]).toBe("handed-off-id");
  });

  it("exits the hook promptly and delivers after refusals lasting beyond mcode's 10s ceiling", async () => {
    const ids: unknown[] = [];
    const dispatched: unknown[] = [];
    const target = await listener((socket, lines) => {
      ids.push(lines[0].deliveryId);
      if (ids.length <= 3) socket.end('{"ack":"refused"}\n');
      else {
        dispatched.push(lines[1]);
        socket.end('{"ack":"accepted"}\n{"ack":"delivered"}\n');
      }
    });
    const started = Date.now();
    const agent = mcodeAgent(target, "20,20,10500");
    const [reply] = await once(agent, "message");
    expect(reply).toEqual({ code: 0, output: "{}\n" });
    expect(Date.now() - started).toBeLessThan(10000);
    await expect.poll(() => dispatched.length, { timeout: 20000 }).toBe(1);
    expect(Date.now() - started).toBeGreaterThan(10000);
    expect(dispatched).toEqual([{ kind: "progress", phase: "done" }]);
    expect(ids).toHaveLength(4);
    expect(typeof ids[0]).toBe("string");
    expect(new Set(ids).size).toBe(1);
  }, 30000);

  it("reuses the handed-off id when an acknowledgement is lost, so the ledger dispatches once", async () => {
    const { HookDeliveryRegistry } = await import("../../src/services/hook-deliveries.js");
    const ledger = new HookDeliveryRegistry();
    const ids: string[] = [];
    let dispatched = 0;
    const target = await listener((socket, lines) => {
      const id = lines[0].deliveryId as string;
      ids.push(id);
      // An accepted delivery is dispatched, but the first delivered ack is
      // lost. The worker must retry with exactly the same identity.
      socket.write('{"ack":"accepted"}\n');
      if (ledger.claim("session", `${id}:0`)) {
        dispatched++;
      }
      socket.end(ids.length === 1 ? "" : '{"ack":"delivered"}\n');
    });
    const agent = mcodeAgent(target, "20,20");
    await once(agent, "message");
    await expect.poll(() => ids.length).toBe(2);
    expect(dispatched).toBe(1);
    expect(ids[0]).toBe(ids[1]);
  });

  it("exits at the retry bound even while the agent remains alive", async () => {
    let attempts = 0;
    const target = await listener((socket) => {
      attempts++;
      socket.end('{"ack":"refused"}\n');
    });
    const worker = fork(path.join(hooksDir, "forwarder-background.mjs"), ["--stop-worker"], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      execArgv: [],
      env: { ...process.env, MULLION_FORWARDER_STOP_RETRY_DELAYS_MS: "20,20" },
    });
    children.push(worker);
    const exited = once(worker, "exit");
    worker.send({
      socketPath: target,
      token: "test-token",
      messages: [{ kind: "progress", phase: "done" }],
      ownerPid: process.pid,
      deliveryId: "bounded-id",
    });
    worker.disconnect();
    await exited;
    expect(worker.exitCode).toBe(0);
    expect(attempts).toBe(3);
  });

  it.each(["backoff", "socket attempt"])(
    "reaps the worker on agent exit during %s",
    async (phase) => {
      let attempts = 0;
      const target = await listener((socket) => {
        attempts++;
        if (phase === "backoff") socket.end('{"ack":"refused"}\n');
        // Otherwise keep the socket open without an acknowledgement.
      });
      const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
      });
      children.push(owner);
      const worker = fork(path.join(hooksDir, "forwarder-background.mjs"), ["--stop-worker"], {
        detached: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        execArgv: [],
        env: { ...process.env, MULLION_FORWARDER_STOP_RETRY_DELAYS_MS: "10000" },
      });
      children.push(worker);
      worker.send({
        socketPath: target,
        token: "test-token",
        messages: [{ kind: "progress", phase: "done" }],
        ownerPid: owner.pid,
        deliveryId: "stable-id",
      });
      worker.disconnect();
      await expect.poll(() => attempts).toBe(1);
      const exited = once(worker, "exit");
      owner.kill();
      await once(owner, "exit");
      await exited;
      expect(worker.exitCode).toBe(0);
      expect(attempts).toBe(1);
    },
  );
});
