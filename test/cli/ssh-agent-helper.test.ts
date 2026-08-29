import { describe, it, expect } from "vitest";
import net from "node:net";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { WebSocketServer, type WebSocket as NodeWebSocket } from "ws";
import { buildTestApp } from "../helpers/app.js";
import { decodePairingPayload, encodePairingPayload } from "../../src/services/bridge-registry.js";
import { runHelper, stateDir } from "../../src/cli/ssh-agent-helper.mjs";

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

// Round 3 (PR2, Windows SEA) — `io.platform`/`io.homedir` overrides let this
// exercise the win32 branch from Linux (see stateDir's own comment).
// Fake homedir/LOCALAPPDATA values below are deliberately POSIX-shaped
// (e.g. "/fake/local/appdata"), not literal "C:\..." strings — stateDir
// joins them with plain path.join, which is Node's PLATFORM-NATIVE path
// module (path.win32 only when Node itself is actually running on
// Windows), not an emulation of whatever `io.platform` claims. A literal
// backslash-laden Windows path run through this Linux test runner's
// path.join would be treated as one opaque segment and get a bogus mixed
// "C:\...\Local/Mullion" result — not a real bug in stateDir (a real
// Windows process's own native path.join handles this correctly), just an
// artifact of testing the win32 branch's LOGIC from a non-Windows runner.
// Asserting against `path.join(...)` (not a hardcoded string) keeps this
// test honest about what it actually verifies: which inputs win and in
// what order, not the separator character Node's own path module already
// gets right.
describe("stateDir", () => {
  it("resolves under %LOCALAPPDATA% on win32", () => {
    const io = { env: { LOCALAPPDATA: "/fake/local/appdata" }, platform: "win32" };
    expect(stateDir(io)).toBe(path.join("/fake/local/appdata", "Mullion"));
  });

  it("falls back to <homedir>/AppData/Local on win32 when LOCALAPPDATA is unset", () => {
    const io = { env: {}, platform: "win32", homedir: "/fake/home" };
    expect(stateDir(io)).toBe(path.join("/fake/home", "AppData", "Local", "Mullion"));
  });

  it("MULLION_HELPER_STATE_DIR still wins on win32, same as every other platform", () => {
    const io = {
      env: { MULLION_HELPER_STATE_DIR: "/custom/state", LOCALAPPDATA: "/ignored" },
      platform: "win32",
    };
    expect(stateDir(io)).toBe("/custom/state");
  });

  it("stays on the posix XDG_STATE_HOME/~/.local/state shape on linux/darwin, unaffected", () => {
    const io = { env: {}, platform: "linux", homedir: "/home/me" };
    expect(stateDir(io)).toBe("/home/me/.local/state/mullion");
  });
});

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

async function startFakeBridgeServer() {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const address = wss.address();
  if (typeof address === "string" || address === null) throw new Error("expected a real address");
  return { wss, baseUrl: `http://127.0.0.1:${address.port}` };
}

describe("handshake() failure modes (pair, against a fake bridge server)", () => {
  // Issue #820 (PR6) — handshake()'s branches beyond the {type:"ready"} and
  // {type:"error"} paths already exercised by the happy-path and
  // invalid-session tests above: a peer that replies with garbage, a
  // reply of the wrong shape, or one that drops the connection outright,
  // each of which must reject with a clear message rather than hang or
  // throw an unhandled error.
  const scenarios: Array<{ name: string; act: (socket: NodeWebSocket) => void }> = [
    {
      name: "malformed JSON",
      act: (socket) => socket.send("{not json"),
    },
    {
      name: "well-formed JSON of the wrong shape",
      act: (socket) =>
        socket.send(JSON.stringify({ type: "ready" /* missing bridge_id/session_id */ })),
    },
    {
      name: "an unrecognized message type",
      act: (socket) => socket.send(JSON.stringify({ type: "surprise" })),
    },
    {
      name: "the connection closing before any reply",
      act: (socket) => socket.close(),
    },
  ];

  for (const { name, act } of scenarios) {
    it(`pair() fails cleanly on ${name}`, async () => {
      const { wss, baseUrl } = await startFakeBridgeServer();
      wss.once("connection", (socket) => {
        socket.once("message", () => act(socket));
      });

      const payload = encodePairingPayload({ baseUrl, code: "irrelevant" });
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-helper-state-"));
      const io = fakeIo({ MULLION_HELPER_STATE_DIR: stateDir });
      const code = await runHelper("pair", [payload], io);
      expect(code).toBe(1);
      expect(fs.existsSync(path.join(stateDir, "ssh-agent-bridge.json"))).toBe(false);

      wss.close();
    });
  }

  it("pair() fails cleanly when the socket errors before ever opening (unreachable host)", async () => {
    // Port 1 on loopback: reserved, nothing ever listens there — a real,
    // fast connection-refused, not a synthetic error.
    const payload = encodePairingPayload({ baseUrl: "http://127.0.0.1:1", code: "irrelevant" });
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-helper-state-"));
    const io = fakeIo({ MULLION_HELPER_STATE_DIR: stateDir });
    const code = await runHelper("pair", [payload], io);
    expect(code).toBe(1);
  });
});

