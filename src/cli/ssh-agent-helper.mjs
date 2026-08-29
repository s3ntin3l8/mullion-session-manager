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
import { attachInboundMux } from "./ssh-agent-bridge-mux.mjs";
import { pipeFilteredNetSocketToChannel } from "./ssh-agent-filtered-relay.mjs";
import { extractFlags, CliUsageError } from "./core.mjs";
import { runInstall, runUninstall } from "./ssh-agent-helper-install.mjs";

// Round 3 (PR2) — the `io` object every `runHelper` verb actually touches:
// stdout/stderr for output, env for reading SSH_AUTH_SOCK/MULLION_HELPER_
// STATE_DIR/etc., onInterrupt for the SIGINT/SIGTERM handling `run`'s
// reconnect loop wires up. Everything else `runInstall`/`runUninstall`
// read off `io` (platform, homedir, execPath, scriptPath, isSea, uid,
// spawnSync, statSync) is an optional test-injection seam that already
// defaults via `??`/`??`-shaped fallbacks to the real process/os/node:sea
// values when absent — nothing here needs to set them explicitly. Shared
// by src/cli/mullion.mjs's own `helper` dispatch and
// src/cli/helper-main.mjs (the Node SEA entry point), so the two can't
// independently drift on what a "real" helper environment looks like.
export function buildHelperIo() {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    onInterrupt: (cb) => {
      process.once("SIGINT", cb);
      process.once("SIGTERM", cb);
    },
  };
}

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

// Round 3 (session renewal) — POST /api/bridges/renew (routes/agent-
// bridge.ts), called on its own schedule, independent of the WS connect/
// reconnect loop below (see runRun's own comment on why the two are kept
// separate). Fraction and retry ladder mirror
// src/plugins/agent-enrollment.ts's scheduleRenewal()/renew(): ~50% of TTL
// before the deadline, retried on failure rather than given up on — a
// bridge session has no bootstrap credential to fall back to the way an
// agent host's MULLION_AGENT_TOKEN does (bridge-registry.ts's own comment
// on rotateBridgeSession), so a transient renewal failure must keep trying
// rather than surface as a fatal error.
const RENEW_AT_FRACTION = 0.5;
const RENEW_TIMEOUT_MS = 10_000;
const RENEW_RETRY_DELAYS_MS = [5000, 15000, 60000, 300000];

// Round 3 (PR2) — 1Password's own Win32-OpenSSH-compatible named pipe name.
// Exported (not local to runRun below) because ssh-agent-helper-install.mjs
// needs the identical default for `install`'s own --ssh-auth-sock
// resolution — a bare `\\.\pipe\openssh-ssh-agent` there and a different
// literal here would silently diverge the moment either one gets edited.
// Empirically confirmed to accept the mux's concurrent-channel shape (8 and
// 16 simultaneous connections, each a correct independent round trip) —
// issue #874.
export const WINDOWS_DEFAULT_SSH_AUTH_SOCK = "\\\\.\\pipe\\openssh-ssh-agent";

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

