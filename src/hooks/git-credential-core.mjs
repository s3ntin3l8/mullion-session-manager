// Pure core of the session-side GitHub credential helper and `gh` wrapper
// (issue #2246) — no process.* access, so the parsing, the reply handling and
// the socket round trip are unit-testable. The scripts around it
// (git-credential-mullion.mjs, bin/gh) are thin shells over these.
//
// Plain JavaScript like its siblings: it is spawned by git / a shell inside a
// session, not imported by the server (see forwarder.mjs's header for why).

import net from "node:net";

/** Bounded like forwarder.mjs's SESSION_START_TIMEOUT_MS: the reply is an
 * in-memory lookup on the host's own Mullion, no human involved. */
export const TOKEN_REQUEST_TIMEOUT_MS = 5_000;

/** git's credential protocol: `key=value` lines, a blank line ends the input. */
export function parseCredentialInput(text) {
  const fields = {};
  for (const line of text.split("\n")) {
    if (line === "") break;
    const eq = line.indexOf("=");
    if (eq > 0) fields[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return fields;
}

/** Only github.com is Mullion's to answer for; every other host falls through
 * to the next helper (an empty answer, not an error). */
export function isGithubHost(host) {
  const bare = (host ?? "").toLowerCase().replace(/:\d+$/, "");
  return bare === "github.com" || bare === "www.github.com";
}

/** What `git credential get` should print for `reply`, or "" for nothing. */
export function formatCredentialOutput(fields, reply) {
  if (fields.protocol !== "https" || !isGithubHost(fields.host) || !reply?.token) return "";
  return `username=${reply.username || "x-access-token"}\npassword=${reply.token}\n`;
}

/** Asks the host's Mullion for this session's GitHub token over the session's
 * own hook socket. Never rejects and never hangs: resolves to the reply
 * (`{token, username, hostFirst}` or `{error}`), or an `{error}` of its own. */
export function requestGithubToken(socketPath, hookToken, timeoutMs = TOKEN_REQUEST_TIMEOUT_MS) {
  return new Promise((resolve) => {
    if (!socketPath || !hookToken) {
      resolve({ error: "not running inside a Mullion session (no hook socket)" });
      return;
    }
    let settled = false;
    let socket;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish({ error: "Mullion did not answer in time" }), timeoutMs);
    try {
      socket = net.createConnection(socketPath);
    } catch (err) {
      finish({ error: `cannot reach Mullion: ${err.message}` });
      return;
    }
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        finish(JSON.parse(buffer.slice(0, newline)));
      } catch {
        finish({ error: "unreadable reply from Mullion" });
      }
    });
    socket.on("error", (err) => finish({ error: `cannot reach Mullion: ${err.message}` }));
    socket.on("close", () => finish({ error: "Mullion closed the connection" }));
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ token: hookToken })}\n`);
      socket.write(`${JSON.stringify({ kind: "github_token" })}\n`);
    });
  });
}

/** The credential-helper entry point: `get` answers, `store`/`erase` are
 * ignored (Mullion owns the token, git must not persist or clear it).
 * Returns `{stdout, stderr, code}` for the caller to emit. */
export async function runCredentialHelper(action, stdinText, env, request = requestGithubToken) {
  if (action !== "get") return { stdout: "", stderr: "", code: 0 };
  const fields = parseCredentialInput(stdinText);
  if (fields.protocol !== "https" || !isGithubHost(fields.host)) {
    return { stdout: "", stderr: "", code: 0 };
  }
  const reply = await request(env.MULLION_HOOK_SOCKET, env.MULLION_HOOK_TOKEN);
  if (!reply?.token) {
    // Say what to do, once, and give git an empty answer: with no username it
    // cannot prompt on a tty-less helper chain, and it fails instead of
    // hanging.
    return {
      stdout: "",
      stderr: `mullion: ${reply?.error ?? "no GitHub token available"}\n`,
      code: 1,
    };
  }
  return { stdout: formatCredentialOutput(fields, reply), stderr: "", code: 0 };
}

/** `gh-token` mode, used by the `gh` wrapper. One line on stdout, easy for a
 * POSIX shell to split: `ok <hostFirst> <token>` or `err <hostFirst> <message>`
 * (`hostFirst` is true|false; false when Mullion could not be reached). Always
 * exit 0 — the line is the result, so the wrapper needs no stderr plumbing. */
export async function runGhToken(env, request = requestGithubToken) {
  const reply = await request(env.MULLION_HOOK_SOCKET, env.MULLION_HOOK_TOKEN);
  const hostFirst = reply?.hostFirst === true;
  if (!reply?.token) {
    const message = String(reply?.error ?? "no GitHub token available").replace(/\s+/g, " ");
    return { stdout: `err ${hostFirst} ${message}\n`, stderr: "", code: 0 };
  }
  return { stdout: `ok ${hostFirst} ${reply.token}\n`, stderr: "", code: 0 };
}