describe("mullion helper run()'s reconnect and dial-failure behavior", () => {
  async function pairAndWaitForRunConnection(runIo: ReturnType<typeof fakeIo>) {
    const { app, port } = await buildAndListen();
    const baseUrl = `http://127.0.0.1:${port}`;
    const pairRes = await fetch(`${baseUrl}/api/bridges`, { method: "POST" });
    const { pairing_payload } = (await pairRes.json()) as { pairing_payload: string };
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-helper-state-"));
    const pairIo = fakeIo({ MULLION_HELPER_STATE_DIR: stateDir });
    await runHelper("pair", [pairing_payload, "--name", "test-laptop"], pairIo);
    const credential = JSON.parse(
      fs.readFileSync(path.join(stateDir, "ssh-agent-bridge.json"), "utf8"),
    );
    await waitUntil(() => !app.connectedBridges.has(credential.bridgeId));

    runIo.env.MULLION_HELPER_STATE_DIR = stateDir;
    const runPromise = runHelper("run", [], runIo);
    await waitUntil(() => runIo.stderrLines.some((line) => line.includes("connected to")));
    return { app, credential, runPromise };
  }

  // Issue #820 (PR6) — a channel the primary opens whose local dial target
  // (SSH_AUTH_SOCK) doesn't exist must close the CHANNEL, not hang — the
  // socket.on("error", () => channel.close()) branch in runRun's onChannel
  // handler. Confirmed from the SERVER side: a channel the primary opened
  // actually closes, rather than sitting open forever.
  it("closes the channel (not just the local socket) when the local ssh-agent dial fails", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-helper-state-nonexistent-"));
    const runIo = fakeIo({ SSH_AUTH_SOCK: path.join(stateDir, "no-such-agent.sock") });
    const { app, credential, runPromise } = await pairAndWaitForRunConnection(runIo);
    const bridge = app.connectedBridges.get(credential.bridgeId)!;

    const serverChannel = await bridge.mux.openChannel();
    await waitUntil(() => serverChannel.closed);

    runIo.triggerInterrupt();
    bridge.mux.close();
    expect(await runPromise).toBe(0);
    await app.close();
  });

  // Issue #820 (PR6) — the reconnect-with-backoff path itself: a
  // disconnect that ISN'T caused by the helper's own shutdown (stopped
  // still false when mux.onClose fires) must log and loop back into a new
  // connection attempt, not just exit. Confirmed by observing a SECOND
  // "connected to" line after the primary drops the first connection out
  // from under the client.
  it("reconnects (not just exits) when the connection drops before the helper itself was asked to stop", async () => {
    const runIo = fakeIo({ SSH_AUTH_SOCK: "/tmp/whatever-unused.sock" });
    const { app, credential, runPromise } = await pairAndWaitForRunConnection(runIo);

    // Drop the connection from the server side WITHOUT setting `stopped` —
    // this is what a real network blip / laptop sleep looks like, as
    // opposed to every other test's clean-shutdown ordering (interrupt
    // first, then close).
    app.connectedBridges.get(credential.bridgeId)!.mux.close();
    // RECONNECT_DELAYS_MS[0] (1000ms) is a real, unmocked timer here — the
    // reconnect loop backs off before its next attempt — so this needs
    // more than the default 3000ms budget.
    await waitUntil(
      () => runIo.stderrLines.filter((line) => line.includes("connected to")).length >= 2,
      8000,
    );

    runIo.triggerInterrupt();
    app.connectedBridges.get(credential.bridgeId)!.mux.close();
    expect(await runPromise).toBe(0);
    await app.close();
  });
});