// Round 3 (session renewal) — baseUrl is already validated http(s) by
// loadCredential/isValidHttpBaseUrl below, so this is a plain path join,
// symmetric with toWsUrl above but without the protocol rewrite.
function toHttpUrl(baseUrl, urlPath) {
  return new URL(urlPath, baseUrl).toString();
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
//
// Round 3 (session renewal) adds two more instances of these SAME two
// flows, not new ones: renewSession's own fetch() call sends
// credential.bridgeId/sessionId (loaded from disk, or persisted from an
// earlier successful handshake) in an outbound request — the js/file-
// access-to-http shape, identical reasoning to runRun's handshake below —
// and saveCredential's own writeFileSync is now also reached from
// renewSession's rotated session_id/expires_at and runRun's synced
// ready.expires_at, both validated with the SAME isValidSessionToken/
// isValidExpiresAt gates before ever reaching this function — the js/
// http-to-file-access shape, identical reasoning to runPair's call below.
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

// Round 3 (session renewal) — `expiresAt` is a new credential-file field;
// `undefined` is explicitly valid here (not just "falls through to
// false"), so a credential file written before this round still loads
// instead of being treated as corrupt. runRun's own renewal scheduler
// reads a missing value as "renew immediately" (see scheduleRenewal).
function isValidExpiresAt(value) {
  if (value === undefined) return true;
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

// Round 3 (PR2, Windows SEA) — `io.platform`/`io.homedir` overrides follow
// the same injected-seam convention ssh-agent-helper-install.mjs's own
// header comment documents (`io.spawnSync`/`io.execPath`/`io.scriptPath`/
// `io.uid`), so the win32 branch below is unit-testable from this
// Linux-only dev/CI environment without actually running on Windows.
//
// No compat read of the OLD (Unix-shaped) path on win32: `resolveSshAuthSock`
// (ssh-agent-helper-install.mjs) has thrown unconditionally on win32 since
// the day this file shipped — Windows had no way to supply an
// `--ssh-auth-sock` value the old code would accept — so `mullion helper
// install` has never once succeeded there, and no bridge has ever paired
// from a Windows helper either (`select count(*) from bridges` was 0 in
// production as of this PR). There is no pre-existing state at the old
// path on any real Windows machine to migrate, so the branch below is
// unconditional rather than defensive.
export function stateDir(io) {
  if (io.env.MULLION_HELPER_STATE_DIR) return io.env.MULLION_HELPER_STATE_DIR;
  const platform = io.platform ?? process.platform;
  const home = io.homedir ?? os.homedir();
  if (platform === "win32") {
    const base = io.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    return path.join(base, "Mullion");
  }
  const base = io.env.XDG_STATE_HOME || path.join(home, ".local", "state");
  return path.join(base, "mullion");
}

// Exported for ssh-agent-helper-install.mjs's runUninstall, which needs to
// name this exact file to delete it — the filename is a fact this module
// owns; the install module must never re-derive
// path.join(stateDir(io), "ssh-agent-bridge.json") itself (issue #904).
export function credentialPath(io) {
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
  const { baseUrl, bridgeId, sessionId, expiresAt } = parsed ?? {};
  if (
    !isValidHttpBaseUrl(baseUrl) ||
    !isValidBridgeId(bridgeId) ||
    !isValidSessionToken(sessionId) ||
    !isValidExpiresAt(expiresAt)
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
// Round 3 (session renewal) — write-to-temp-then-rename, not a direct
// writeFileSync, now that this runs on every rotation (~every 12h) rather
// than once at `pair` time: a process killed mid-write (power loss, OOM
// kill) between those two calls used to risk a truncated/corrupt credential
// file at pair-time odds low enough to accept; at a recurring 12h cadence
// for the life of a long-running `run`, the same risk compounds enough to
// be worth the two extra syscalls. `fs.renameSync` within the SAME
// directory is atomic on every platform this ships for (POSIX rename(2);
// Windows MoveFileExW with MOVEFILE_REPLACE_EXISTING for a same-volume
// rename) — a reader (this same process's own next
// loadCredential, or a human `cat`-ing the file) always sees either the
// old, fully-written credential or the new one, never a partial write.
function saveCredential(io, credential) {
  const dir = stateDir(io);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = credentialPath(io);
  const tmpFile = `${file}.${process.pid}.tmp`;
  try {
    // CodeQL js/http-to-file-access — see the "Accepted risk" comment near
    // loadCredential above; every caller (runPair, runRun, renewSession)
    // validates the server-derived fields it passes here first.
    fs.writeFileSync(tmpFile, `${JSON.stringify(credential, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(tmpFile, 0o600);
    fs.renameSync(tmpFile, file);
  } catch (err) {
    // Best-effort cleanup so a write/rename failure (disk full, permission
    // denied) doesn't leave a stray, harmless-but-confusing
    // ssh-agent-bridge.json.<pid>.tmp behind for a human to later wonder
    // about — loadCredential never reads it (fixed filename), so leaving
    // it isn't a correctness issue, just clutter worth cleaning up when we
    // can.
    fs.rmSync(tmpFile, { force: true });
    throw err;
  }
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
    !isValidExpiresAt(ready.expires_at) ||
    ready.expires_at === undefined
  ) {
    throw new Error(
      `unexpected handshake reply shape from ${decoded.baseUrl} — refusing to persist it`,
    );
  }

  saveCredential(io, {
    baseUrl: decoded.baseUrl,
    bridgeId: ready.bridge_id,
    sessionId: ready.session_id,
    // Round 3 (session renewal) — drives runRun's own proactive-renewal
    // timer. session_secret is deliberately no longer part of this reply
    // (routes/agent-bridge.ts) or persisted here — it was never used to
    // reconnect or renew (both authenticate on session_id alone) and had
    // become a standing trap for a later PR to wire up "meaningfully."
    expiresAt: ready.expires_at,
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
// per-request shape) is confirmed working — issue #874, 8 and 16
// simultaneous connections each round-tripped correctly.
async function runRun(args, io) {
  const { flags } = extractFlags(args, { "ssh-auth-sock": "string", "json-events": "boolean" });
  // Round 4 (issue #820, tray-repo prerequisites) — a tray needs something
  // more reliable than regex-matching the stderr prose below, which has
  // already been reworded three times across PR1/PR2/PR3. NDJSON on
  // stdout, a stream `run` has never written anything to before now (only
  // `pair` does) — the existing stderr prose is UNCHANGED, so any
  // supervisor/log-watcher already parsing it keeps working exactly as
  // today. See docs/ssh-agent.md for the documented event shapes.
  const jsonEvents = flags["json-events"] === true;
  function emitEvent(type, data = {}) {
    if (!jsonEvents) return;
    io.stdout.write(`${JSON.stringify({ type, ...data })}\n`);
  }
  const platform = io.platform ?? process.platform;
  // Round 3 (PR2) — same default (and same reasoning: no per-machine
  // equivalent exists on macOS/Linux, so this stays win32-only) as
  // ssh-agent-helper-install.mjs's own resolveSshAuthSock. Distinct code
  // path, not a shared function, because this one has no `platform`
  // parameter threaded through today and adding one purely to dedupe a
  // three-line fallback chain isn't worth the API churn — but the LITERAL
  // default (WINDOWS_DEFAULT_SSH_AUTH_SOCK) is shared, so the two can't
  // independently drift on the actual pipe name.
  const sshAuthSock =
    flags["ssh-auth-sock"] ||
    io.env.SSH_AUTH_SOCK ||
    (platform === "win32" ? WINDOWS_DEFAULT_SSH_AUTH_SOCK : undefined);
  if (!sshAuthSock) {
    io.stderr.write(
      "no SSH_AUTH_SOCK in this process's environment — pass --ssh-auth-sock <path>, or run this " +
        "under a shell that has SSH_AUTH_SOCK set. Note: a launchd/systemd/Scheduled Task job does " +
        "NOT inherit your login shell's SSH_AUTH_SOCK — hardcode the real path there instead (see " +
        "docs/ssh-agent.md).\n",
    );
    return 1;
  }
  let credential = loadCredential(io);
  if (!credential) {
    io.stderr.write(
      "not paired yet — run 'mullion helper pair <payload>' first " +
        "(generate <payload> from Settings -> Hosts -> SSH agent bridges on the primary).\n",
    );
    return 1;
  }

  let stopped = false;
  let renewTimer = null;
  // Tracks whichever WebSocket the connect loop below currently has open
  // (or is mid-handshake on) — renewSession's rejection branch uses this to
  // force a prompt shutdown (see there for why a rejected renewal can't
  // just wait for the connection to drop on its own).
  let activeWs = null;
  // Set only by a REJECTED renewal (routes/agent-bridge.ts's 401) — as
  // opposed to a network-level renewal failure, which just retries (see
  // renewSession below). Distinguishes "the credential is genuinely dead,
  // exit 1" from "still connected fine, keep going" at the very end of this
  // function, the same HandshakeRejectedError-vs-plain-Error split the
  // connect loop below already makes for the WS handshake.
  let renewalRejected = false;
  io.onInterrupt?.(() => {
    stopped = true;
    if (renewTimer) clearTimeout(renewTimer);
    // Same reasoning as the renewal-rejection branch below: `stopped` alone
    // doesn't unblock a loop iteration currently parked on
    // `await new Promise((resolve) => mux.onClose(resolve))` — nothing else
    // was going to close this connection on its own. Pre-existing gap
    // (SIGINT/SIGTERM while connected previously just hung), fixed here
    // since `activeWs` now exists for the identical purpose.
    activeWs?.close();
  });

  // Round 3 (session renewal) — deliberately its own timer loop, independent
  // of the WS connect/reconnect loop below: renewing never tears down or
  // waits on the live connection, so a session in the middle of forwarding
  // real traffic is never disrupted by its own credential's upkeep. Mirrors
  // src/plugins/agent-enrollment.ts's scheduleRenewal()/renew() shape.
  //
  // That independence has one sharp edge (self-review, round 3): if the
  // live WS drops for a completely unrelated reason (network blip, laptop
  // sleep) while a renewal is ALSO in flight, the reconnect loop below can
  // send an "auth" carrying the OLD session id at the exact moment this
  // renewal rotates it server-side — the server correctly rejects that
  // stale id, but the credential itself was never actually invalid, just
  // momentarily out of date. `renewalPromise` lets the reconnect loop's
  // rejection handler wait for any in-flight renewal to settle (so a
  // rotation that's about to succeed isn't raced) before deciding whether
  // a HandshakeRejectedError reflects a genuinely dead credential.
  let renewAttempt = 0;
  let renewalPromise = null;

  function scheduleRenewal() {
    if (renewTimer) clearTimeout(renewTimer);
    if (stopped) return;
    if (!credential.expiresAt) {
      // Defensive only — by the time this is first called (right after a
      // successful "auth", which always carries expires_at per routes/
      // agent-bridge.ts) there should always be a value. Renew right away
      // rather than guess a TTL if this is somehow reached anyway.
      renewTimer = setTimeout(() => void startRenewal(), 0);
      return;
    }
    const ttlMs = new Date(credential.expiresAt).getTime() - Date.now();
    // Floored, same reasoning as agent-enrollment.ts's own scheduleRenewal:
    // a clock skew or an already-near-expiry credential (e.g. right after
    // loading an old file) must not produce a negative/near-zero delay that
    // busy-loops.
    const renewInMs = Math.max(ttlMs * RENEW_AT_FRACTION, 1_000);
    renewTimer = setTimeout(() => void startRenewal(), renewInMs);
  }

  // renewSession() never throws (its own try/catch handles every failure
  // internally, see below) — this wrapper's only job is publishing the
  // in-flight promise to `renewalPromise` for the reconnect loop to await,
  // and clearing it once settled.
  function startRenewal() {
    const p = renewSession();
    renewalPromise = p;
    void p.finally(() => {
      if (renewalPromise === p) renewalPromise = null;
    });
  }

  async function renewSession() {
    if (stopped) return;
    const current = credential;
    try {
      // CodeQL js/file-access-to-http — see the "Accepted risk" comment
      // near loadCredential above; same shape, same reasoning as runRun's
      // own handshake call below.
      const res = await fetch(toHttpUrl(current.baseUrl, "/api/bridges/renew"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bridge_id: current.bridgeId, session_id: current.sessionId }),
        signal: AbortSignal.timeout(RENEW_TIMEOUT_MS),
      });
      if (stopped) return;
      if (res.status === 401) {
        renewalRejected = true;
        stopped = true;
        io.stderr.write(
          "session renewal rejected — session no longer valid, re-pair with " +
            "'mullion helper pair <payload>'\n",
        );
        emitEvent("renewal_rejected");
        // The renewal endpoint rejecting the credential doesn't itself
        // touch the live WS — force it closed rather than silently leaving
        // `run` connected-but-doomed until the connection happens to drop
        // on its own for an unrelated reason (see `activeWs`'s own comment
        // above for why this can't just wait).
        activeWs?.close();
        return;
      }
      if (!res.ok) throw new Error(`renewal request failed: HTTP ${res.status}`);
      const json = await res.json();
      if (!isValidSessionToken(json.session_id) || !isValidExpiresAt(json.expires_at)) {
        throw new Error("unexpected renewal reply shape — refusing to persist it");
      }
      credential = { ...current, sessionId: json.session_id, expiresAt: json.expires_at };
      saveCredential(io, credential);
      renewAttempt = 0;
      io.stderr.write(`session renewed — valid until ${json.expires_at}\n`);
      emitEvent("session_renewed", { expires_at: json.expires_at });
      scheduleRenewal();
    } catch (err) {
      if (stopped) return;
      // Network-level failure (primary unreachable, timeout, malformed
      // reply) — retry rather than give up. Unlike agent-enrollment.ts's
      // renew(), there's no bootstrap credential to fall back to
      // (bridge-registry.ts's own comment on rotateBridgeSession), so
      // retrying with the SAME still-valid session id is the only option,
      // and there's normally hours of TTL left at 50% to retry within.
      const delay = RENEW_RETRY_DELAYS_MS[Math.min(renewAttempt, RENEW_RETRY_DELAYS_MS.length - 1)];
      renewAttempt++;
      io.stderr.write(`session renewal attempt failed (${err.message}) — retrying in ${delay}ms\n`);
      emitEvent("renewal_retry", { delay_ms: delay });
      renewTimer = setTimeout(() => void renewSession(), delay);
    }
  }

  // Armed once, after the FIRST successful handshake below — not up front.
  // Arming it here, before any connection exists, would race a legacy
  // credential's missing expiresAt (which schedules an immediate renewal)
  // against the very first "auth" handshake: if the renewal wins that race,
  // it rotates the session id the in-flight handshake is still presenting,
  // and that handshake fails with HandshakeRejectedError over a credential
  // that was never actually invalid — just momentarily stale. Once armed
  // from an authoritative post-handshake expires_at, renewSession's own
  // re-arm-on-success (above) keeps it running on its own schedule,
  // independent of whatever the connect loop below does afterward.
  let renewalArmed = false;

  let attempt = 0;
  while (!stopped) {
    // Captured up front so the rejection handler below can tell whether a
    // HandshakeRejectedError reflects THIS id genuinely being dead, or
    // whether a concurrent renewal already moved credential.sessionId on
    // from under it (see renewalPromise's own comment above).
    const presentedSessionId = credential.sessionId;
    try {
      const ws = new WebSocket(toWsUrl(credential.baseUrl, "/ws/agent-bridge"));
      activeWs = ws;
      const ready = await handshake(ws, {
        type: "auth",
        bridge_id: credential.bridgeId,
        session_id: presentedSessionId,
      });
      attempt = 0;
      io.stderr.write(`connected to ${credential.baseUrl} — bridge_id ${ready.bridge_id}\n`);
      emitEvent("connected", { bridge_id: ready.bridge_id, base_url: credential.baseUrl });

      // ready.expires_at is always present on a successful "auth" (routes/
      // agent-bridge.ts) — sync it in case it drifted from what's on disk
      // (e.g. this file was copied from a machine paired earlier), and use
      // it as the one-time seed for the renewal timer below.
      if (ready.expires_at && ready.expires_at !== credential.expiresAt) {
        credential = { ...credential, expiresAt: ready.expires_at };
        saveCredential(io, credential);
      }
      if (!renewalArmed) {
        renewalArmed = true;
        scheduleRenewal();
      }

      const mux = attachInboundMux(ws, {
        onChannel(channel) {
          const socket = net.connect({ path: sshAuthSock });
          // A dial failure (agent app not running, wrong path) must close
          // the CHANNEL, not just the socket — otherwise the ssh client on
          // whatever host opened this channel blocks until its own
          // SSH_AUTH_SOCK-connect timeout instead of failing fast.
          socket.on("error", () => channel.close());
          // Round 4 (issue #820) — filtered, not the raw pipeNetSocketToChannel:
          // this is the authoritative sign-only enforcement point
          // (ssh-agent-filter.mjs's own header comment) between the primary
          // and the real local agent. Requests are classified; only
          // REQUEST_IDENTITIES/SIGN_REQUEST ever reach `socket`. Replies are
          // relayed unmodified, same as before.
          pipeFilteredNetSocketToChannel(socket, channel);
        },
      });
      await new Promise((resolve) => mux.onClose(resolve));
      if (stopped) break;
      io.stderr.write("disconnected — reconnecting...\n");
      emitEvent("disconnected");
    } catch (err) {
      if (err instanceof HandshakeRejectedError) {
        // A renewal that was in flight when this rejection arrived might be
        // ABOUT to (or might just have) rotated the very id this attempt
        // presented — wait for it to settle (it never throws) before
        // trusting this rejection at all.
        if (renewalPromise) await renewalPromise;
        if (credential.sessionId !== presentedSessionId) {
          // Stale rejection: a concurrent renewal already moved past the id
          // this attempt presented. The credential is fine — retry below
          // with whatever credential.sessionId is now, rather than treating
          // an artifact of the race as proof the session is dead.
          io.stderr.write(
            "auth rejected using a session id superseded by a concurrent renewal — retrying\n",
          );
        } else {
          io.stderr.write(
            `${err.message} — session no longer valid, re-pair with 'mullion helper pair <payload>'\n`,
          );
          emitEvent("dead_credential", { message: err.message });
          clearTimeout(renewTimer);
          return 1;
        }
      } else {
        io.stderr.write(`connect failed: ${err.message}\n`);
        emitEvent("connect_failed", { message: err.message });
      }
    }
    if (stopped) break;
    const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
    attempt++;
    await sleep(delay);
  }
  clearTimeout(renewTimer);
  return renewalRejected ? 1 : 0;
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
