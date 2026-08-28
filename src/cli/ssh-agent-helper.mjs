// Issue #820 (PR6) — `mullion helper`, the laptop-side reference client for
// the SSH-agent bridge (docs/ssh-agent.md). Runs on a machine with no
// Mullion checkout and typically no local Mullion server at all, so unlike
// every OTHER `mullion` subcommand it never touches the control socket
// (src/cli/mullion.mjs dispatches it before constructing a
// MullionSocketClient, the same way it already does for `mullion mcp`).
// Two verbs:
//   - `pair <payload>` — one-shot. Decodes the payload Settings generated
//     (ssh-agent-bridge-pairing.mjs), redeems it against POST /api/bridges'
//     pairing code over /ws/agent-bridge, and persists the resulting
//     session credential.
//   - `run` — long-running. Re-authenticates with the persisted credential,
//     wraps the connection in the inbound-only mux (ssh-agent-bridge-mux.mjs),
//     and for every channel the primary opens, dials this laptop's own real
//     SSH_AUTH_SOCK and pipes the two together.
//
// Service-manager installers (`mullion helper install` — launchd plist /
// systemd --user unit / Windows Scheduled Task) are a separate PR (#6b):
// this file only needs a foreground process that can be supervised by one,
// not the supervisor itself.

import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decodePairingPayload } from "./ssh-agent-bridge-pairing.mjs";
import { attachInboundMux, pipeNetSocketToChannel } from "./ssh-agent-bridge-mux.mjs";
import { extractFlags, CliUsageError } from "./core.mjs";

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
    const connectTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ws.close();
      reject(new Error(`timed out connecting within ${CONNECT_TIMEOUT_MS}ms`));
    }, CONNECT_TIMEOUT_MS);

    ws.addEventListener(
      "open",
      () => {
        clearTimeout(connectTimer);
        ws.send(JSON.stringify(message));
        const replyTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          ws.close();
          reject(new Error(`no handshake reply within ${HANDSHAKE_TIMEOUT_MS}ms`));
        }, HANDSHAKE_TIMEOUT_MS);

        ws.addEventListener(
          "message",
          (event) => {
            clearTimeout(replyTimer);
            if (settled) return;
            settled = true;
            let parsed;
            try {
              parsed = JSON.parse(typeof event.data === "string" ? event.data : "");
            } catch {
              reject(new Error("malformed handshake reply"));
              return;
            }
            if (parsed?.type === "error") {
              reject(new HandshakeRejectedError(parsed.message || "handshake rejected"));
              return;
            }
            if (parsed?.type !== "ready") {
              reject(new Error(`unexpected handshake reply: ${JSON.stringify(parsed)}`));
              return;
            }
            resolve(parsed);
          },
          { once: true },
        );
      },
      { once: true },
    );

    ws.addEventListener(
      "error",
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        reject(new Error("connection error"));
      },
      { once: true },
    );
    ws.addEventListener(
      "close",
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        reject(new Error("connection closed before completing handshake"));
      },
      { once: true },
    );
  });
}

function stateDir(io) {
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
function loadCredential(io) {
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
    typeof baseUrl !== "string" ||
    typeof bridgeId !== "string" ||
    typeof sessionId !== "string"
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
      "invalid pairing payload — paste it exactly as shown in Settings -> SSH agent bridge",
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

async function runRun(args, io) {
  const { flags } = extractFlags(args, { "ssh-auth-sock": "string" });
  const sshAuthSock = flags["ssh-auth-sock"] || io.env.SSH_AUTH_SOCK;
  if (!sshAuthSock) {
    io.stderr.write(
      "no SSH_AUTH_SOCK in this process's environment — pass --ssh-auth-sock <path>, or run this " +
        "under a shell that has SSH_AUTH_SOCK set. Note: a launchd/systemd unit does NOT inherit " +
        "your login shell's SSH_AUTH_SOCK — hardcode the real path there instead (see docs/ssh-agent.md).\n",
    );
    return 1;
  }
  const credential = loadCredential(io);
  if (!credential) {
    io.stderr.write(
      "not paired yet — run 'mullion helper pair <payload>' first " +
        "(generate <payload> from Settings -> SSH agent bridge on the primary).\n",
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

const VERBS = { pair: runPair, run: runRun };

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
