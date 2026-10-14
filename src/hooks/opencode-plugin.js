// OpenCode hook plugin (issue #175, rewritten for opencode v2 — minimum
// 2.0.29) — OpenCode has no shell-command hooks (unlike Claude Code/Codex/
// agy), only a JS plugin API, so it can't reuse forwarder.mjs. This is that
// agent's own bridge to the same hook socket protocol, auto-injected per
// session (see hook-adapters/opencode.ts) as a directory plugin referenced
// from `OPENCODE_CONFIG_CONTENT`'s `plugins` — never a write to the user's
// real ~/.config/opencode or a project's .opencode/.
//
// Deliberately plain JavaScript importing only `node:*`, for the same reason
// forwarder.mjs is: this file is copied byte-for-byte into an ephemeral
// directory (as `server.js`) and loaded directly by OpenCode's OWN plugin
// loader, not imported by Mullion's server process. v2's loader requires
// exactly `export default { id, setup }`; it provides `effect` and
// `@opencode/plugin` to plugins but NOT `zod`, so the promote tool below
// declares a plain JSON Schema `input` instead.
//
// v2 differences from the 1.x plugin this replaces:
//  - events come from `ctx.event.subscribe()` (an async iterable), and the
//    payload is under `event.data` (1.x: `event.properties`). Event names
//    changed — see mapOpenCodeEvent. `todo.updated`, `session.diff`,
//    `tui.toast.show`, `worktree.failed` and `mcp.browser.open.failed` have
//    no v2 server-side source, so those hook kinds are no longer emitted.
//  - the plugin may run in a server whose `process.cwd()` is not the
//    session's directory (and `setup` runs once per Location), so directories
//    come from `event.location.directory` / `ctx.location.directory`, never
//    from `process.cwd()`. Mullion launches opencode with `--standalone` so
//    the server is private to the session and inherits its MULLION_* env —
//    under the default shared background service they would be wrong.
//  - the bash tool is now `shell` (`input.command`/`input.workdir`).
//
// Only non-blocking events are forwarded. The real gating hook,
// `ctx.permission.hook("evaluate")`, is deliberately not wired up yet (issue
// #178, same reasoning as Claude Code's deferred PreToolUse): with no
// endpoint to answer a gate decision, a blocking hook would hang every gated
// action instead of just not being there.

import net from "node:net";
import path from "node:path";
import { readFileSync } from "node:fs";

/** Per-plugin-instance bookkeeping the otherwise-pure mapper needs across
 * events: v2 reports subagent activity as ordinary events on a CHILD session
 * (`session.created` with a `parentID`), so a child's execution events must
 * not be mistaken for the main session's turn boundaries; and
 * `form.replied`/`form.cancelled` carry only a `sessionID`, so a pending
 * question must be remembered to know the reply resolves one. */
function createMapState() {
  return { childSessions: new Set(), questionSessions: new Set() };
}

/** Issue #1230 — opencode has no Stop-analogue field carrying the agent's
 * own final turn text the way Claude Code/codex's Stop hook does, so this
 * reconstructs one from v2's `session.text.ended` events (`data.text`, keyed
 * by `data.assistantMessageID` + `data.ordinal`). The tracked text is scoped
 * to the CURRENT assistant message — reset when the message id changes and
 * when a new execution starts — and parts are joined in ordinal order, so a
 * message with several text blocks still reads as one turn. Child (subagent)
 * sessions are ignored so their prose never lands on the main session's
 * "done". Kept as its own tracker object so `mapOpenCodeEvent` stays pure;
 * `setup` owns one instance per plugin instance. */
function createAssistantTextTracker() {
  let assistantMessageId = null;
  let parts = new Map();
  return {
    observe(event, state) {
      const data = event?.data;
      if (!data || typeof data !== "object") return;
      if (state?.childSessions?.has(data.sessionID)) return;
      if (event.type === "session.execution.started") {
        assistantMessageId = null;
        parts = new Map();
      } else if (event.type === "session.text.ended") {
        if (typeof data.text !== "string" || typeof data.assistantMessageID !== "string") return;
        if (data.assistantMessageID !== assistantMessageId) {
          assistantMessageId = data.assistantMessageID;
          parts = new Map();
        }
        parts.set(typeof data.ordinal === "number" ? data.ordinal : parts.size, data.text);
      }
    },
    current() {
      if (parts.size === 0) return null;
      return [...parts.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, text]) => text)
        .join("\n\n");
    },
  };
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

