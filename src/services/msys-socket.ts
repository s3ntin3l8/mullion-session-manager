import net from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { SocketAlreadyListeningError, type SocketProbeResult } from "./unix-socket.js";
import { windowsPowerShellEnv } from "../cli/pipe-acl.mjs";
import { fitsMsysSunPath } from "../cli/sun-path.mjs";

// Issue #2131 — a unix socket that Git Bash's own tools can connect to, on
// Windows. Sessions there run in Git Bash, whose `ssh`, `ssh-add` and `git`
// are MSYS builds: they cannot open a named pipe, and MSYS has no real
// AF_UNIX either. It EMULATES one — the same scheme Cygwin has used for
// decades — and this module serves the server side of that emulation:
//
//   - The "socket" is a regular file with the System attribute, holding
//     `!<socket >PORT s XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX`: a TCP port on
//     127.0.0.1 and a 128-bit secret, as four 32-bit words in hex.
//   - A client connects to that port, sends the secret's 16 bytes (each word
//     little-endian), and the server echoes them back. The client then sends
//     its credentials — `{ pid, uid, gid }`, three 32-bit LE ints — and the
//     server answers with its own. Everything after that is the stream.
//
// Measured against Git for Windows' msys-runtime 3.6.3 and OpenSSH 10.0
// (`ssh-add -l`): a file without the System attribute is refused (EBADF),
// and the Windows (`D:\x`, `D:/x`) and MSYS (`/d/x`) spellings of the path
// all work as SSH_AUTH_SOCK. The path must fit MSYS's 108-byte sun_path
// (fitsMsysSunPath, src/cli/sun-path.mjs).
//
// The loopback port is reachable by every local user; the SECRET is the
// gate. So the file is created with a protected DACL — the current user and
// SYSTEM only — in the same call that creates it, never written first and
// narrowed after: a cwd-relative SESSIONS_DIR on a data drive typically
// inherits read access for every authenticated user.

/** How long a client may take to finish the handshake before it is dropped. */
export const MSYS_HANDSHAKE_TIMEOUT_MS = 5_000;

/** Generous: a cold Windows PowerShell start alone can take a second or two. */
export const MSYS_SOCKET_FILE_TIMEOUT_MS = 15_000;

const PROBE_TIMEOUT_MS = 2_000;
const SECRET_BYTES = 16;
const CRED_BYTES = 12;

export const MSYS_SOCKET_PATH_ENV = "MULLION_MSYS_SOCKET_PATH";
export const MSYS_SOCKET_COOKIE_ENV = "MULLION_MSYS_SOCKET_COOKIE";

/** The script's exit code when a file already exists at the path. */
export const MSYS_SOCKET_FILE_EXISTS_EXIT = 3;

/** The most connections that may be in the handshake at once (see listenMsysSocket). */
export const MSYS_MAX_PENDING_HANDSHAKES = 64;

/**
 * The script Windows PowerShell runs to create the socket file. Fixed text:
 * the path and the cookie reach it only through the environment. Only .NET
 * types, for the same reason as pipe-acl.mjs's script. A FileStream opened
 * with a FileSecurity applies the DACL as the file is created, so the secret
 * is never readable by anyone else, not even briefly. CreateNew, never
 * Create: a file that appeared since the caller reclaimed the path belongs to
 * another instance and must not be taken over — that is listen()'s
 * EADDRINUSE here, reported as exit code MSYS_SOCKET_FILE_EXISTS_EXIT.
 */
export const MSYS_SOCKET_FILE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$s = New-Object System.Security.AccessControl.FileSecurity",
  "$s.SetAccessRuleProtection($true, $false)",
  "$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User",
  "$system = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')",
  "foreach ($sid in @($me, $system)) {",
  "  $s.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow)))",
  "}",
  `$p = $env:${MSYS_SOCKET_PATH_ENV}`,
  "try {",
  "  $f = New-Object System.IO.FileStream($p, [System.IO.FileMode]::CreateNew, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.IO.FileShare]::None, 4096, [System.IO.FileOptions]::None, $s)",
  `} catch { if ([System.IO.File]::Exists($p)) { [Console]::Error.WriteLine('exists'); exit ${MSYS_SOCKET_FILE_EXISTS_EXIT} }; throw }`,
  `try { $b = [System.Text.Encoding]::ASCII.GetBytes($env:${MSYS_SOCKET_COOKIE_ENV}); $f.Write($b, 0, $b.Length) } finally { $f.Dispose() }`,
  "[System.IO.File]::SetAttributes($p, [System.IO.FileAttributes]::System)",
].join("\n");

export interface MsysSocketCookie {
  port: number;
  secret: Buffer;
}

