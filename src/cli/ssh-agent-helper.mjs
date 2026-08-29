// Issue #820 (PR6) — `mullion helper`, the laptop-side reference client for
// the SSH-agent bridge (docs/ssh-agent.md). Runs on a machine with no
// Mullion checkout and typically no local Mullion server at all, so unlike
// every OTHER `mullion` subcommand it never touches the control socket
// (src/cli/mullion.mjs dispatches it before constructing a
// MullionSocketClient, the same way it already does for `mullion mcp`).
// Four verbs:
//   - `pair <payload>` — one-shot. Decodes the payload Settings generated
//     (ssh-agent-bridge-pairing.mjs), redeems it against POST /api/bridges'
//     pairing code over /ws/agent-bridge, and persists the resulting
//     session credential.
//   - `run` — long-running. Re-authenticates with the persisted credential,
//     wraps the connection in the inbound-only mux (ssh-agent-bridge-mux.mjs),
//     and for every channel the primary opens, dials this laptop's own real
//     SSH_AUTH_SOCK and pipes the two together.
//   - `install`/`uninstall` (PR6b, ssh-agent-helper-install.mjs) — generate
//     and (de)register a launchd job (macOS) or systemd --user unit (Linux)
//     that supervises `run`. `stateDir`/`loadCredential` are exported below
//     specifically so that file can reuse them without duplicating the
//     credential-file logic.

import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decodePairingPayload } from "./ssh-agent-bridge-pairing.mjs";
import { attachInboundMux, pipeNetSocketToChannel } from "./ssh-agent-bridge-mux.mjs";
import { extractFlags, CliUsageError } from "./core.mjs";
import { runInstall, runUninstall } from "./ssh-agent-helper-install.mjs";

// Mirrors ssh-agent-fanout.ts's own reconnect ladder (src/services/) —
// same reasoning: fast retries for a blip, backing off for a genuinely
// unreachable primary, never giving up outright (a laptop that's asleep
// for hours must resume forwarding on its own once it wakes, with no
// manual restart).
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];
const CONNECT_TIMEOUT_MS = 10_000;
// The primary's own HANDSHAKE_TIMEOUT_MS (routes/agent-bridge.ts) is
// 10_000ms for the FIRST frame after the socket opens — this must be at
// least that long, or a slow-but-honest handshake would be aborted by this
// side before the server even times it out itself.
const HANDSHAKE_TIMEOUT_MS = 10_000;

/** Thrown for a handshake the SERVER explicitly rejected (bad pairing code,
 * invalid/expired session) — as opposed to a network-level failure (DNS,
 * refused, timeout). The distinction matters to `run`'s reconnect loop:
 * retrying an explicit rejection with the same credential will never
 * succeed, so it must fail loudly instead of retrying forever into the
 * backoff ladder. */
export class HandshakeRejectedError extends Error {}

function toWsUrl(baseUrl, urlPath) {
  const url = new URL(urlPath, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Opens `ws`, sends `message` as the first (JSON, text) frame per
 * routes/agent-bridge.ts's ClientHandshake protocol, and resolves with the
 * server's `{type:"ready", ...}` reply — leaving `ws` open and undrained of
 * any LATER frame (the mux protocol's binary frames), since this only ever
 * consumes the one handshake reply. Rejects with HandshakeRejectedError for
 * a `{type:"error"}` reply, or a plain Error for anything network-level
 * (connect timeout, socket error, closed before replying). */
function handshake(ws, message) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let replyTimer = null;

    // {once:true} already keeps each of these from firing twice, but does
    // NOT remove a listener that never fired at all — e.g. "error"/"close"
    // stay registered on `ws` for the rest of its lifetime after a normal
    // successful resolve (Hermes review, PR #866). Harmless (they no-op on
    // `settled`), but `ws` is reused afterward for the long-lived mux
    // connection in `run`'s reconnect loop, so cleaning up every listener
    // once settled — not just the one that actually fired — avoids
    // accumulating one extra closure pinned to it per reconnect attempt.
    function cleanup() {
      clearTimeout(connectTimer);
      if (replyTimer !== null) clearTimeout(replyTimer);
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", onClose);
    }

    const connectTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      ws.close();
      reject(new Error(`timed out connecting within ${CONNECT_TIMEOUT_MS}ms`));
    }, CONNECT_TIMEOUT_MS);

    function onOpen() {
      clearTimeout(connectTimer);
      ws.send(JSON.stringify(message));
      replyTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        ws.close();
        reject(new Error(`no handshake reply within ${HANDSHAKE_TIMEOUT_MS}ms`));
      }, HANDSHAKE_TIMEOUT_MS);
    }

    function onMessage(event) {
      if (settled) return;
      let parsed;
      try {
        parsed = JSON.parse(typeof event.data === "string" ? event.data : "");
      } catch {
        settled = true;
        cleanup();
        reject(new Error("malformed handshake reply"));
        return;
      }
      if (parsed?.type === "error") {
        settled = true;
        cleanup();
        reject(new HandshakeRejectedError(parsed.message || "handshake rejected"));
        return;
      }
      if (parsed?.type !== "ready") {
        settled = true;
        cleanup();
        reject(new Error(`unexpected handshake reply: ${JSON.stringify(parsed)}`));
        return;
      }
      settled = true;
      cleanup();
      resolve(parsed);
    }

    function onError() {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("connection error"));
    }

    function onClose() {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("connection closed before completing handshake"));
    }

    ws.addEventListener("open", onOpen, { once: true });
    ws.addEventListener("message", onMessage);
    ws.addEventListener("error", onError, { once: true });
    ws.addEventListener("close", onClose, { once: true });
  });
}

