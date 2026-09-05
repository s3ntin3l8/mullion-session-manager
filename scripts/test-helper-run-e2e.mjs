#!/usr/bin/env node
// Issue #1054 — end-to-end test of the spawned `mullion-helper` binary's
// `run` verb against a real Mullion server. Exercises the full SSH-agent
// bridge stack the macOS .pkg ships on every release:
//   - real primary boots and listens on a chosen loopback port
//   - real `mullion-helper pair` produces a credential file
//   - real `mullion-helper run --json-events` connects via WebSocket
//     against that credential and pipes through a fake local SSH agent
//   - a sign request from a real client connecting to the primary's
//     materialized ssh-agent.sock reaches the fake agent (proves the
//     full bridge round trip, not just the connect handshake)
//   - killing the helper and restarting it drives a real
//     `disconnected` → `connected` cycle through the reconnect ladder
//
// This is what `test-macos` in .github/workflows/ci-cd.yml gates on:
// without it, every prior round's bridge fixes (Retry-After renewal,
// bound sockets, health checks, TOCTOU revocation, validation, ...) had
// no end-to-end coverage on macOS at all — only install/uninstall and
// `bogus` smoke tests existed before this PR.
//
// Companion to test/cli/ssh-agent-helper.test.ts's own end-to-end
// assertion of the same stack — that test imports runHelper directly for
// coverage, this one spawns the SEA binary so the shell wrapper itself
// (argv parsing, `--json-events` plumbed through, signal handling, ...)
// is also exercised.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, openSync, readFileSync, closeSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildApp } from "../src/app.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");
const helperBin = path.join(repoRoot, "build", "helper-sea", "mullion-helper");

// --- CLI args -------------------------------------------------------------

function parseArgs(argv) {
  const opts = { port: undefined, helperPath: helperBin, timeoutMs: 30000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") opts.port = Number(argv[++i]);
    else if (a === "--helper-path") opts.helperPath = argv[++i];
    else if (a === "--timeout-ms") opts.timeoutMs = Number(argv[++i]);
    else throw new Error(`unknown arg: ${a}`);
  }
  if (
    typeof opts.port !== "number" ||
    !Number.isInteger(opts.port) ||
    opts.port <= 0 ||
    opts.port > 65535
  ) {
    throw new Error(`--port must be a real TCP port, got ${opts.port}`);
  }
  return opts;
}

// --- Helpers --------------------------------------------------------------

/** Polls `check()` until true or `timeoutMs` elapses; resolves with the
 *  number of polls it took or rejects with the last observed value. */