describe("mullion helper run()'s session renewal (round 3)", () => {
  // Forces the just-paired session to a near-immediate expiry so
  // scheduleRenewal's 50%-of-TTL math floors to its 1000ms minimum instead
  // of waiting out a real 24h TTL — same "force it directly in the DB"
  // approach test/services/bridge-registry.test.ts already uses for
  // pairing-code expiry. Set AFTER pairing (which needs the real 24h
  // window to succeed) but BEFORE run() ever connects, so the very first
  // "auth" handshake already reads the shortened expiry from
  // routes/agent-bridge.ts's own fresh-off-the-row expires_at.
  async function pairAndForceNearExpiry(runIo: ReturnType<typeof fakeIo>) {
    const { app, port } = await buildAndListen();
    const baseUrl = `http://127.0.0.1:${port}`;
    const pairRes = await fetch(`${baseUrl}/api/bridges`, { method: "POST" });
    const { pairing_payload } = (await pairRes.json()) as { pairing_payload: string };
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-helper-state-"));
    const pairIo = fakeIo({ MULLION_HELPER_STATE_DIR: stateDir });
    await runHelper("pair", [pairing_payload], pairIo);
    const credentialFile = path.join(stateDir, "ssh-agent-bridge.json");
    const credential = JSON.parse(fs.readFileSync(credentialFile, "utf8"));
    await waitUntil(() => !app.connectedBridges.has(credential.bridgeId));

    const { bridges } = await import("../../src/db/schema.js");
    const { eq } = await import("drizzle-orm");
    app.db
      .update(bridges)
      .set({ sessionExpiresAt: new Date(Date.now() + 4000) })
      .where(eq(bridges.id, credential.bridgeId))
      .run();

    runIo.env.MULLION_HELPER_STATE_DIR = stateDir;
    const runPromise = runHelper("run", [], runIo);
    await waitUntil(() => runIo.stderrLines.some((line) => line.includes("connected to")));
    return { app, stateDir, credentialFile, credential, runPromise };
  }

  it("renews before expiry, persists the rotated credential, and never disturbs the live connection", async () => {
    const runIo = fakeIo({ SSH_AUTH_SOCK: "/tmp/whatever-unused.sock" });
    const { app, credentialFile, credential, runPromise } = await pairAndForceNearExpiry(runIo);

    await waitUntil(() => runIo.stderrLines.some((line) => line.includes("session renewed")), 8000);

    const renewed = JSON.parse(fs.readFileSync(credentialFile, "utf8"));
    expect(renewed.sessionId).not.toBe(credential.sessionId);
    expect(new Date(renewed.expiresAt).getTime()).toBeGreaterThan(Date.now());
    // fd-based mode check, same pattern as the happy-path pairing test —
    // a rewritten (renamed-into-place) file must still be 0600, not
    // whatever fs.renameSync's target inherits by default.
    expect(fs.statSync(credentialFile).mode & 0o777).toBe(0o600);

    // The renewal is a plain HTTP call, never touching the live WS — this
    // is still the SAME, never-reconnected connection: exactly one
    // "connected to" line for the whole test.
    expect(runIo.stderrLines.filter((line) => line.includes("connected to")).length).toBe(1);
    expect(runIo.stderrLines.some((line) => line.includes("reconnecting"))).toBe(false);
    expect(app.connectedBridges.has(credential.bridgeId)).toBe(true);

    runIo.triggerInterrupt();
    app.connectedBridges.get(credential.bridgeId)!.mux.close();
    expect(await runPromise).toBe(0);
    await app.close();
  });

  // Revokes via the bare service function (bridge-registry.ts's
  // deleteBridge), NOT the DELETE /api/bridges/:id ROUTE — the route would
  // close the live connection itself as part of revocation, which would
  // exercise a completely different code path (the existing "reconnects
  // after a drop" test) and never actually prove that a renewal REJECTION
  // is what forces the shutdown. This leaves the WS connection genuinely
  // untouched server-side, so the only thing that can end it is `run`'s
  // own activeWs?.close() in the renewal-rejected branch.
  it("a rejected renewal (bridge deleted server-side) forces shutdown and exits 1 with a re-pair message", async () => {
    const runIo = fakeIo({ SSH_AUTH_SOCK: "/tmp/whatever-unused.sock" });
    const { app, credential, runPromise } = await pairAndForceNearExpiry(runIo);

    const { deleteBridge } = await import("../../src/services/bridge-registry.js");
    deleteBridge(app, credential.bridgeId);

    const code = await runPromise;
    expect(code).toBe(1);
    expect(runIo.stderrLines.join("")).toContain("renewal rejected");
    expect(runIo.stderrLines.join("")).toContain("re-pair");
    await app.close();
  });

  // The 0.3.3-era credential shape (no `expiresAt` at all) must still work
  // — loadCredential's own back-compat allowance, exercised end-to-end here
  // rather than just at the loadCredential-unit level, since the real risk
  // was never "does it load" but "does the FIRST scheduleRenewal(), armed
  // with no expiresAt to go on, race the in-flight first handshake" (see
  // ssh-agent-helper.mjs's own comment on `renewalArmed` for the failure
  // mode this guards against).
  it("a legacy credential file with no expiresAt connects cleanly and picks one up after its first auth", async () => {
    const { app, port } = await buildAndListen();
    const baseUrl = `http://127.0.0.1:${port}`;
    const pairRes = await fetch(`${baseUrl}/api/bridges`, { method: "POST" });
    const { pairing_payload } = (await pairRes.json()) as { pairing_payload: string };
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-helper-state-"));
    const pairIo = fakeIo({ MULLION_HELPER_STATE_DIR: stateDir });
    await runHelper("pair", [pairing_payload], pairIo);
    const credentialFile = path.join(stateDir, "ssh-agent-bridge.json");
    const credential = JSON.parse(fs.readFileSync(credentialFile, "utf8"));
    delete credential.expiresAt;
    fs.writeFileSync(credentialFile, JSON.stringify(credential), { mode: 0o600 });
    await waitUntil(() => !app.connectedBridges.has(credential.bridgeId));

    const runIo = fakeIo({
      SSH_AUTH_SOCK: "/tmp/whatever-unused.sock",
      MULLION_HELPER_STATE_DIR: stateDir,
    });
    const runPromise = runHelper("run", [], runIo);
    await waitUntil(() => runIo.stderrLines.some((line) => line.includes("connected to")));

    // No HandshakeRejectedError from a renewal that raced the handshake —
    // the connection is up and a real expiresAt eventually lands on disk.
    await waitUntil(() => {
      const onDisk = JSON.parse(fs.readFileSync(credentialFile, "utf8"));
      return typeof onDisk.expiresAt === "string";
    }, 5000);
    expect(app.connectedBridges.has(credential.bridgeId)).toBe(true);
    expect(runIo.stderrLines.join("")).not.toContain("session no longer valid");

    runIo.triggerInterrupt();
    app.connectedBridges.get(credential.bridgeId)!.mux.close();
    expect(await runPromise).toBe(0);
    await app.close();
  });

  // Self-review (round 3) found a real race: renewSession() and the
  // connect/reconnect loop are independent by design, but a WS drop for an
  // UNRELATED reason (network blip, laptop sleep) can land while a renewal
  // is in flight — the reconnect's "auth" then presents the id the renewal
  // is ABOUT to rotate away, gets rejected, and (before the fix below) the
  // loop treated any auth rejection as unconditionally fatal, discarding a
  // perfectly healthy, already-rotated credential and exiting 1.
  //
  // Reproducing this deterministically needs precise control over exactly
  // when the server rotates the session vs. when it replies to the renewal
  // call vs. when the reconnect's "auth" reaches it — timing the real
  // primary app's own SQLite-backed round trip can't guarantee. This uses a
  // hand-rolled HTTP+WS server instead, sequenced explicitly:
  //   1. First "auth" (old id) succeeds; scheduleRenewal arms at ~1000ms
  //      (the floor, for a ~2s forced TTL).
  //   2. The renewal POST arrives; the server rotates its truth to the new
  //      id IMMEDIATELY (synchronously) but delays the HTTP response 1800ms
  //      — longer than RECONNECT_DELAYS_MS[0] (1000ms) — and closes the
  //      live WS right away, simulating an unrelated drop.
  //   3. The reconnect's "auth" (still holding the old id — the delayed
  //      renewal response hasn't reached the client yet) arrives ~1000ms
  //      later and gets rejected, since the server's truth already moved
  //      on in step 2.
  //   4. The delayed renewal response then lands (t≈1800ms after step 2),
  //      updating the client's credential — this is what the fix's
  //      `await renewalPromise` inside the rejection handler waits for.
  //   5. The loop must retry with the NEW id (logging the "superseded by a
  //      concurrent renewal" line) rather than exiting 1.
  it("a reconnect racing an in-flight renewal retries with the rotated id instead of exiting fatally", async () => {
    const bridgeId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const oldSessionId = "1".repeat(64);
    const newSessionId = "2".repeat(64);
    let currentValidSessionId = oldSessionId;
    let firstWs: NodeWebSocket | null = null;
    let staleRejectionSent = false;
    let succeededWithNewId = false;

    const httpServer = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/api/bridges/renew") {
        let body = "";
        req.on("data", (chunk: Buffer) => (body += chunk.toString()));
        req.on("end", () => {
          const parsed = JSON.parse(body) as { bridge_id: string; session_id: string };
          if (parsed.session_id !== currentValidSessionId) {
            res.writeHead(401, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "invalid or expired session credential" }));
            return;
          }
          currentValidSessionId = newSessionId;
          firstWs?.close();
          setTimeout(() => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                session_id: newSessionId,
                expires_at: new Date(Date.now() + 60_000).toISOString(),
              }),
            );
          }, 1800);
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const wss = new WebSocketServer({ noServer: true });
    httpServer.on("upgrade", (req, socket, head) => {
      if (req.url !== "/ws/agent-bridge") {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
    });
    let connectionCount = 0;
    wss.on("connection", (ws: NodeWebSocket) => {
      connectionCount++;
      if (connectionCount === 1) firstWs = ws;
      ws.once("message", (data: Buffer) => {
        const parsed = JSON.parse(data.toString()) as { session_id: string };
        if (parsed.session_id !== currentValidSessionId) {
          staleRejectionSent = true;
          ws.send(JSON.stringify({ type: "error", message: "invalid session credential" }));
          ws.close();
          return;
        }
        if (parsed.session_id === newSessionId) succeededWithNewId = true;
        ws.send(
          JSON.stringify({
            type: "ready",
            bridge_id: bridgeId,
            expires_at: new Date(Date.now() + 2000).toISOString(),
          }),
        );
      });
    });

    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected a real bound address");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-helper-state-"));
    fs.writeFileSync(
      path.join(stateDir, "ssh-agent-bridge.json"),
      JSON.stringify({
        baseUrl,
        bridgeId,
        sessionId: oldSessionId,
        expiresAt: new Date(Date.now() + 2000).toISOString(),
      }),
      { mode: 0o600 },
    );

    const runIo = fakeIo({
      SSH_AUTH_SOCK: "/tmp/whatever-unused.sock",
      MULLION_HELPER_STATE_DIR: stateDir,
    });
    const runPromise = runHelper("run", [], runIo);

    await waitUntil(() => succeededWithNewId, 15000);
    expect(staleRejectionSent).toBe(true);
    expect(runIo.stderrLines.join("")).toContain("superseded by a concurrent renewal");
    expect(runIo.stderrLines.join("")).not.toContain("session no longer valid");

    runIo.triggerInterrupt();
    const code = await runPromise;
    expect(code).toBe(0);
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }, 20000);
});