// Issue #820 (PR6) — CodeQL flagged both directions of this credential's
// flow (js/http-to-file-access: the server's handshake reply reaching
// fs.writeFileSync in saveCredential; js/file-access-to-http: the
// credential file's own contents reaching `new WebSocket(...)`/the auth
// handshake in runRun). Both are real code-shape matches for those
// queries' generic "arbitrary network payload written to disk" /
// "arbitrary file content exfiltrated over the network" heuristics, even
// though the actual risk here is bounded (the "server" is whatever
// baseUrl the operator's own pairing payload named, and the "file" is a
// credential this same tool wrote for itself) — validating the exact
// shape every one of these fields is generated in (bridge-registry.ts:
// crypto.randomUUID() for bridgeId, crypto.randomBytes(32).toString("hex")
// for sessionId/sessionSecret) before it crosses either boundary is both
// a genuine hardening (a misbehaving primary or a hand-edited credential
// file is rejected outright, not blindly trusted) and the sanitizing gate
// these queries are designed to recognize.
const BRIDGE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_TOKEN_RE = /^[0-9a-f]{64}$/i;

function isValidBridgeId(value) {
  return typeof value === "string" && BRIDGE_ID_RE.test(value);
}

function isValidSessionToken(value) {
  return typeof value === "string" && SESSION_TOKEN_RE.test(value);
}

function isValidHttpBaseUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function stateDir(io) {
  if (io.env.MULLION_HELPER_STATE_DIR) return io.env.MULLION_HELPER_STATE_DIR;
  const base = io.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(base, "mullion");
}

function credentialPath(io) {
  return path.join(stateDir(io), "ssh-agent-bridge.json");
}

/** `null` for a missing or malformed credential file, never a throw — the
 * caller's job is to print a "run 'mullion helper pair'" hint, not to
 * surface a raw parse error for a file the user never hand-edits. */