/** The socket file's contents for `port` and a 16-byte `secret`. */
export function formatMsysSocketFile(port: number, secret: Buffer): string {
  const words = [0, 1, 2, 3].map((i) =>
    secret
      .readUInt32LE(i * 4)
      .toString(16)
      .toUpperCase()
      .padStart(8, "0"),
  );
  return `!<socket >${port} s ${words.join("-")}`;
}

/** The port and secret in a socket file's contents, or null if it isn't one. */
export function parseMsysSocketFile(text: string): MsysSocketCookie | null {
  const match =
    /^!<socket >(\d+) s ([0-9a-f]{8})-([0-9a-f]{8})-([0-9a-f]{8})-([0-9a-f]{8})\0?$/i.exec(text);
  if (!match) return null;
  const port = Number(match[1]);
  if (port < 1 || port > 65535) return null;
  const secret = Buffer.alloc(SECRET_BYTES);
  for (let i = 0; i < 4; i++) secret.writeUInt32LE(parseInt(match[i + 2], 16), i * 4);
  return { port, secret };
}

export type MsysSocketFileWriter = (socketPath: string, contents: string) => Promise<void>;

/**
 * Creates the socket file through Windows PowerShell (see
 * MSYS_SOCKET_FILE_SCRIPT). Rejects when it could not — without the file, no
 * client can find the socket, so the caller must not serve as if it could —
 * with SocketAlreadyListeningError when another file got there first, so
 * plugins/ssh-agent.ts treats that as the collision it is.
 */
export function writeMsysSocketFile(
  socketPath: string,
  contents: string,
  opts: { execFile?: typeof execFile; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  const run = opts.execFile ?? execFile;
  const env = windowsPowerShellEnv(opts.env, {
    [MSYS_SOCKET_PATH_ENV]: socketPath,
    [MSYS_SOCKET_COOKIE_ENV]: contents,
  });
  return new Promise((resolve, reject) => {
    run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", MSYS_SOCKET_FILE_SCRIPT],
      { timeout: MSYS_SOCKET_FILE_TIMEOUT_MS, windowsHide: true, env },
      (err, _stdout, stderr) => {
        if (!err) return resolve();
        if ((err as { code?: unknown }).code === MSYS_SOCKET_FILE_EXISTS_EXIT) {
          return reject(new SocketAlreadyListeningError(socketPath, "unknown"));
        }
        const detail = String(stderr ?? "").trim() || err.message;
        reject(new Error(`could not create the MSYS socket file ${socketPath}: ${detail}`));
      },
    );
  });
}

/**
 * Whether a live server is behind the socket file at `socketPath`, in
 * probeSocket's terms: "dead" when there is no file, nothing listens on its
 * port, or what listens there does not answer the file's own secret the way
 * an MSYS socket server does (a stale file whose port another program has
 * since taken — ephemeral ports are reused); "live" when it echoes the
 * secret; "unknown" otherwise (an unreadable or foreign file, a timeout).
 * Sending the secret is safe: whoever could use it already read the file.
 */
export async function probeMsysSocket(
  socketPath: string,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<SocketProbeResult> {
  let text: string;
  try {
    text = await readFile(socketPath, "latin1");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "dead" : "unknown";
  }
  const cookie = parseMsysSocketFile(text);
  if (!cookie) return "unknown";
  return new Promise((resolve) => {
    let settled = false;
    let echoed = Buffer.alloc(0);
    const finish = (result: SocketProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      probe.destroy();
      resolve(result);
    };
    const probe = net.createConnection({ host: "127.0.0.1", port: cookie.port });
    const timer = setTimeout(() => finish("unknown"), timeoutMs);
    probe.once("connect", () => probe.write(cookie.secret));
    probe.on("data", (chunk: Buffer) => {
      echoed = Buffer.concat([echoed, chunk]);
      if (echoed.length < SECRET_BYTES) return;
      finish(echoed.subarray(0, SECRET_BYTES).equals(cookie.secret) ? "live" : "dead");
    });
    probe.once("close", () => finish("dead"));
    probe.once("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      finish(code === "ECONNREFUSED" || code === "ECONNRESET" ? "dead" : "unknown");
    });
  });
}

/**
 * reclaimSocketPath (unix-socket.ts) for a socket file: removes a stale one,
 * throws SocketAlreadyListeningError rather than stealing a live one.
 */