describe("mullion helper run() — missing prerequisites", () => {
  it("fails with a clear message when SSH_AUTH_SOCK is unset and no --ssh-auth-sock given", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-helper-state-"));
    const io = fakeIo({ MULLION_HELPER_STATE_DIR: stateDir });
    const code = await runHelper("run", [], io);
    expect(code).toBe(1);
    expect(io.stderrLines.join("")).toContain("SSH_AUTH_SOCK");
  });

  // Round 3 (PR2) — on win32, an unset SSH_AUTH_SOCK must NOT be treated
  // as missing: it defaults to the named pipe (issue #874's empirically
  // confirmed default). Proven by which error fires next — "not paired"
  // (the credential check runRun runs right after resolving sshAuthSock),
  // not "no SSH_AUTH_SOCK" — since nothing here ever actually connects to
  // a real pipe.
  it("on win32, an unset SSH_AUTH_SOCK defaults to the named pipe instead of failing", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-helper-state-"));
    const io = fakeIo({ MULLION_HELPER_STATE_DIR: stateDir });
    (io as unknown as { platform: string }).platform = "win32";
    const code = await runHelper("run", [], io);
    expect(code).toBe(1);
    expect(io.stderrLines.join("")).toContain("not paired");
    expect(io.stderrLines.join("")).not.toContain("no SSH_AUTH_SOCK");
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