export function loadCredential(io) {
  let raw;
  try {
    raw = fs.readFileSync(credentialPath(io), "utf8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const { baseUrl, bridgeId, sessionId } = parsed ?? {};
  if (
    !isValidHttpBaseUrl(baseUrl) ||
    !isValidBridgeId(bridgeId) ||
    !isValidSessionToken(sessionId)
  ) {
    return null;
  }
  return parsed;
}

/** 0700 dir / 0600 file — this credential is a live signing-oracle
 * bearer token for as long as the session is valid, same posture as
 * ssh-agent-socket.ts's own chmodSync(socketPath, 0o600). chmodSync after
 * writeFileSync, not just writeFileSync's own `mode` option, because that
 * option only applies when the file is CREATED — an overwrite of a
 * pre-existing file (re-pairing) would otherwise keep whatever looser
 * mode it already had. */
function saveCredential(io, credential) {
  const dir = stateDir(io);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = credentialPath(io);
  fs.writeFileSync(file, `${JSON.stringify(credential, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

async function runPair(args, io) {
  const { flags, rest } = extractFlags(args, { name: "string" });
  const [payload] = rest;
  if (!payload) {
    throw new CliUsageError("usage: mullion helper pair <payload> [--name <name>]");
  }
  const decoded = decodePairingPayload(payload);
  if (!decoded) {
    throw new CliUsageError(
      "invalid pairing payload — paste it exactly as shown in Settings -> Hosts -> SSH agent bridges",
    );
  }

  const ws = new WebSocket(toWsUrl(decoded.baseUrl, "/ws/agent-bridge"));
  let ready;
  try {
    ready = await handshake(ws, {
      type: "pair",
      code: decoded.code,
      name: flags.name || os.hostname(),
      platform: process.platform,
    });
  } finally {
    ws.close();
  }
  if (
    !isValidBridgeId(ready.bridge_id) ||
    !isValidSessionToken(ready.session_id) ||
    !isValidSessionToken(ready.session_secret)
  ) {
    throw new Error(
      `unexpected handshake reply shape from ${decoded.baseUrl} — refusing to persist it`,
    );
  }

  saveCredential(io, {
    baseUrl: decoded.baseUrl,
    bridgeId: ready.bridge_id,
    sessionId: ready.session_id,
    // Not currently used to reconnect (routes/agent-bridge.ts's own
    // handshake only checks bridge_id+session_id) — persisted anyway,
    // forward-compat, per that route's own comment on session_secret.
    sessionSecret: ready.session_secret,
  });

  io.stdout.write(
    `paired with ${decoded.baseUrl} — bridge_id ${ready.bridge_id}\n` +
      "run 'mullion helper run' to start forwarding your SSH agent.\n",
  );
  return 0;
}

/**
 * Accepted risk (CodeQL js/file-access-to-http, PR #866 — same posture as
 * routes/agent-bridge.ts's own "Accepted risk" comment, PR #860): this
 * function reads the credential file (loadCredential) and its contents
 * flow into an outbound network request (handshake's `ws.send`) below —
 * exactly the shape that query flags, and exactly the intended behavior
 * of "reconnect using the session token I saved earlier," the same
 * pattern every token-based CLI (kubectl, aws, gh) uses. loadCredential
 * already validates baseUrl/bridgeId/sessionId against the precise shape
 * bridge-registry.ts issues them in before returning non-null (see its
 * own comment) — CodeQL's static analysis doesn't recognize that
 * validation as a sanitizer for this query, but it's real hardening
 * against a corrupted or hand-edited credential file; eliminating the
 * flow entirely would mean removing the reconnect-with-saved-credential
 * feature outright, not narrowing it.
 */
// Issue #873 Phase 3 (Windows headless support) — `sshAuthSock` below is
// handed straight to `net.connect({ path })` a few lines down with no
// platform branch at all, on purpose. Node's own `net` module treats a
// Windows named pipe path (`\\.\pipe\openssh-ssh-agent`, 1Password's own
// Win32-OpenSSH-compatible pipe name) as a first-class IPC endpoint for
// `net.connect`'s `path` option, exactly the same shape as a unix domain
// socket path on macOS/Linux — confirmed against Node's own `net.md` docs,
// which document `path` as accepting "an IPC endpoint (Unix domain socket
// or Windows named pipe)" without qualification. One implementation covers
// all three platforms; see ssh-agent-helper-install.mjs's own Windows
// Scheduled Task generator for the other half of Windows support (the
// supervisor that keeps this process running). Concurrency behavior of
// 1Password's own pipe under many simultaneous opens (the mux's channel-
// per-request shape) is a separate, not-yet-verified question — tracked at
// https://github.com/s3ntin3l8/mullion-session-manager/issues/874.
async function runRun(args, io) {
  const { flags } = extractFlags(args, { "ssh-auth-sock": "string" });
  const sshAuthSock = flags["ssh-auth-sock"] || io.env.SSH_AUTH_SOCK;
  if (!sshAuthSock) {
    io.stderr.write(
      "no SSH_AUTH_SOCK in this process's environment — pass --ssh-auth-sock <path>, or run this " +
        "under a shell that has SSH_AUTH_SOCK set. Note: a launchd/systemd/Scheduled Task job does " +
        "NOT inherit your login shell's SSH_AUTH_SOCK — hardcode the real path there instead (see " +
        "docs/ssh-agent.md).\n",
    );
    return 1;
  }
  const credential = loadCredential(io);
  if (!credential) {
    io.stderr.write(
      "not paired yet — run 'mullion helper pair <payload>' first " +
        "(generate <payload> from Settings -> Hosts -> SSH agent bridges on the primary).\n",
    );
    return 1;
  }

  let stopped = false;
  io.onInterrupt?.(() => {
    stopped = true;
  });

  let attempt = 0;
  while (!stopped) {
    try {
      const ws = new WebSocket(toWsUrl(credential.baseUrl, "/ws/agent-bridge"));
      const ready = await handshake(ws, {
        type: "auth",
        bridge_id: credential.bridgeId,
        session_id: credential.sessionId,
      });
      attempt = 0;
      io.stderr.write(`connected to ${credential.baseUrl} — bridge_id ${ready.bridge_id}\n`);

      const mux = attachInboundMux(ws, {
        onChannel(channel) {
          const socket = net.connect({ path: sshAuthSock });
          // A dial failure (agent app not running, wrong path) must close
          // the CHANNEL, not just the socket — otherwise the ssh client on
          // whatever host opened this channel blocks until its own
          // SSH_AUTH_SOCK-connect timeout instead of failing fast.
          socket.on("error", () => channel.close());
          pipeNetSocketToChannel(socket, channel);
        },
      });
      await new Promise((resolve) => mux.onClose(resolve));
      if (stopped) break;
      io.stderr.write("disconnected — reconnecting...\n");
    } catch (err) {
      if (err instanceof HandshakeRejectedError) {
        io.stderr.write(
          `${err.message} — session no longer valid, re-pair with 'mullion helper pair <payload>'\n`,
        );
        return 1;
      }
      io.stderr.write(`connect failed: ${err.message}\n`);
    }
    if (stopped) break;
    const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
    attempt++;
    await sleep(delay);
  }
  return 0;
}

const VERBS = { pair: runPair, run: runRun, install: runInstall, uninstall: runUninstall };

export async function runHelper(verb, args, io) {
  const target = VERBS[verb];
  if (!target) {
    io.stderr.write(`unknown command: mullion helper ${verb}\n`);
    return 2;
  }
  try {
    return await target(args, io);
  } catch (err) {
    if (err instanceof CliUsageError) {
      io.stderr.write(`${err.message}\n`);
      return 2;
    }
    io.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
