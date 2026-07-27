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
import path from "node:path";

/** Maps one OpenCode plugin `event` payload to an array of hook-protocol
 * messages, or `null` if this event type isn't forwarded (yet, or ever).
 * Most events produce a single-element array; branch/worktree events may
 * produce two (cwd_changed + git_branch) when `cwd` is provided. Pure — no
 * I/O — so it's unit-tested directly by importing this file, via the
 * `MullionHookEmitter.mapOpenCodeEvent` property below rather than its own
 * module export — see that assignment for why. NOT `export`ed itself.
 *
 * `cwd` — when provided, the opencode process's own cwd (process.cwd()),
 * included as a cwd_changed message alongside branch events so PtyManager's
 * liveCwd reflects the directory opencode is actually running from. */
function mapOpenCodeEvent(event, cwd) {
  if (event?.type === "session.idle") {
    return [{ kind: "progress", phase: "done" }];
  }
  if (event?.type === "file.edited") {
    const file = event.properties?.file;
    if (typeof file !== "string" || file.length === 0) {
      return null;
    }
    return [{ kind: "file_change", path: file, action: "modify" }];
  }
  // Fix: opencode v2 event names — opencode 1.18.7 fires `permission.asked`
  // (v2 API), not `permission.updated` (v1). The v2 PermissionRequest type
  // has `permission` (the permission type, e.g. "bash") and `patterns`
  // (file paths) instead of v1's `title` (human-readable summary). Mapped to
  // `permission_request` so it gets the dedicated purple "Needs permission"
  // dot and output-immune attention semantics (see hook-protocol.ts's
  // permission_request comment).
  if (event?.type === "permission.asked") {
    const permission = event.properties?.permission;
    const pattern = event.properties?.patterns?.[0];
    const summary = [permission, pattern]
      .filter((s) => typeof s === "string" && s.length > 0)
      .join(" ");
    return [{ kind: "permission_request", tool: "opencode", summary }];
  }
  // Follow-up to #275 (gap #2), fixed by fix: status-clearing-semantics —
  // the pending permission above has now been answered (by a human in the
  // TUI, or auto-approved by opencode's own trust config). Mapped to
  // `permission_resolved`, matching what `permission.updated` above actually
  // raises (`permission_request`, not a generic `notification`) — this used
  // to map to `notification_resolved`, whose handler only clears a confirmed
  // `hookNotification` attention kind, not `permissionRequest`/
  // `permissionState`, so answering an opencode permission cleared nothing
  // at all. See PermissionResolvedHookMessage's doc comment in
  // hook-protocol.ts.
  if (event?.type === "permission.replied") {
    return [{ kind: "permission_resolved" }];
  }
  // Follow-up to #275 (gap #2) — an agent-level error (provider auth, API
  // failure, output-length limit, ...) is exactly a "needs your attention"
  // event. Mapped to `tool_failure` (not a generic `notification`) so it
  // gets the dedicated red error dot in the sidebar and counts in the
  // aggregate attention badge. `MessageAbortedError` is the one member of
  // this union that means the USER interrupted the turn themselves (Ctrl-C)
  // — not attention-worthy, so it's the one error kind deliberately skipped.
  // `error.data` is typed loosely by the SDK (only
  // MessageOutputLengthError's `data` has no guaranteed `message` field), so
  // this falls back to the error's own `name` rather than assuming one.
  if (event?.type === "session.error") {
    const error = event.properties?.error;
    if (!error || error.name === "MessageAbortedError") {
      return null;
    }
    const message = error.data?.message;
    return [
      {
        kind: "tool_failure",
        tool: "opencode",
        error: error.name,
        summary: typeof message === "string" && message.length > 0 ? message : error.name,
      },
    ];
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
    return [
      {
        kind: "notification",
        title: typeof title === "string" && title.length > 0 ? title : "opencode",
        body: typeof message === "string" ? message : "",
      },
    ];
  }
  // Question events — opencode's `question` tool fires these when the model
  // asks the user a multiple-choice question. Mapped to a dedicated `question`
  // hook kind so Mullion shows an "awaiting answer" session status, with
  // output-immune semantics (mirroring permission_request/plan_ready).
  if (event?.type === "question.asked") {
    const questions = event.properties?.questions;
    const first = Array.isArray(questions) && questions.length > 0 ? questions[0] : null;
    const tool = event.properties?.tool;
    const hasTool = tool && typeof tool.messageID === "string" && typeof tool.callID === "string";
    return [
      {
        kind: "question",
        state: "started",
        header: typeof first?.header === "string" ? first.header : undefined,
        summary: typeof first?.question === "string" ? first.question : undefined,
        ...(hasTool ? { tool: { messageID: tool.messageID, callID: tool.callID } } : {}),
      },
    ];
  }
  if (event?.type === "question.replied" || event?.type === "question.rejected") {
    return [{ kind: "question", state: "finished" }];
  }
  // Todo events — opencode fires `todo.updated` when the model's structured
  // task list changes (the todowrite tool). Each event carries one todo
  // item's new state. Forwarded for the timeline feed; no session-status
  // impact.
  if (event?.type === "todo.updated") {
    const content = event.properties?.content;
    const status = event.properties?.status;
    if (typeof content !== "string" || typeof status !== "string") return null;
    const priority = event.properties?.priority;
    return [
      {
        kind: "todo",
        content,
        status,
        priority:
          typeof priority === "string" && ["high", "medium", "low"].includes(priority)
            ? priority
            : "medium",
      },
    ];
  }
  // Session diff events — fires at turn end with per-file change summaries.
  // Forwarded for the timeline feed; no session-status impact.
  if (event?.type === "session.diff") {
    const diff = event.properties?.diff;
    if (!Array.isArray(diff) || diff.length === 0) return null;
    const files = diff
      .map((d) => ({
        file: typeof d.file === "string" ? d.file : "",
        additions: typeof d.additions === "number" ? d.additions : 0,
        deletions: typeof d.deletions === "number" ? d.deletions : 0,
        patch: typeof d.patch === "string" ? d.patch : undefined,
      }))
      .filter((f) => f.file.length > 0);
    if (files.length === 0) return null;
    return [{ kind: "session_diff", files }];
  }
  // Worktree failure — surface as a notification so the user sees it in
  // Mullion's event feed without needing to watch the PTY output.
  if (event?.type === "worktree.failed") {
    const error = event.properties?.error;
    return [
      {
        kind: "notification",
        title: "OpenCode",
        body:
          typeof error === "string" && error.length > 0
            ? `Worktree creation failed: ${error}`
            : "Worktree creation failed",
      },
    ];
  }
  // MCP browser auth failure — the MCP OAuth flow couldn't open a browser.
  if (event?.type === "mcp.browser.open.failed") {
    const mcpName = event.properties?.mcpName;
    return [
      {
        kind: "notification",
        title: "MCP auth failed",
        body:
          typeof mcpName === "string" && mcpName.length > 0
            ? `${mcpName} failed to open browser for authentication`
            : "MCP browser auth failed",
      },
    ];
  }
  // Follow-up to #275 (gap #2) — SessionStatus = idle | busy | retry{attempt,
  // message, next}. `retry` (e.g. a rate-limit backoff) is a stall worth
  // surfacing as a progress event; `busy`/`idle` give a richer working/idle
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
      return [
        {
          kind: "progress",
          phase: "generating",
          detail: `retry attempt ${status.attempt}: ${status.message}`,
        },
      ];
    }
    if (status?.type === "busy") {
      return [{ kind: "turn_start" }, { kind: "progress", phase: "generating" }];
    }
    if (status?.type === "idle") {
      return [{ kind: "progress", phase: "done" }];
    }
    return null;
  }
  // Issue: sidebar worktree detection — opencode's SDK emits
  // vcs.branch.updated when its internal VCS tracking detects a branch
  // change (git checkout, worktree creation, etc.). When `cwd` is provided,
  // also include a cwd_changed message so PtyManager's liveCwd can be
  // updated alongside liveBranch.
  if (event?.type === "vcs.branch.updated") {
    const branch = event.properties?.branch;
    if (typeof branch === "string" && branch.length > 0) {
      const messages = [{ kind: "git_branch", branch }];
      if (typeof cwd === "string" && cwd.length > 0) {
        messages.unshift({ kind: "cwd_changed", cwd });
      }
      return messages;
    }
    return null;
  }
  // Issue: sidebar worktree detection — opencode emits worktree.ready when
  // its own worktree management creates or enters a worktree (e.g. via the
  // promote_to_worktree tool or opencode's own worktree feature). Forward
  // the correct branch name so liveBranch reflects the actual worktree
  // branch rather than the main checkout's branch.
  if (event?.type === "worktree.ready") {
    const branch = event.properties?.branch;
    if (typeof branch === "string" && branch.length > 0) {
      const messages = [{ kind: "git_branch", branch }];
      if (typeof cwd === "string" && cwd.length > 0) {
        messages.unshift({ kind: "cwd_changed", cwd });
      }
      return messages;
    }
    return null;
  }
  // Compaction events (issue #321)
  if (event?.type === "session.compacting") {
    const state = event.properties?.state;
    if (state === "started") return [{ kind: "compact", state: "started" }];
    if (state === "finished") return [{ kind: "compact", state: "finished" }];
    return null;
  }
  // Subagent events (issue #321)
  if (event?.type === "session.subagent") {
    const state = event.properties?.state;
    if (state === "started") return [{ kind: "subagent", state: "started" }];
    if (state === "stopped") return [{ kind: "subagent", state: "finished" }];
    return null;
  }
  return null;
}

