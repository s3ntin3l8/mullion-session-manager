import { describe, it, expect } from "vitest";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildTestApp } from "../helpers/app.js";
import { decodePairingPayload } from "../../src/services/bridge-registry.js";
import { runHelper } from "../../src/cli/ssh-agent-helper.mjs";

// Issue #820 (PR6) — end-to-end: the real primary route
// (routes/agent-bridge.ts) issuing a pairing code, `mullion helper pair`
// (this file's own runHelper, imported directly rather than spawned, for
// coverage — same posture as test/cli/core.test.ts exercising core.mjs
// directly) redeeming it over a real listening WebSocket, persisting a
// credential, then `mullion helper run` re-authenticating with it and
// forwarding real bytes from a server-opened channel through to a fake
// local "ssh-agent" unix socket standing in for SSH_AUTH_SOCK.

function waitUntil(check: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitUntil: timed out"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

function fakeIo(env: Record<string, string>) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let interruptCb: (() => void) | undefined;
  return {
    stdout: { write: (s: string) => void stdout.push(s) },
    stderr: { write: (s: string) => void stderr.push(s) },
    env,
    onInterrupt: (cb: () => void) => {
      interruptCb = cb;
    },
    triggerInterrupt: () => interruptCb?.(),
    stdoutLines: stdout,
    stderrLines: stderr,
  };
}

async function buildAndListen() {
  const app = await buildTestApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a real bound address");
  }
  return { app, port: address.port };
}

describe("mullion helper (pair + run) against the real primary", () => {
  it("pairs, persists a 0600 credential, then run() forwards real bytes through to a local fake agent socket", async () => {
    const { app, port } = await buildAndListen();
    const baseUrl = `http://127.0.0.1:${port}`;

    const pairRes = await fetch(`${baseUrl}/api/bridges`, { method: "POST" });
    const { pairing_payload } = (await pairRes.json()) as { pairing_payload: string };

    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-helper-state-"));
    const io = fakeIo({ MULLION_HELPER_STATE_DIR: stateDir });

    const pairCode = await runHelper("pair", [pairing_payload, "--name", "test-laptop"], io);
    expect(pairCode).toBe(0);

    const credentialFile = path.join(stateDir, "ssh-agent-bridge.json");
    const stat = fs.statSync(credentialFile);
    expect(stat.mode & 0o777).toBe(0o600);
    const credential = JSON.parse(fs.readFileSync(credentialFile, "utf8"));
    expect(credential.baseUrl).toBe(baseUrl);
    expect(typeof credential.bridgeId).toBe("string");
    expect(typeof credential.sessionId).toBe("string");

    // A fake local "ssh-agent" — a real unix socket, echoing back whatever
    // it receives with a fixed prefix so a round trip is unambiguous.
    const agentSocketPath = path.join(stateDir, "fake-agent.sock");
    const fakeAgent = net.createServer((socket) => {
      socket.on("data", (chunk) =>
        socket.write(Buffer.concat([Buffer.from("agent-reply:"), chunk])),
      );
    });
    await new Promise<void>((resolve) => fakeAgent.listen(agentSocketPath, resolve));

    // Pairing's own WS connection is still tracked under this bridgeId at
    // this point (runPair's `ws.close()` hasn't propagated to the server's
    // "close" handler yet) — wait for it to fully drop before starting
    // `run`'s own connection, or the race between the two produces a
    // connectedBridges entry that flickers present/absent/present-again,
    // and `openChannel()` below can land on the pair connection just as it
    // tears down instead of the run connection.
    await waitUntil(() => !app.connectedBridges.has(credential.bridgeId));

    const runIo = fakeIo({ SSH_AUTH_SOCK: agentSocketPath, MULLION_HELPER_STATE_DIR: stateDir });
    const runPromise = runHelper("run", [], runIo);

    await waitUntil(() => app.connectedBridges.has(credential.bridgeId));
    const bridge = app.connectedBridges.get(credential.bridgeId)!;

    const serverChannel = await bridge.mux.openChannel();
    const received: Buffer[] = [];
    serverChannel.onData((chunk) => received.push(chunk));
    serverChannel.send(Buffer.from("ssh-add -l"));
    await waitUntil(() => received.length > 0);
    expect(Buffer.concat(received).toString()).toBe("agent-reply:ssh-add -l");

    // Clean shutdown: mark the helper's own loop as stopped, then close
    // from the server side so its blocked `await mux.onClose` resolves and
    // the loop observes `stopped` on its next iteration instead of
    // reconnecting.
    runIo.triggerInterrupt();
    bridge.mux.close();
    const runCode = await runPromise;
    expect(runCode).toBe(0);

    fakeAgent.close();
    await app.close();
  });

  it("run() fails loudly (not into the retry loop) on an invalid/expired session credential", async () => {
    const { app, port } = await buildAndListen();
    const baseUrl = `http://127.0.0.1:${port}`;

    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-helper-state-"));
    fs.writeFileSync(
      path.join(stateDir, "ssh-agent-bridge.json"),
      JSON.stringify({ baseUrl, bridgeId: "nonexistent", sessionId: "nonexistent" }),
      { mode: 0o600 },
    );

    const agentSocketPath = path.join(stateDir, "fake-agent.sock");
    const io = fakeIo({ SSH_AUTH_SOCK: agentSocketPath, MULLION_HELPER_STATE_DIR: stateDir });
    const code = await runHelper("run", [], io);
    expect(code).toBe(1);
    expect(io.stderrLines.join("")).toContain("re-pair");

    await app.close();
  });

  it("pair() rejects a malformed payload without attempting to connect anywhere", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-helper-state-"));
    const io = fakeIo({ MULLION_HELPER_STATE_DIR: stateDir });
    const code = await runHelper("pair", ["not-a-real-payload"], io);
    expect(code).toBe(2);
    expect(fs.existsSync(path.join(stateDir, "ssh-agent-bridge.json"))).toBe(false);
  });
});

describe("mullion helper run() — missing prerequisites", () => {
  it("fails with a clear message when SSH_AUTH_SOCK is unset and no --ssh-auth-sock given", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-helper-state-"));
    const io = fakeIo({ MULLION_HELPER_STATE_DIR: stateDir });
    const code = await runHelper("run", [], io);
    expect(code).toBe(1);
    expect(io.stderrLines.join("")).toContain("SSH_AUTH_SOCK");
  });

  it("fails with a clear message when not yet paired", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-helper-state-"));
    const io = fakeIo({ SSH_AUTH_SOCK: "/tmp/whatever.sock", MULLION_HELPER_STATE_DIR: stateDir });
    const code = await runHelper("run", [], io);
    expect(code).toBe(1);
    expect(io.stderrLines.join("")).toContain("not paired");
  });
});

describe("decodePairingPayload / real bridge-registry.ts", () => {
  it("both sides agree on the pairing payload format", async () => {
    const { app, port } = await buildAndListen();
    const pairRes = await fetch(`http://127.0.0.1:${port}/api/bridges`, { method: "POST" });
    const { pairing_payload } = (await pairRes.json()) as { pairing_payload: string };
    const decoded = decodePairingPayload(pairing_payload);
    expect(decoded).not.toBeNull();
    await app.close();
  });
});