export async function reclaimMsysSocket(socketPath: string): Promise<void> {
  const result = await probeMsysSocket(socketPath);
  if (result !== "dead") throw new SocketAlreadyListeningError(socketPath, result);
  try {
    await unlink(socketPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * Runs the server half of the handshake on an accepted connection, then calls
 * `onReady`. The handshake reads exactly its own bytes in paused mode
 * (`read(n)`), so whatever the client sent past it stays buffered, and the
 * stream starts flowing only once `onReady`'s consumer attaches its own
 * `data` listener — however much later that is. Destroys the socket on a
 * wrong secret, an early close or a timeout.
 */
export function acceptMsysHandshake(
  socket: net.Socket,
  secret: Buffer,
  onReady: (socket: net.Socket) => void,
  timeoutMs = MSYS_HANDSHAKE_TIMEOUT_MS,
): void {
  let stage: "secret" | "cred" = "secret";
  const timer = setTimeout(() => socket.destroy(), timeoutMs);
  timer.unref?.();
  const done = () => {
    clearTimeout(timer);
    socket.removeListener("readable", onReadable);
    socket.removeListener("close", onClose);
  };
  const onClose = () => done();
  const onReadable = () => {
    if (stage === "secret") {
      const offered = socket.read(SECRET_BYTES) as Buffer | null;
      if (offered === null) return;
      if (offered.length !== SECRET_BYTES || !timingSafeEqual(offered, secret)) {
        done();
        socket.destroy();
        return;
      }
      socket.write(secret);
      stage = "cred";
    }
    const theirs = socket.read(CRED_BYTES) as Buffer | null;
    if (theirs === null) return;
    if (theirs.length !== CRED_BYTES) {
      done();
      socket.destroy();
      return;
    }
    // Our credentials: this process's pid, and the client's own uid/gid — on
    // Windows both ends are the same user, and MSYS only records the values.
    const ours = Buffer.alloc(CRED_BYTES);
    ours.writeInt32LE(process.pid, 0);
    theirs.copy(ours, 4, 4, CRED_BYTES);
    socket.write(ours);
    done();
    onReady(socket);
  };
  socket.on("readable", onReadable);
  socket.once("close", onClose);
  socket.on("error", () => socket.destroy());
}

export interface MsysSocketServerOptions {
  socketPath: string;
  /** Called with each connection that completed the handshake. */
  onConnection: (socket: net.Socket) => void;
  /** Creates the socket file — writeMsysSocketFile unless a test injects one. */
  writeSocketFile?: MsysSocketFileWriter;
  handshakeTimeoutMs?: number;
  /** Defaults to MSYS_MAX_PENDING_HANDSHAKES. */
  maxPendingHandshakes?: number;
}

export interface MsysSocketServer {
  readonly port: number;
  /** Stops listening and removes the socket file. Open connections are the caller's. */
  close(): Promise<void>;
}

/** Unlinks `socketPath` if it holds no valid cookie, or exactly ours. */
async function removeIfOurs(socketPath: string, port: number, secret: Buffer): Promise<void> {
  let text: string;
  try {
    text = await readFile(socketPath, "latin1");
  } catch {
    return;
  }
  const cookie = parseMsysSocketFile(text);
  if (cookie && !(cookie.port === port && cookie.secret.equals(secret))) return;
  await unlink(socketPath).catch(() => undefined);
}

/**
 * Listens on a fresh loopback port and publishes it as an MSYS socket file at
 * `socketPath`. Reclaim the path first (reclaimMsysSocket); this does not.
 */
export async function listenMsysSocket(opts: MsysSocketServerOptions): Promise<MsysSocketServer> {
  if (!fitsMsysSunPath(opts.socketPath)) {
    throw new Error(`${opts.socketPath} is too long for an MSYS socket path (see fitsMsysSunPath)`);
  }
  const secret = randomBytes(SECRET_BYTES);
  // Connections still in the handshake belong to no caller yet; close() ends them.
  const handshaking = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    // Any local user can reach the port, and a connection holds a slot until
    // its handshake times out — so the unauthenticated ones are capped too.
    if (handshaking.size >= (opts.maxPendingHandshakes ?? MSYS_MAX_PENDING_HANDSHAKES)) {
      socket.destroy();
      return;
    }
    handshaking.add(socket);
    socket.once("close", () => handshaking.delete(socket));
    acceptMsysHandshake(
      socket,
      secret,
      (ready) => {
        handshaking.delete(ready);
        opts.onConnection(ready);
      },
      opts.handshakeTimeoutMs,
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const port = (server.address() as net.AddressInfo).port;
  const write = opts.writeSocketFile ?? ((p, c) => writeMsysSocketFile(p, c));
  try {
    await write(opts.socketPath, formatMsysSocketFile(port, secret));
  } catch (err) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // A write that failed after CreateNew made the file (a full disk, the
    // timeout killing PowerShell) leaves one with no readable cookie, which
    // probeMsysSocket can only call "unknown" — so reclaim would refuse it on
    // every later boot. Remove it — but only when it is ours: empty or
    // unparsable (our half-written one), or our own complete cookie. A write
    // that failed before creating anything (no powershell.exe, a collision)
    // may find another instance's file there, and that one is left alone.
    if (!(err instanceof SocketAlreadyListeningError)) {
      await removeIfOurs(opts.socketPath, port, secret);
    }
    throw err;
  }
  return {
    port,
    close: async () => {
      for (const socket of handshaking) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(opts.socketPath).catch(() => undefined);
    },
  };
}
