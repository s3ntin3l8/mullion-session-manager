// OpenCode hook plugin (issue #175) — OpenCode has no shell-command hooks
// (unlike Claude Code/Codex/agy), only a JS/TS plugin API, so it can't reuse
// forwarder.mjs. This is that agent's own bridge to the same hook socket
// protocol, auto-injected per session (see hook-adapters/opencode.ts) via
// OPENCODE_CONFIG_DIR pointing at an ephemeral per-session directory — never
// a write to the user's real ~/.config/opencode or a project's .opencode/.
//
// Deliberately plain JavaScript, not TypeScript, for the same reason
// forwarder.mjs is: this file is copied byte-for-byte into that ephemeral
// directory and loaded directly by OpenCode's OWN plugin loader/runtime, not
// imported by Mullion's server process — it must run unmodified whether
// Mullion itself is under `tsx watch` (dev) or the compiled `dist/` build,
// with no tsc step of its own (see package.json's build script, which copies
// the whole src/hooks/ directory verbatim).
//
// Only `session.idle` and `file.edited` are forwarded — both non-blocking,
// informational events. OpenCode's actual gating hook is `permission.ask`
// (mutating `output.status`), NOT `tool.execute.before` throwing as
// originally assumed during planning — confirmed against the installed
// `@opencode-ai/plugin` package's own type definitions. That hook is
// deliberately NOT wired up here: there is no endpoint yet to answer a real
// gate decision (issue #178), and wiring a blocking permission hook with
// nothing to resolve it would hang every gated action instead of just not
// being there — same reasoning as Claude Code's deferred PreToolUse
// (see hook-adapters/claude-code.ts).

import net from "node:net";

/** Maps one OpenCode plugin `event` payload to a hook-protocol message, or
 * `null` if this event type isn't forwarded (yet, or ever). Pure — no I/O —
 * so it's unit-tested directly by importing this file, via the
 * `MullionHookEmitter.mapOpenCodeEvent` property below rather than its own
 * module export — see that assignment for why. NOT `export`ed itself. */
function mapOpenCodeEvent(event) {
  if (event?.type === "session.idle") {
    return { kind: "progress", phase: "done" };
  }
  if (event?.type === "file.edited") {
    const file = event.properties?.file;
    if (typeof file !== "string" || file.length === 0) {
      return null;
    }
    return { kind: "file_change", path: file, action: "modify" };
  }
  return null;
}

/** A lazy, reconnect-on-demand sender: no socket connection is opened at
 * all until the first mappable event actually needs to go out (unlike
 * forwarder.mjs's connect-per-invocation model, this plugin lives for the
 * whole OpenCode process, so one persistent connection is reused instead of
 * one per message). Never throws — a missing/misconfigured socket, or a
 * connection error, silently means "nothing sent," exactly like an agent
 * that never used the hook channel at all. */
function createSender() {
  let conn = null;

  function ensureConnection() {
    if (conn) return conn;
    const socketPath = process.env.MULLION_HOOK_SOCKET;
    const token = process.env.MULLION_HOOK_TOKEN;
    if (!socketPath || !token) return null;

    const socket = net.createConnection(socketPath);
    let ready = false;
    const queued = [];
    const wrapper = {
      send(message) {
        const line = `${JSON.stringify(message)}\n`;
        if (ready && socket.writable) {
          socket.write(line);
        } else {
          queued.push(line);
        }
      },
    };

    // 'error' and 'close' fire on separate ticks for a TCP/Unix socket, and
    // a mappable event arriving in between them would already have created
    // a REPLACEMENT connection via a fresh ensureConnection() call (since
    // this one's 'error' handler nulled `conn` first) — an unconditional
    // `conn = null` in the later 'close' handler would then wipe out that
    // newer, healthy connection instead of this dead one. Checking identity
    // (`conn === wrapper`) before clearing makes this immune to that race
    // regardless of firing order or how many times either event fires,
    // unlike a one-shot "already handled" boolean, which only guards
    // against a second event on the SAME socket, not against a second
    // socket having since taken over.
    const forget = () => {
      if (conn === wrapper) conn = null;
    };
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ token })}\n`);
      ready = true;
      for (const line of queued.splice(0)) {
        if (socket.writable) socket.write(line);
      }
    });
    socket.on("error", () => {
      forget();
      socket.destroy();
    });
    socket.on("close", forget);

    conn = wrapper;
    return conn;
  }

  return {
    send(message) {
      ensureConnection()?.send(message);
    },
  };
}

/** The actual plugin export OpenCode's auto-discovery loads (per the
 * documented `export const XPlugin = async (input) => Hooks` shape) — see
 * `@opencode-ai/plugin`'s `Plugin`/`Hooks` types for the authoritative
 * signature this conforms to.
 *
 * This file must have exactly one top-level `export`. Bisected empirically
 * against the installed OpenCode 1.18.4 binary, in response to opencode
 * failing to start under Mullion with "Unexpected server error": this file
 * previously also had a top-level `export function mapOpenCodeEvent`, and
 * with both that export and at least one other top-level function present
 * (e.g. `createSender` below, whether or not it was itself exported),
 * OpenCode's own plugin loader crashed the whole server on startup
 * (`TypeError: null is not an object (evaluating 'N.config')` in its log),
 * before a single event was ever dispatched. The exact mechanism inside
 * OpenCode's loader wasn't identified — only that this file has never
 * crashed it with exactly one export, and reliably did with two. Keep any
 * other helper in this file un-exported; expose it for this project's own
 * tests via a property on `MullionHookEmitter` instead (see below), never
 * via a second top-level `export`. */
export const MullionHookEmitter = async () => {
  const sender = createSender();
  return {
    event: async ({ event }) => {
      const message = mapOpenCodeEvent(event);
      if (message) sender.send(message);
    },
  };
};

MullionHookEmitter.mapOpenCodeEvent = mapOpenCodeEvent;
