import { describe, it, expect } from "vitest";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { WebSocketServer } from "ws";
import { buildTestApp } from "../helpers/app.js";
import { decodePairingPayload, encodePairingPayload } from "../../src/services/bridge-registry.js";
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

    // fd-based stat+read (not two separate path-based calls) — CodeQL
    // (js/file-system-race) correctly flagged the original stat-then-read
    // pair as a TOCTOU: reading through the SAME already-open handle used
    // for the mode check makes the two operations atomic with respect to
    // each other, closing that gap outright rather than merely narrowing
    // it (this is a local temp-dir test file nothing else touches, so the
    // real-world risk was negligible, but the fix is free).
    const credentialFile = path.join(stateDir, "ssh-agent-bridge.json");
    const fd = fs.openSync(credentialFile, "r");
    let credential;
    try {
      expect(fs.fstatSync(fd).mode & 0o777).toBe(0o600);
      credential = JSON.parse(fs.readFileSync(fd, "utf8"));
    } finally {
      fs.closeSync(fd);
    }
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

    // Waiting on connectedBridges alone is a race under CI-level load
    // (confirmed by two separate CI failures reproducing "no OpenAck
    // within 10000ms" against real GitHub Actions runners, never in fast
    // local isolation): the server tracks the bridge — and therefore
    // shows up in connectedBridges — BEFORE it sends "ready" to the
    // client, and runRun() only calls attachInboundMux() (which is what
    // actually starts listening for Open frames) *after* "ready" arrives
    // there. A channel opened as soon as connectedBridges flips true can
    // land in that gap and be silently dropped — nothing was listening
    // yet. Waiting for the client's own "connected to" stderr line
    // instead (emitted synchronously, immediately before attachInboundMux
    // in ssh-agent-helper.mjs) closes that gap: by the time it's visible
    // here, the client-side listener is already attached.
    await waitUntil(() => runIo.stderrLines.some((line) => line.includes("connected to")));
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
      // Well-formed-but-nonexistent (real UUID/64-hex shapes) — this must
      // exercise the SERVER's own "invalid session credential" rejection,
      // not this CLI's own loadCredential shape validation (which now
      // rejects anything that doesn't look like a real bridge_registry.ts
      // -issued id, and would reject a literal "nonexistent" before ever
      // reaching the network).
      JSON.stringify({
        baseUrl,
        bridgeId: "00000000-0000-4000-8000-000000000000",
        sessionId: "0".repeat(64),
      }),
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

  // Issue #820 (CodeQL js/http-to-file-access, PR #866) — the discriminating
  // test for saveCredential's own shape validation: a peer replying with a
  // "ready" message that doesn't look like a real bridge-registry.ts-issued
  // id/token must never be persisted, whether it's a misbehaving primary or
  // a payload pointed at the wrong server entirely.
  it("pair() refuses to persist a handshake reply with a malformed bridge_id/session_id", async () => {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    const address = wss.address();
    if (typeof address === "string" || address === null) throw new Error("expected a real address");
    wss.once("connection", (socket) => {
      socket.once("message", () => {
        socket.send(
          JSON.stringify({ type: "ready", bridge_id: "not-a-uuid", session_id: "not-hex" }),
        );
      });
    });

    const payload = encodePairingPayload({
      baseUrl: `http://127.0.0.1:${address.port}`,
      code: "irrelevant-the-fake-server-never-checks-it",
    });
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-helper-state-"));
    const io = fakeIo({ MULLION_HELPER_STATE_DIR: stateDir });
    const code = await runHelper("pair", [payload], io);
    expect(code).toBe(1);
    expect(fs.existsSync(path.join(stateDir, "ssh-agent-bridge.json"))).toBe(false);

    wss.close();
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

  // Issue #820 (CodeQL js/file-access-to-http, PR #866) — the discriminating
  // test for loadCredential's own shape validation: a hand-edited or
  // otherwise corrupted credential file must be treated the same as "never
  // paired" (never used to dial anywhere), not blindly trusted.
  it("treats a credential file with a malformed bridgeId/sessionId the same as not-yet-paired", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-helper-state-"));
    fs.writeFileSync(
      path.join(stateDir, "ssh-agent-bridge.json"),
      JSON.stringify({
        baseUrl: "http://127.0.0.1:1",
        bridgeId: "'; DROP TABLE bridges; --",
        sessionId: "short",
      }),
      { mode: 0o600 },
    );
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