async function waitFor(label, check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = check();
      if (last !== undefined) return last;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for ${label} (last: ${JSON.stringify(last)})`,
  );
}

/** A fake local SSH agent standing in for `SSH_AUTH_SOCK` on the helper
 *  side. Echoes every received byte prefixed with "agent-reply:" — the
 *  same fixture shape test/cli/ssh-agent-helper.test.ts uses (real test
 *  of the round trip is whether the BYTES we sent show up, not whether
 *  they parse as a real ssh-agent reply). Listens on a unix socket. */
async function startFakeAgent(socketPath) {
  const { createServer } = await import("node:net");
  const received = [];
  const server = createServer((socket) => {
    socket.on("data", (chunk) => {
      received.push(chunk);
      socket.write(Buffer.concat([Buffer.from("agent-reply:"), chunk]));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return {
    received,
    /** Total bytes received so far (shared buffer; safe for the assertions
     *  below because each one drains its own chunk before the next). */
    bytesReceived() {
      return Buffer.concat(received);
    },
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** Drains the helper's stdout NDJSON stream, accumulating events into an
 *  array. The helper writes one JSON object per line; a malformed line
 *  is ignored (per ssh-agent-helper.mjs's emitEvent contract, it always
 *  emits well-formed JSON, so this is purely defensive). Returns
 *  `{ events, kill }` — `kill()` ends the underlying stream consumer so
 *  the helper can exit cleanly without an open pipe. */
function trackHelperEvents(child) {
  const events = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.length === 0) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        // ignore
      }
    }
  });
  return events;
}

function spawnHelper(args, env, binPath = helperBin) {
  const child = spawn(binPath, args, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  return child;
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timer = setTimeout(() => {
      reject(new Error(`helper did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

/** Sends `bytes` to `path` and waits up to `timeoutMs` for a reply.
 *  Used to drive the primary's materialized ssh-agent.sock from the
 *  outside — the same shape an SSH client would use. */
function sendSignRequest(socketPath, bytes, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ path: socketPath });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`no reply within ${timeoutMs}ms`));
    }, timeoutMs);
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.once("connect", () => {
      socket.write(bytes);
    });
    const chunks = [];
    let resolved = false;
    // Resolve on first data: the bridge server pipes the fake agent's
    // reply straight through ssh-agent-mux.ts's channel.onData → the
    // accepted socket's write(), and never sends an EOF back to the
    // caller (channel.onEof triggers a half-close `socket.end()` only
    // after the upstream channel closes, and a fake agent that just
    // echoes and stays open doesn't reach that point). Waiting on
    // `socket.on("end")` here would deadlock the test forever.
    //
    // The split-chunk case the PR review flagged is real in principle
    // but not reachable on loopback + a small reply payload: a single
    // `socket.write()` from the server typically arrives as one `data`
    // event on the client, and even if it didn't (NIC-level coalescing
    // across loopback is rare), a 64 KiB-cap'd kernel buffer will hold
    // any realistic reply atomically.
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(Buffer.concat(chunks));
      }
    });
  });
}