/** Maps one OpenCode v2 event (`{ type, data, location? }`) to an array of
 * hook-protocol messages, or `null` if this event type isn't forwarded.
 * Pure apart from mutating `state` (see createMapState) — no I/O — so it's
 * unit-tested directly via the `mapOpenCodeEvent` property on the default
 * export below. NOT exported itself (see the export note at the bottom).
 *
 * `fallbackCwd` — used for cwd_changed when the event has no
 * `location.directory`. `lastAssistantMessage` — issue #1230, the current
 * turn's assistant text from createAssistantTextTracker (or null); attached
 * to the "done" progress message, the same field name Claude Code's/codex's
 * Stop hook carries it under. */
function mapOpenCodeEvent(
  event,
  fallbackCwd,
  lastAssistantMessage = null,
  state = createMapState(),
) {
  const type = event?.type;
  const data = event?.data;
  if (typeof type !== "string" || !data || typeof data !== "object") return null;
  const sessionID = data.sessionID;
  const isChild = nonEmptyString(sessionID) && state.childSessions.has(sessionID);
  const cwd = nonEmptyString(event.location?.directory) ? event.location.directory : fallbackCwd;

  // Subagent events (issue #321). v2 has no dedicated subagent event: a
  // subagent is a child session, so its lifecycle is `session.created` with
  // a `parentID` through to that child's own execution end.
  if (type === "session.created") {
    if (nonEmptyString(data.parentID) && nonEmptyString(sessionID)) {
      state.childSessions.add(sessionID);
      return [{ kind: "subagent", state: "started" }];
    }
    return null;
  }

  // A turn started/ended/failed/was interrupted. Replaces 1.x's
  // `session.idle`/`session.status`/`session.error`.
  if (type === "session.execution.started") {
    if (isChild) return null;
    return [{ kind: "turn_start" }, { kind: "progress", phase: "generating" }];
  }
  if (
    isChild &&
    (type === "session.execution.succeeded" ||
      type === "session.execution.failed" ||
      type === "session.execution.interrupted")
  ) {
    state.childSessions.delete(sessionID);
    return [{ kind: "subagent", state: "finished" }];
  }
  if (type === "session.execution.succeeded") {
    // Issue #271 follow-up — the session id is reported on every finished
    // turn (a LIVE fact, not an announcement; PtyManager just overwrites its
    // stored value) so a later promote can export/import this session's real
    // conversation history instead of only a seed summary (see
    // opencode-session-transfer.ts).
    const progress = { kind: "progress", phase: "done" };
    if (lastAssistantMessage !== null) progress.lastAssistantMessage = lastAssistantMessage;
    const messages = [progress];
    if (nonEmptyString(sessionID)) messages.push({ kind: "agent_session", sessionId: sessionID });
    return messages;
  }
  // An agent-level error (provider auth, API failure, ...) is exactly a
  // "needs your attention" event — `tool_failure` gets the dedicated red
  // error dot and counts in the aggregate attention badge. A user abort is
  // a separate `session.execution.interrupted` event in v2 (deliberately NOT
  // mapped — not attention-worthy), unlike 1.x's `MessageAbortedError`.
  if (type === "session.execution.failed") {
    const error = data.error;
    if (!error || typeof error !== "object") return null;
    const errorType = nonEmptyString(error.type) ? error.type : "error";
    const messages = [
      {
        kind: "tool_failure",
        tool: "opencode",
        error: errorType,
        summary: nonEmptyString(error.message) ? error.message : errorType,
      },
    ];
    // A turn that dies with a question still pending will never see its
    // form.replied/cancelled — don't leave "awaiting answer" latched.
    if (nonEmptyString(sessionID) && state.questionSessions.delete(sessionID)) {
      messages.push({ kind: "question", state: "finished" });
    }
    return messages;
  }
  if (type === "session.execution.interrupted") {
    // Same pending-question cleanup (e.g. Esc while a question form is open).
    if (nonEmptyString(sessionID) && state.questionSessions.delete(sessionID)) {
      return [{ kind: "question", state: "finished" }];
    }
    return null;
  }
  // A rate-limit/provider backoff is a stall worth surfacing as progress.
  // NOTE: the backend's `progress` phase is a CLOSED enum
  // (thinking|generating|done — see hook-protocol.ts's validateProgress);
  // `generating` is purely a status_change and drives no attention itself.
  if (type === "session.retry.scheduled") {
    if (isChild) return null;
    const message = data.error?.message;
    return [
      {
        kind: "progress",
        phase: "generating",
        detail: `retry attempt ${data.attempt}${nonEmptyString(message) ? `: ${message}` : ""}`,
      },
    ];
  }
  // Files the agent changed during a step (relative to the session's
  // directory) — v2's replacement for 1.x's `file.edited`. The noisier
  // `filesystem.changed` watcher event is deliberately not used: it fires
  // for every change on disk, not just the agent's own edits.
  if (type === "session.step.ended") {
    if (isChild || !Array.isArray(data.files)) return null;
    const messages = data.files.filter(nonEmptyString).map((file) => ({
      kind: "file_change",
      path: nonEmptyString(cwd) && !path.isAbsolute(file) ? path.resolve(cwd, file) : file,
      action: "modify",
    }));
    return messages.length > 0 ? messages : null;
  }

  // `permission.asked` -> `permission_request`, so it gets the dedicated
  // purple "Needs permission" dot and output-immune attention semantics (see
  // hook-protocol.ts's permission_request comment). v2's request carries
  // `action` (e.g. "shell") and `resources` (e.g. file paths/commands).
  if (type === "permission.asked") {
    const summary = [data.action, data.resources?.[0]].filter(nonEmptyString).join(" ");
    return [{ kind: "permission_request", tool: "opencode", summary }];
  }
  // The pending permission has been answered (by a human in the TUI, or
  // auto-approved) — `permission_resolved` clears `permissionRequest`/
  // `permissionState` (see PermissionResolvedHookMessage's doc comment in
  // hook-protocol.ts).
  if (type === "permission.replied") {
    return [{ kind: "permission_resolved" }];
  }

  // Question events — opencode's `question` tool is a v2 *form* whose
  // metadata.kind is "question". Mapped to a dedicated `question` hook kind
  // so Mullion shows an "awaiting answer" session status, with output-immune
  // semantics (mirroring permission_request/plan_ready).
  if (type === "form.created") {
    const form = data.form;
    if (form?.metadata?.kind !== "question") return null;
    if (nonEmptyString(form.sessionID)) state.questionSessions.add(form.sessionID);
    const fields = Array.isArray(form.fields) ? form.fields : Object.values(form.fields ?? {});
    const first = fields[0];
    const tool = form.metadata.tool;
    const hasTool = tool && nonEmptyString(tool.messageID) && nonEmptyString(tool.id);
    const summary = first?.description ?? form.title;
    return [
      {
        kind: "question",
        state: "started",
        header: nonEmptyString(first?.title) ? first.title.slice(0, 30) : undefined,
        summary: nonEmptyString(summary) ? summary : undefined,
        ...(hasTool ? { tool: { messageID: tool.messageID, callID: tool.id } } : {}),
      },
    ];
  }
  if (type === "form.replied" || type === "form.cancelled") {
    if (!nonEmptyString(sessionID) || !state.questionSessions.delete(sessionID)) return null;
    return [{ kind: "question", state: "finished" }];
  }

  // Issue: sidebar worktree detection — opencode emits vcs.branch.updated
  // when its VCS tracking detects a branch change. The event's own
  // `location.directory` becomes a cwd_changed alongside, so PtyManager's
  // liveCwd is updated together with liveBranch.
  if (type === "vcs.branch.updated") {
    if (!nonEmptyString(data.branch)) return null;
    const messages = [{ kind: "git_branch", branch: data.branch }];
    if (nonEmptyString(cwd)) messages.unshift({ kind: "cwd_changed", cwd });
    return messages;
  }

  // Compaction events (issue #321).
  if (type === "session.compaction.started") {
    return isChild ? null : [{ kind: "compact", state: "started" }];
  }
  if (type === "session.compaction.ended" || type === "session.compaction.failed") {
    return isChild ? null : [{ kind: "compact", state: "finished" }];
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

/** Maps a v2 `tool.execute.after` event (`{ tool, input, status, ... }`) to an
 * array of hook-protocol messages, or `null` when the tool execution doesn't
 * warrant forwarding. Only the `shell` tool is inspected (1.x's `bash`), and
 * commands are resolved against the call's own `workdir` (falling back to the
 * session's directory) rather than the plugin process's cwd. Pure — no I/O —
 * so it's unit-testable, same pattern as mapOpenCodeEvent above. */
function mapToolExecuteAfter(event, fallbackCwd) {
  if (!event || typeof event !== "object") return null;
  if (event.tool !== "shell" || event.status === "error") return null;

  const command = event.input?.command;
  if (typeof command !== "string" || command.length === 0) return null;
  // A relative `workdir` is relative to the SESSION's directory, not this
  // plugin process's cwd.
  let cwd = fallbackCwd;
  if (nonEmptyString(event.input?.workdir)) {
    const workdir = event.input.workdir;
    cwd =
      path.isAbsolute(workdir) || !nonEmptyString(fallbackCwd)
        ? workdir
        : path.resolve(fallbackCwd, workdir);
  }

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
 * string for the model to display. `signal` (the tool call's own abort
 * signal) resolves it as declined instead of leaving the socket wait dangling
 * when the session is aborted. Never throws: every error path
 * (missing env, connection failure, timeout, malformed reply) returns a
 * declined message.
 */
function promoteRequest(summary, suggestedBaseRef, signal) {
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
    if (signal) {
      if (signal.aborted) finish("Declined: aborted");
      else signal.addEventListener("abort", () => finish("Declined: aborted"), { once: true });
    }

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

const PROMOTE_TOOL_DESCRIPTION =
  "Move the current session's work into a new, isolated git worktree. Blocks until a " +
  "human approves or declines the request. On approval, this session ends and a new one " +
  "starts in the worktree, seeded with `summary` as its starting context — the full " +
  "conversation history is also carried over when possible, alongside the seed.";

const PROMOTE_TOOL_INPUT = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "A seed/summary of the work so far, for the new session's starting context.",
    },
    suggestedBaseRef: {
      type: "string",
      description: "A base ref to suggest for the new worktree's branch (e.g. the current branch).",
    },
  },
  required: ["summary"],
  additionalProperties: false,
};

/** Reads the per-session instruction files (tier-0 guide, workflow
 * conventions, project briefing, promote seed — see hook-adapters/
 * opencode.ts) whose absolute paths arrive as a JSON array in
 * MULLION_OPENCODE_INSTRUCTIONS. v2 parses the config `instructions` key
 * but never reads it, so these ride the session `context` hook instead.
 * Never throws: an unreadable file is skipped. */
function readInstructionTexts() {
  let paths;
  try {
    paths = JSON.parse(process.env.MULLION_OPENCODE_INSTRUCTIONS ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(paths)) return [];
  const texts = [];
  for (const file of paths) {
    if (!nonEmptyString(file) || !path.isAbsolute(file)) continue;
    try {
      const text = readFileSync(file, "utf8").trim();
      if (text.length > 0) texts.push(text);
    } catch {
      // missing/unreadable instruction file — skip, never fail the request
    }
  }
  return texts;
}

/** The plugin OpenCode v2's loader accepts: exactly `export default { id,
 * setup }` (it also accepts `{ id, effect }`). See `@opencode/plugin`'s
 * Promise `Plugin.define` — an identity function, so a plain object literal
 * with no `@opencode/plugin` import is equivalent.
 *
 * This file must have exactly one top-level `export` (the 1.x loader crashed
 * on two; kept for the same safety under v2). Keep any other helper
 * un-exported; expose it for this project's own tests via a property on the
 * default export instead (see below), never via a second top-level `export`.
 *
 * `setup` runs once per Location in a server, so every piece of state below
 * lives inside it, never at module scope. It returns a cleanup function that
 * aborts the event subscription (v2 also closes the stream itself on
 * unload). Outside a Mullion session (no hook socket/token env) it does
 * nothing — a stray load must never crash or noisy-log opencode. */
const MullionHookEmitter = {
  id: "mullion-hook-emitter",
  setup: async (ctx) => {
    if (!process.env.MULLION_HOOK_SOCKET || !process.env.MULLION_HOOK_TOKEN) return undefined;

    const sender = createSender();
    const state = createMapState();
    // Issue #1230 — observes every event before mapOpenCodeEvent sees it so
    // a "done" message can attach the turn's reconstructed text.
    const assistantText = createAssistantTextTracker();
    const baseCwd = ctx.location?.directory;
    const abort = new AbortController();
    const registrations = [];
    let instructionTexts = null;

    const forward = (messages) => {
      if (messages) for (const msg of messages) sender.send(msg);
    };

    // Consume the event stream without blocking setup. A subscribe error
    // (stream closed, aborted on cleanup) just ends the loop.
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
          try {
            assistantText.observe(event, state);
            // The reconstructed text is only used by the turn-end message —
            // don't sort/join it on every high-frequency event.
            const text =
              event?.type === "session.execution.succeeded" ? assistantText.current() : null;
            forward(mapOpenCodeEvent(event, baseCwd, text, state));
          } catch {
            // one malformed event must never end the stream
          }
        }
      } catch {
        // aborted / stream ended
      }
    })();

    // `promote_to_worktree` (issue #271) — a blocking round trip to the human.
    registrations.push(
      await ctx.tool.transform((tools) => {
        tools.add({
          name: "promote_to_worktree",
          description: PROMOTE_TOOL_DESCRIPTION,
          input: PROMOTE_TOOL_INPUT,
          execute: async (input, toolContext) => ({
            content: await promoteRequest(
              input?.summary,
              input?.suggestedBaseRef,
              toolContext?.signal,
            ),
          }),
        });
      }),
    );

    // Issue: sidebar worktree detection — opencode's own vcs.branch.updated
    // reports the main checkout's branch, not the worktree's (see
    // Sidebar.tsx and PaneTab.tsx comments). This hook intercepts shell tool
    // completions so we can parse `git worktree add` and `git checkout`/
    // `git switch` commands ourselves, extracting the real branch name and
    // worktree path — the same approach forwarder-core.mjs uses for Claude
    // Code/Codex/agy, but from opencode's own plugin API instead of
    // shell-command hooks.
    registrations.push(
      await ctx.tool.hook("execute.after", (event) => {
        forward(mapToolExecuteAfter(event, baseCwd));
      }),
    );

    // Per-session instruction files (see readInstructionTexts). `context`
    // fires for the primary agent loop only (compaction/title/generate are
    // separate hooks). Idempotent: setup may run per Location, so a second
    // instance's hook must not duplicate a part the first already added.
    if (nonEmptyString(process.env.MULLION_OPENCODE_INSTRUCTIONS)) {
      registrations.push(
        await ctx.session.hook("context", (event) => {
          // The files never change after spawn — read them once, not on
          // every model request.
          instructionTexts ??= readInstructionTexts();
          for (const text of instructionTexts) {
            if (!event.system.some((part) => part?.text === text)) {
              event.system.push({ type: "text", text });
            }
          }
        }),
      );
    }

    return async () => {
      abort.abort();
      for (const registration of registrations) {
        try {
          await registration?.dispose?.();
        } catch {
          // best-effort cleanup
        }
      }
    };
  },
};

MullionHookEmitter.mapOpenCodeEvent = mapOpenCodeEvent;
MullionHookEmitter.createMapState = createMapState;
MullionHookEmitter.createAssistantTextTracker = createAssistantTextTracker;
MullionHookEmitter.promoteRequest = promoteRequest;
MullionHookEmitter.readInstructionTexts = readInstructionTexts;
MullionHookEmitter.parseGitWorktreeAdd = parseWorktreeAddCommand;
MullionHookEmitter.parseGitCheckout = parseGitCheckoutCommand;
MullionHookEmitter.splitShellSegments = splitShellSegments;
MullionHookEmitter.mapToolExecuteAfter = mapToolExecuteAfter;

export default MullionHookEmitter;