// ── Command parsing (issue: sidebar worktree detection) ──────────────
// Pure functions that mirror forwarder-core.mjs's own parsers — opencode's
// tool.execute.after hook lets us intercept Bash tool completions the same
// way forwarder.mjs's PostToolUse hooks intercept Claude Code/Codex/agy
// tool calls, but this file is loaded by opencode's plugin runtime (copied
// byte-for-byte into an ephemeral directory), not by Mullion's server — so
// these are inlined rather than imported from forwarder-core.mjs.

function splitShellSegments(command) {
  return command
    .split(/&&|\|\||;|\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function stripLeadingGitGlobalFlags(tokens) {
  const kept = [tokens[0]];
  let i = 1;
  while ((tokens[i] === "-C" || tokens[i] === "-c") && i + 1 < tokens.length) {
    i += 2;
  }
  kept.push(...tokens.slice(i));
  return kept;
}

/** Extracts the last `-C <path>` argument from a git command segment, or
 * null when absent. Only the last `-C` matters — git itself uses the last
 * one when multiple are given. */
function extractGitChdirTarget(segment) {
  const parts = segment.trim().split(/\s+/);
  let i = 1;
  let lastChdir = null;
  while ((parts[i] === "-C" || parts[i] === "-c") && i + 1 < parts.length) {
    if (parts[i] === "-C") lastChdir = parts[i + 1];
    i += 2;
  }
  return lastChdir;
}

/** Resolves a (possibly relative) worktree path to absolute, using the
 * command segment's own `git -C <dir>` target (if any) or the process cwd
 * as the base. */
function resolveWorktreePath(segment, worktree, baseCwd) {
  const chdirTarget = extractGitChdirTarget(segment);
  const base = chdirTarget || (typeof baseCwd === "string" && baseCwd.length > 0 ? baseCwd : null);
  return base ? path.resolve(base, worktree) : worktree;
}

/** Parses a `git worktree add` command and returns `{ branch, worktree }`
 * or `null` if the command doesn't look like worktree add. */
function parseWorktreeAddCommand(command) {
  const tokens = stripLeadingGitGlobalFlags(command.trim().split(/\s+/));
  if (tokens.length < 4 || tokens[0] !== "git" || tokens[1] !== "worktree" || tokens[2] !== "add") {
    return null;
  }

  let branch = null;
  let sawBranchFlag = false;
  const positionals = [];

  for (let i = 3; i < tokens.length; i++) {
    const tok = tokens[i].replace(/^["']|["']$/g, "");
    if (tok === "-b" || tok === "-B") {
      sawBranchFlag = true;
      branch = tokens[i + 1]?.replace(/^["']|["']$/g, "") ?? null;
      i++;
      continue;
    }
    if (tok === "--reason") {
      i++;
      continue;
    }
    if (tok.startsWith("-")) continue;
    positionals.push(tok);
  }

  const worktree = positionals[0] ?? null;
  if (!worktree) return null;
  if (!sawBranchFlag && positionals.length > 1) {
    branch = positionals[1];
  }
  const resolvedBranch = branch ?? path.basename(worktree);
  return { branch: resolvedBranch, worktree };
}

/** Parses a `git checkout`/`git switch` command and returns `{ branch }`
 * or `null` when ambiguous or not a branch change. */
function parseGitCheckoutCommand(command) {
  const tokens = stripLeadingGitGlobalFlags(command.trim().split(/\s+/));
  if (tokens.length < 3 || tokens[0] !== "git") return null;
  const sub = tokens[1];
  if (sub !== "checkout" && sub !== "switch") return null;

  const rest = tokens.slice(2);
  if (rest.includes("--")) return null;

  let branch = null;
  let sawBranchFlag = false;
  const positionals = [];
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i].replace(/^["']|["']$/g, "");
    if (
      (sub === "checkout" && (tok === "-b" || tok === "-B")) ||
      (sub === "switch" && (tok === "-c" || tok === "-C"))
    ) {
      sawBranchFlag = true;
      branch = rest[i + 1]?.replace(/^["']|["']$/g, "") ?? null;
      i++;
      continue;
    }
    if (tok === "-") {
      positionals.push(tok);
      continue;
    }
    if (tok.startsWith("-")) continue;
    positionals.push(tok);
  }

  if (sawBranchFlag) {
    return branch && branch.length > 0 ? { branch } : null;
  }
  if (positionals.length !== 1) return null;
  const candidate = positionals[0];
  if (candidate === "-") return null;
  if (sub === "switch") return { branch: candidate };
  if (candidate === "." || candidate === "..") return null;
  if (/[*?[\]]/.test(candidate)) return null;
  if (/\.\w+$/.test(candidate)) return null;
  return { branch: candidate };
}

/** Maps a `tool.execute.after` input to an array of hook-protocol messages,
 * or `null` when the tool execution doesn't warrant forwarding. Pure — no
 * I/O — so it's unit-testable, same pattern as mapOpenCodeEvent above. */
function mapToolExecuteAfter(input, cwd) {
  if (!input || typeof input !== "object") return null;
  if (input.tool !== "bash" && input.tool !== "Bash") return null;

  const command = input.args?.command ?? input.args?.cmd;
  if (typeof command !== "string" || command.length === 0) return null;

  // git worktree add — extracts cwd_changed + git_branch with worktree path
  let worktreeResult = null;
  let worktreeSegment = null;
  for (const segment of splitShellSegments(command)) {
    const parsed = parseWorktreeAddCommand(segment);
    if (parsed) {
      worktreeResult = parsed;
      worktreeSegment = segment;
    }
  }
  if (worktreeResult) {
    const worktree = resolveWorktreePath(worktreeSegment, worktreeResult.worktree, cwd);
    return [
      { kind: "cwd_changed", cwd: worktree },
      { kind: "git_branch", branch: worktreeResult.branch, worktree },
    ];
  }

  // git checkout / git switch — sends git_branch with the new branch
  let checkoutResult = null;
  for (const segment of splitShellSegments(command)) {
    const parsed = parseGitCheckoutCommand(segment);
    if (parsed) checkoutResult = parsed;
  }
  if (checkoutResult) {
    return [{ kind: "git_branch", branch: checkoutResult.branch }];
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
      const messages = mapOpenCodeEvent(event, process.cwd());
      if (messages) {
        for (const msg of messages) sender.send(msg);
      }
    },
    // Issue: sidebar worktree detection — opencode's own vcs.branch.updated
    // reports the main checkout's branch, not the worktree's (see
    // Sidebar.tsx and PaneTab.tsx comments). This hook intercepts Bash tool
    // completions so we can parse `git worktree add` and `git checkout`/
    // `git switch` commands ourselves, extracting the real branch name and
    // worktree path — the same approach forwarder-core.mjs uses for Claude
    // Code/Codex/agy, but from opencode's own plugin API instead of shell-
    // command hooks.
    "tool.execute.after": async (input, _output) => {
      const messages = mapToolExecuteAfter(input, process.cwd());
      if (messages) {
        for (const msg of messages) sender.send(msg);
      }
    },
  };
};

MullionHookEmitter.mapOpenCodeEvent = mapOpenCodeEvent;
MullionHookEmitter.promoteRequest = promoteRequest;
MullionHookEmitter.parseGitWorktreeAdd = parseWorktreeAddCommand;
MullionHookEmitter.parseGitCheckout = parseGitCheckoutCommand;
MullionHookEmitter.splitShellSegments = splitShellSegments;
MullionHookEmitter.mapToolExecuteAfter = mapToolExecuteAfter;