// --- Main -----------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const tempRoot = mkdtempSync(path.join(tmpdir(), "mullion-helper-e2e-"));
  const sessionsDir = path.join(tempRoot, "sessions");
  const dbPath = path.join(tempRoot, "app.db");
  const stateDir = path.join(tempRoot, "state");
  const fakeAgentSock = path.join(tempRoot, "fake-agent.sock");

  // --- Boot a real primary on a chosen loopback port ----------------------
  // Required envs for a primary-role boot with no in-app auth (the
  // test gate is the bridge stack, not auth — MULLION_TRUST_GATEWAY
  // acknowledges "no auth here, that's fine for this CI context",
  // same posture test/setup.ts takes for the unit suite).
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.SESSIONS_DIR = sessionsDir;
  process.env.FRONTEND_DIST = tempRoot; // never read; point at a real dir
  process.env.HOST_HEARTBEAT_INTERVAL_SECONDS = "0";
  process.env.MULLION_TRUST_GATEWAY = "true";
  process.env.PORT = String(opts.port);
  process.env.HOST = "127.0.0.1";
  // Strip every Mullion-specific env var a developer shell may have
  // inherited (mirror test/setup.ts's posture): anything pointing at a
  // shared per-machine socket path would otherwise have buildApp() try
  // to bind the WRONG path and fail with SocketAlreadyListeningError on
  // a developer's machine, or just route the helper to the wrong
  // primary on a CI runner with multiple primaries.
  for (const key of [
    "MULLION_SOCKET_PATH",
    "MULLION_HOOK_SOCKET",
    "MULLION_HOOK_TOKEN",
    "MULLION_AUTH_TOKEN",
    "MULLION_AGENT_TOKEN",
    "MULLION_SESSION_SECRET",
    "MULLION_HOME",
    "SSH_AUTH_SOCK",
    "MULLION_PRIMARY_URL",
  ]) {
    delete process.env[key];
  }

  const app = await buildApp();
  await app.listen({ port: opts.port, host: "127.0.0.1" });
  const baseUrl = `http://127.0.0.1:${opts.port}`;
  const bridgeSock = path.join(sessionsDir, "ssh-agent.sock");

  let exitCode = 0;
  // Tracked at outer scope so finally() can reap them on any failure path.
  // CRITICAL: must be killed BEFORE app.close() — Fastify's close() waits
  // for open WS connections to drain, and a still-alive helper (stuck in
  // its reconnect ladder or just slow to honor SIGTERM) will hold the
  // /ws/agent-bridge socket open indefinitely, hanging the close call
  // past the step's timeout. Previously the script's only SIGTERM went
  // out on the success path; a thrown waitFor timeout left the helper
  // running into the finally, which then deadlocked at app.close() until
  // the job-level 10-minute timeout killed the whole step
  // (issue #1054, first CI run).
  const children = [];
  async function reapChildren() {
    for (const child of children) {
      if (child.exitCode !== null) continue;
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
    }
    // Wait briefly for graceful exit, then escalate to SIGKILL. The
    // helper's reconnect loop sets `stopped=true` on SIGTERM (line 648
    // of ssh-agent-helper.mjs) and exits within ms, but a CI runner
    // under load can take longer — don't trust the happy path.
    const graceDeadline = Date.now() + 2000;
    while (Date.now() < graceDeadline) {
      if (children.every((c) => c.exitCode !== null)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    for (const child of children) {
      if (child.exitCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  }
  try {
    // --- Pair: real helper binary, real pairing payload from the server ---
    const pairRes = await fetch(`${baseUrl}/api/bridges`, { method: "POST" });
    if (!pairRes.ok) throw new Error(`POST /api/bridges -> HTTP ${pairRes.status}`);
    const { pairing_payload } = await pairRes.json();

    const pairEnv = { MULLION_HELPER_STATE_DIR: stateDir };
    const pairChild = spawnHelper(
      ["helper", "pair", pairing_payload, "--name", "ci-mac"],
      pairEnv,
      opts.helperPath,
    );
    children.push(pairChild);
    const pairStderr = [];
    pairChild.stderr.on("data", (chunk) => pairStderr.push(chunk));
    await waitForExit(pairChild, 15000)
      .then((r) => {
        if (r.code !== 0) {
          throw new Error(`helper pair exited with code ${r.code}; stderr: ${pairStderr.join("")}`);
        }
      })
      .catch((err) => {
        throw new Error(`helper pair: ${err.message}`);
      });

    // fd-based stat+read, not two path-based calls — mirrors the
    // pattern test/cli/ssh-agent-helper.test.ts uses (CodeQL flagged
    // the stat-then-read pair as TOCTOU). Same posture here even
    // though the CI temp dir isn't contested; the right tool for the
    // job is the right tool.
    const credentialPath = path.join(stateDir, "ssh-agent-bridge.json");
    const fd = openSync(credentialPath, "r");
    let credential;
    try {
      credential = JSON.parse(readFileSync(fd, "utf8"));
    } finally {
      closeSync(fd);
    }
    if (credential.baseUrl !== baseUrl) {
      throw new Error(`credential.baseUrl=${credential.baseUrl} but server is at ${baseUrl}`);
    }

    // --- Start the fake local ssh-agent -----------------------------------
    const fakeAgent = await startFakeAgent(fakeAgentSock);

    // --- First run: verify `connected` event -----------------------------
    const runEnv = {
      MULLION_HELPER_STATE_DIR: stateDir,
      SSH_AUTH_SOCK: fakeAgentSock,
    };
    const helper = spawnHelper(["helper", "run", "--json-events"], runEnv, opts.helperPath);
    children.push(helper);
    // Capture helper stderr to the test's own stderr stream. Echoing
    // it (vs swallowing it) keeps a CI failure informative: a missing
    // event that should have fired surfaces as a 30s waitFor timeout
    // PLUS the helper's own stderr text explaining why it never
    // arrived, instead of a bare "timed out waiting for `connected`".
    helper.stderr.on("data", (chunk) => {
      process.stderr.write(`[helper stderr] ${chunk}`);
    });
    const events = trackHelperEvents(helper);

    await waitFor(
      "first `connected` event",
      () => events.find((e) => e.type === "connected"),
      opts.timeoutMs,
    );
    // Helper-side `connected` carries the same bridge_id the credential
    // stored (sanity check the JSON-event stream is genuine, not the
    // server's own log shape leaking in).
    const connected1 = events.find((e) => e.type === "connected");
    if (connected1.bridge_id !== credential.bridgeId) {
      throw new Error(
        `connected event bridge_id=${connected1.bridge_id} but credential=${credential.bridgeId}`,
      );
    }

    // --- Drive a real sign request through the materialized bridge socket
    // This is what an SSH client running on the primary host would do:
    // connect to <SESSIONS_DIR>/ssh-agent.sock, send a sign request,
    // read the reply. The server opens a bridge channel via fanout, the
    // helper forwards the bytes to the fake agent, the fake agent
    // replies, and the reply comes back through the same path. A
    // successful round trip proves the bridge stack end-to-end on the
    // macOS CI runner, not just the connect handshake.
    const SIGN_REQUEST = Buffer.concat([
      Buffer.from([0, 0, 0, 1, 13]), // length-prefix + SSH_AGENTC_SIGN_REQUEST (13)
    ]);
    const reply = await sendSignRequest(bridgeSock, SIGN_REQUEST, opts.timeoutMs);
    if (!reply.includes(Buffer.from("agent-reply:"))) {
      throw new Error(
        `bridge reply did not echo through fake agent — got ${reply.toString("hex")}`,
      );
    }
    // SignOnlyFilter is wired on the helper side (round 4, issue #820)
    // and its scope is `inbound frames to the helper's own fake agent`,
    // NOT this path — the primary side forwards unfiltered by design
    // (ssh-agent.ts's own comment). The fake agent thus sees the
    // sign-request bytes unaltered; verify.
    const agentSaw = fakeAgent.bytesReceived();
    if (!agentSaw.equals(SIGN_REQUEST)) {
      throw new Error(
        `fake agent saw ${agentSaw.toString("hex")}, expected ${SIGN_REQUEST.toString("hex")}`,
      );
    }

    // --- Simulate a drop, verify `disconnected` → `connected` cycle -----
    // Close the bridge from the server side, NOT SIGTERM the helper —
    // that's the shape of a real network blip, mirroring
    // test/cli/ssh-agent-helper.test.ts's "reconnects (not just exits)
    // when the connection drops before the helper itself was asked to
    // stop" test. SIGTERM would set `stopped=true` and skip the
    // `disconnected` event entirely (runRun's loop only emits it when
    // the mux closes with `stopped` still false — see
    // ssh-agent-helper.mjs's emitEvent call site).
    const bridge = app.connectedBridges.get(credential.bridgeId);
    if (!bridge) {
      throw new Error("bridge not in app.connectedBridges after connected event");
    }
    bridge.mux.close();

    await waitFor(
      "`disconnected` event after server-side mux close",
      () => events.find((e) => e.type === "disconnected"),
      opts.timeoutMs,
    );

    // The helper's reconnect ladder (RECONNECT_DELAYS_MS[0] = 1000ms) is a
    // real, unmocked timer — wait for the helper to reconnect on its own
    // (issue #820 PR6 round 4 explicitly tested this in the unit suite).
    await waitFor(
      "second `connected` event from reconnect ladder",
      () => events.filter((e) => e.type === "connected").length >= 2,
      opts.timeoutMs,
    );

    // --- Clean shutdown --------------------------------------------------
    // reapChildren() in the finally block kills the helper on the success
    // path too, so no explicit helper.kill() here. fakeAgent.close() is
    // a unix server.shutdown() with no equivalent "wait for connections"
    // trap, so it can run inline.
    await fakeAgent.close();
  } catch (err) {
    console.error(`test-helper-run-e2e: ${err.message}`);
    exitCode = 1;
  } finally {
    // Reap helper children FIRST, then close the app. See the children
    // declaration's block comment for why this ordering matters (a live
    // helper holds the /ws/agent-bridge socket open across app.close(),
    // which Fastify's close waits on). SIGTERM, 2s grace, then SIGKILL
    // — bounded so this finally never hangs the way a hung app.close()
    // used to.
    await reapChildren();
    await app.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error(`test-helper-run-e2e: unhandled: ${err.stack ?? err.message}`);
  process.exit(1);
});
