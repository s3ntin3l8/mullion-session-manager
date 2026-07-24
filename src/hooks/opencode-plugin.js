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
// Follow-up to #275 (gap #2, issue #259) — beyond `session.idle`/
// `file.edited`, this now also forwards `permission.updated`/
// `permission.replied`, `session.error`, `tui.toast.show` (warning/error
// only), and `session.status`. All are non-blocking, OBSERVATIONAL events
// from opencode's own event bus (the same `event` hook this file already
// taps) — confirmed against the installed `@opencode-ai/sdk` package's own
// generated types (`Event` union in dist/gen/types.gen.d.ts). Crucially,
// `permission.updated`/`permission.replied` are NOT the same thing as
// opencode's actual GATING hook, `permission.ask` (mutating `output.status`)
// — that one is still deliberately NOT wired up here: there is no endpoint
// yet to answer a real gate decision (issue #178), and wiring a blocking
// permission hook with nothing to resolve it would hang every gated action
// instead of just not being there — same reasoning as Claude Code's deferred
// PreToolUse (see hook-adapters/claude-code.ts). `permission.updated` is
// merely opencode telling the world a permission decision is now pending,
// exactly as observational as `session.idle` telling the world a turn ended.

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
  // Follow-up to #275 (gap #2) — a permission decision is now pending;
  // `properties.title` (Permission.title in the SDK's generated types) is
  // opencode's own human-readable summary of what's being asked.
  if (event?.type === "permission.updated") {
    const title = event.properties?.title;
    return {
      kind: "notification",
      title: "opencode",
      body: typeof title === "string" ? title : "",
    };
  }
  // Follow-up to #275 (gap #2) — the pending permission above has now been
  // answered (by a human in the TUI, or auto-approved by opencode's own
  // trust config) — see NotificationResolvedHookMessage's doc comment in
  // hook-protocol.ts for why this exists at all now that a confirmed
  // hookNotification no longer clears on plain PTY output.
  if (event?.type === "permission.replied") {
    return { kind: "notification_resolved" };
  }
  // Follow-up to #275 (gap #2) — an agent-level error (provider auth, API
  // failure, output-length limit, ...) is exactly a "needs your attention"
  // event, currently surfaced nowhere. `MessageAbortedError` is the one
  // member of this union that means the USER interrupted the turn
  // themselves (Ctrl-C) — not attention-worthy, so it's the one error kind
  // deliberately skipped. `error.data` is typed loosely by the SDK (only
  // MessageOutputLengthError's `data` has no guaranteed `message` field), so
  // this falls back to the error's own `name` rather than assuming one.
  if (event?.type === "session.error") {
    const error = event.properties?.error;
    if (!error || error.name === "MessageAbortedError") {
      return null;
    }
    const message = error.data?.message;
    return {
      kind: "notification",
      title: "opencode error",
      body: typeof message === "string" && message.length > 0 ? message : error.name,
    };
  }
  // Follow-up to #275 (gap #2) — mirrors opencode's own user-facing toast,
  // but only `warning`/`error` variants: `info`/`success` (e.g. "copied to
  // clipboard") are routine confirmations, not attention-worthy, and would
  // just be notification noise.
  if (event?.type === "tui.toast.show") {
    const { variant, title, message } = event.properties ?? {};
    if (variant !== "warning" && variant !== "error") {
      return null;
    }
    return {
      kind: "notification",
      title: typeof title === "string" && title.length > 0 ? title : "opencode",
      body: typeof message === "string" ? message : "",
    };
  }
  // Follow-up to #275 (gap #2) — SessionStatus = idle | busy | retry{attempt,
  // message, next}. `retry` (e.g. a rate-limit backoff) is a stall worth
  // surfacing as a notification; `busy`/`idle` give a richer working/idle
  // signal than the bare `session.idle` event above, mapped the same way
  // that event already is. NOTE: the backend's `progress` phase is a CLOSED
  // enum (thinking|generating|done — see hook-protocol.ts's validateProgress)
  // — `busy` maps to `generating`, not an invented "working", which the
  // backend would reject. Only `done` drives attention (`agentIdle`);
  // `generating` is purely a status_change, so `busy` causes no attention
  // change of its own.
  if (event?.type === "session.status") {
    const status = event.properties?.status;
    if (status?.type === "retry") {
      return {
        kind: "notification",
        title: "opencode retrying",
        body: `attempt ${status.attempt}: ${status.message}`,
      };
    }
    if (status?.type === "busy") {
      return { kind: "progress", phase: "generating" };
    }
    if (status?.type === "idle") {
      return { kind: "progress", phase: "done" };
    }
    return null;
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

/**
 * Opens a one-shot connection to the hook socket to send a blocking
 * promote_request (issue #271) and waits for a human decision — used by
 * the `promote_to_worktree` tool handler below. Returns a user-facing
 * string for the model to display. Never throws: every error path
 * (missing env, connection failure, timeout, malformed reply) returns a
 * declined message.
 */
function promoteRequest(summary, suggestedBaseRef) {
  const socketPath = process.env.MULLION_HOOK_SOCKET;
  const token = process.env.MULLION_HOOK_TOKEN;
  if (!socketPath) {
    return Promise.resolve(
      "Declined: MULLION_HOOK_SOCKET is not set — not running inside a Mullion session",
    );
  }
  if (!token) {
    return Promise.resolve(
      "Declined: MULLION_HOOK_TOKEN is not set — not running inside a Mullion session",
    );
  }

  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish("Declined: timed out waiting for a decision"), 290_000);

    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) return;
      const line = buffer.slice(0, newlineIndex);
      let reply;
      try {
        reply = JSON.parse(line);
      } catch {
        finish("Declined: malformed response");
        return;
      }
      if (reply?.decision === "accepted") {
        finish(
          `Approved — work moved to a new worktree` +
            (reply.worktreePath ? ` at ${reply.worktreePath}` : "") +
            (reply.newSessionId != null ? ` (session ${reply.newSessionId})` : "") +
            `. This session is ending; continue in the new one.`,
        );
      } else {
        finish(
          `Declined${reply?.reason ? `: ${reply.reason}` : ""}. Continue on the current checkout.`,
        );
      }
    });
    socket.on("error", () => finish("Declined: connection error"));
    socket.on("close", () => finish("Declined: connection closed"));
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ token })}\n`);
      socket.write(`${JSON.stringify({ kind: "promote_request", summary, suggestedBaseRef })}\n`);
    });
  });
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

  // Lazy zod import for tool schema. Zod is available in OpenCode's own
  // runtime (it's a dependency of @opencode-ai/plugin) but not guaranteed
  // in every test environment — the try/catch makes the promote tool
  // registration conditional rather than failing the whole plugin load.
  let z = null;
  try {
    z = (await import("zod")).z;
  } catch {
    // zod not available — promote_to_worktree tool registration skipped
  }

  const promoteTool = z
    ? {
        description:
          "Move the current session's work into a new, isolated git worktree. Blocks until a " +
          "human approves or declines the request. On approval, this session ends and a new one " +
          "starts in the worktree, seeded with `summary` as its starting context.",
        args: {
          summary: z
            .string()
            .describe("A seed/summary of the work so far, for the new session's starting context."),
          suggestedBaseRef: z
            .string()
            .optional()
            .describe(
              "A base ref to suggest for the new worktree's branch (e.g. the current branch).",
            ),
        },
        execute: async (args) => {
          return promoteRequest(args.summary, args.suggestedBaseRef);
        },
      }
    : null;

  return {
    tool: promoteTool ? { promote_to_worktree: promoteTool } : {},
    event: async ({ event }) => {
      const message = mapOpenCodeEvent(event);
      if (message) sender.send(message);
    },
  };
};

MullionHookEmitter.mapOpenCodeEvent = mapOpenCodeEvent;
MullionHookEmitter.promoteRequest = promoteRequest;
