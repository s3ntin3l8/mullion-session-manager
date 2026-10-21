// Issue #271 — the `mullion mcp` tool registry (the extension point issue
// #134 builds on: adding a tool later is appending an entry here, never
// touching server.mjs's dispatch loop). Each entry is
// `{ name, description, inputSchema, handler(args, client) }` — `handler`
// returns a plain string (wrapped into MCP's `content: [{type:"text",...}]`
// shape by server.mjs) or throws, which server.mjs turns into a tool-level
// `isError: true` result rather than a protocol-level failure.

import { SELF_REPORT_STATES, WAIT_MAX_TIMEOUT_MS, statusTruncationNote } from "../cli/client.mjs";
import { REVIEW_PROTOCOL_NOTE } from "../cli/review-protocol.mjs";

/**
 * Issue #271, option 2 — lets the model itself decide "start work now" and
 * hand Mullion a seed/summary + an optional suggested base ref. Blocks
 * (via MullionClient.promoteRequest) until a human resolves it — see that
 * method's own doc comment for why this is deliberately not fire-and-forget:
 * the whole point of this action is deterministic isolation, not a nudge
 * the model could race past by continuing to edit the main checkout while
 * a human is still deciding.
 */
const promoteToWorktree = {
  name: "promote_to_worktree",
  description:
    "Move the current session's work into a new, isolated git worktree. Blocks until a " +
    "human approves or declines the request. On approval, this session ends and a new one " +
    "starts in the worktree, seeded with `summary` as its starting context — for opencode, " +
    "the full conversation history is also carried over when possible, alongside the seed.",
  inputSchema: {
    type: "object",
    required: ["summary"],
    properties: {
      summary: {
        type: "string",
        description: "A seed/summary of the work so far, for the new session's starting context.",
      },
      suggestedBaseRef: {
        type: "string",
        description:
          "A base ref to suggest for the new worktree's branch (e.g. the current branch).",
      },
    },
  },
  async handler(args, client) {
    const summary = typeof args?.summary === "string" ? args.summary : "";
    const suggestedBaseRef =
      typeof args?.suggestedBaseRef === "string" ? args.suggestedBaseRef : undefined;
    const result = await client.promoteRequest(summary, suggestedBaseRef);
    if (result.decision === "accepted") {
      return (
        `Approved — work moved to a new worktree` +
        (result.worktreePath ? ` at ${result.worktreePath}` : "") +
        (result.newSessionId !== null ? ` (session ${result.newSessionId})` : "") +
        `. This session is ending; continue in the new one.`
      );
    }
    return `Declined${result.reason ? `: ${result.reason}` : ""}. Continue on the current checkout.`;
  },
};

const useBrowser = {
  name: "use_browser",
  description:
    "Execute a browser automation action (navigate, click, fill, type, press, select, check, uncheck, hover, scroll, wait, dialog, get, screenshot, snapshot, console, errors, find, download). " +
    "Pass `frame` (a CSS selector for an iframe host element) to scope click/fill/select/check/uncheck/hover/get/wait/scroll/snapshot/find/eval (and press/type when also targeting a ref/selector) to that iframe's own document instead of the top-level page; not supported on navigate/screenshot/dialog/console/errors/download, or on nested iframes.",
  inputSchema: {
    type: "object",
    required: ["action"],
    properties: {
      action: {
        type: "string",
        enum: [
          "navigate",
          "snapshot",
          "click",
          "fill",
          "eval",
          "screenshot",
          "press",
          "type",
          "select",
          "check",
          "uncheck",
          "wait",
          "dialog",
          "hover",
          "scroll",
          "get",
          "console",
          "errors",
          "find",
          "download",
        ],
        description: "The browser action to execute.",
      },
      url: { type: "string", description: "URL to navigate to (http/https only)." },
      wait_until: {
        type: "string",
        enum: ["load", "domcontentloaded", "networkidle", "commit"],
        description: "Wait condition for navigate.",
      },
      selector: { type: "string", description: "Playwright-style selector to target an element." },
      ref: {
        type: "string",
        description: "Short-lived data-mullion-ref attribute value to target an element.",
      },
      value: { type: "string", description: "Value to fill, type, press, or select option." },
      script: { type: "string", description: "JS script to evaluate in-page (eval action)." },
      x: { type: "number", description: "X coordinate (for scroll)." },
      y: { type: "number", description: "Y coordinate (for scroll)." },
      text: { type: "string", description: "Optional text/prompt value (for dialog action)." },
      by: {
        type: "string",
        enum: ["text", "role", "label", "placeholder", "testid"],
        description: "Locator strategy for find.",
      },
      name: {
        type: "string",
        description: "Optional accessible name filter for find role strategy.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 50,
        description: "Maximum matching elements to return for find.",
      },
      frame: {
        type: "string",
        description:
          "CSS selector for an iframe host element — scopes this action to that iframe's own document (not supported on navigate/screenshot/dialog/console/errors/download; nested iframes are not supported).",
      },
      timeout_ms: {
        type: "number",
        description:
          "download action only: how long to wait for a download to arrive, if none has already. Default 30000, clamped to a max of 120000.",
      },
      contents: {
        type: "boolean",
        description:
          "download action only: include the file's contents as base64 in the response (subject to max_bytes). Default false.",
      },
      max_bytes: {
        type: "number",
        description:
          "download action only: max file size (bytes) to include as `contents`. Default AND hard cap 1048576 (1 MiB) — larger values are clamped down to it, never allowed to exceed it.",
      },
      clear: {
        type: "boolean",
        description:
          "download action only: remove the entries returned in this response from the server's buffered downloads list afterward.",
      },
    },
  },
  async handler(args, client) {
    const result = await client.browserAction(args);
    return JSON.stringify(result);
  },
};

const browserAction = {
  ...useBrowser,
  name: "browser_action",
};

// #134 part 2 — session/project/preview/dock management, over the control
// socket (MullionClient.controlRequest, client.mjs) rather than the hook
// socket use_browser/promote_to_worktree speak. See client.mjs's own header
// comment for the scope caveat: list_sessions, start_dock_session,
// stop_dock_session, list_projects, create_preview, delete_preview and
// list_previews call full-scope-only control-socket ops, so they return a
// clear "not permitted for this connection's scope" error (not a crash) when
// this MCP server is the one auto-injected into a normal Claude Code session
// — MULLION_AUTH_TOKEN is deliberately never written into that per-session
// config (that would leak the operator's own credential onto disk for any
// agent to read). They work when `mullion mcp` is run directly with
// MULLION_AUTH_TOKEN set. get_scrollback (defaults to the caller's own
// session), list_actions (defaults to the caller's own project) and
// request_review / review_status / stop_review (always the caller's own
// session's PR and runs) are reachable at session scope too.

const listSessions = {
  name: "list_sessions",
  description:
    "List Mullion sessions, optionally filtered by project or kind. Requires full scope " +
    "(MULLION_AUTH_TOKEN) — 403s from inside a normal agent session when authentication is " +
    "enabled (unrestricted if it's disabled entirely).",
  inputSchema: {
    type: "object",
    properties: {
      projectId: { type: "string", description: "Filter to sessions of this project." },
      kind: {
        type: "string",
        enum: ["terminal", "dock"],
        description: "Filter to sessions of this kind.",
      },
    },
  },
  async handler(args, client) {
    const result = await client.listSessions({ projectId: args?.projectId, kind: args?.kind });
    return JSON.stringify(result);
  },
};

const startDockSession = {
  name: "start_dock_session",
  description:
    "Start a persistent dock-panel session for a project's dock control (see list_actions/" +
    "projects.dock for available controls). Requires full scope (MULLION_AUTH_TOKEN) — 403s " +
    "from inside a normal agent session when authentication is enabled (unrestricted if it's " +
    "disabled entirely).",
  inputSchema: {
    type: "object",
    required: ["projectId", "dockControlId"],
    properties: {
      projectId: { type: "string", description: "The project to start the dock session for." },
      dockControlId: { type: "string", description: "The dock control's id (from projects.dock)." },
    },
  },
  async handler(args, client) {
    const result = await client.startDockSession(args?.projectId, args?.dockControlId);
    return JSON.stringify(result);
  },
};

const spawnChildSession = {
  name: "spawn_child_session",
  description:
    "Spawn a real child session (its own terminal, own PTY) of the calling session, in the " +
    "same project. Unlike start_dock_session/stop_dock_session, this works from inside a " +
    "normal agent session (session scope) — it does not require full scope. A hard cap on " +
    "live children per parent applies (settings.sessions.maxChildSessionsPerParent).",
  inputSchema: {
    type: "object",
    required: ["command"],
    properties: {
      command: {
        type: "string",
        description:
          "Shell command line to run, e.g. 'claude', 'bash'. Do NOT bake prompt text into " +
          "this string — use 'initialPrompt' below instead. Some agent CLIs (opencode in " +
          "particular) take a bare positional as a start directory, not a prompt, and will " +
          "fail to launch if you append prompt text here.",
      },
      name: { type: "string", description: "Optional cosmetic label for the new session." },
      cwd: {
        type: "string",
        description:
          "Optional working directory override. Must resolve inside the project's own " +
          "directory, OR be another directory git already lists as a worktree of the " +
          "project's own repo (e.g. a sibling '.mullion-worktrees/<name>' checkout) — " +
          "local projects only. Anything else is rejected.",
      },
      initialPrompt: {
        type: "string",
        description:
          "Optional first-turn prompt to submit to the child once it launches, delivered via " +
          "the agent CLI's own flag (e.g. opencode's '--prompt', Claude Code/Codex's " +
          "'-- <prompt>', agy's '-i='). Only takes effect when 'command' matches a known " +
          "agent CLI — the result's 'initialPromptApplied' field tells you whether it was " +
          "actually delivered; a plain shell command (e.g. 'bash') still launches, just " +
          "without the prompt.",
      },
      kind: {
        type: "string",
        enum: ["terminal", "dock"],
        description:
          "Defaults to 'terminal'. Only takes effect for a full-scope caller — silently " +
          "ignored from inside a normal agent session (session scope).",
      },
      skipPermissions: {
        type: "boolean",
        description:
          "Append the agent's skip-permissions flag. Defaults to false. Only takes effect " +
          "for a full-scope caller — silently ignored from inside a normal agent session " +
          "(session scope).",
      },
      parentSessionId: {
        type: "string",
        description:
          "The session to spawn a child of. Defaults to the calling session — normally " +
          "leave this unset. A session-scoped caller may only name its own session id here " +
          "(anything else is rejected); a full-scope caller may name any session.",
      },
      model: {
        type: "string",
        description:
          "Optional model override for the child session: opencode's provider/model, or " +
          "the bare --model value for a Claude Code, Codex, or agy command. When omitted " +
          "and parentSessionId is set, inherits the parent session's model (opencode only). " +
          "Ignored for any other command. An invalid value is rejected.",
      },
      smallModel: {
        type: "string",
        description:
          "Optional opencode small_model override for the child session. When omitted " +
          "and parentSessionId is set, inherits the parent session's smallModel. Only " +
          "honored when command resolves to an opencode adapter; ignored otherwise.",
      },
      open: {
        type: "string",
        enum: ["right", "below"],
        description:
          "Ask the dashboard to open the child's terminal panel next to yours ('right' of, " +
          "or 'below', your panel) so the human sees it without hunting. Only a hint: it " +
          "takes effect when the human has your panel open in their current workspace, and " +
          "is dropped otherwise (about a minute after the spawn).",
      },
    },
  },
  async handler(args, client) {
    if (args?.open !== undefined && args.open !== "right" && args.open !== "below") {
      throw new Error("open must be 'right' or 'below'");
    }
    const result = await client.spawnChildSession({
      command: args?.command,
      name: args?.name,
      cwd: args?.cwd,
      kind: args?.kind,
      initialPrompt: args?.initialPrompt,
      skipPermissions: args?.skipPermissions,
      parentSessionId: args?.parentSessionId,
      model: args?.model,
      smallModel: args?.smallModel,
      open: args?.open,
    });
    return JSON.stringify(result);
  },
};

const stopDockSession = {
  name: "stop_dock_session",
  description:
    "Stop a dock-panel (or any other) session by id. Requires full scope (MULLION_AUTH_TOKEN) " +
    "— 403s from inside a normal agent session when authentication is enabled (unrestricted " +
    "if it's disabled entirely).",
  inputSchema: {
    type: "object",
    required: ["sessionId"],
    properties: {
      sessionId: { type: "string", description: "The session id to kill." },
    },
  },
  async handler(args, client) {
    const result = await client.stopDockSession(args?.sessionId);
    return JSON.stringify(result);
  },
};

const listChildSessions = {
  name: "list_child_sessions",
  description:
    "List the child sessions the calling session spawned (live and exited) with their derived " +
    "status (e.g. working, finished, awaiting_permission, exited). Works from inside a normal " +
    "agent session (session scope). Use it after spawn_child_session to see what each child is " +
    "doing; read a child's output with get_scrollback.",
  inputSchema: {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
        description:
          "The parent session whose children to list. Defaults to the calling session; naming " +
          "another session's id requires full scope (MULLION_AUTH_TOKEN).",
      },
    },
  },
  async handler(args, client) {
    const result = await client.listChildSessions(args?.sessionId);
    return JSON.stringify(result);
  },
};

/**
 * Shared by wait_for_session and prompt_session: `timeoutSeconds` (default 50
 * so a call fits an MCP tool-call budget; clamped to the server's 1 h max,
 * since a larger value would overflow the socket client's 32-bit setTimeout)
 * -> `timeoutMs`, and `until` passed through. A non-positive timeout is
 * rejected locally — it would otherwise reach the server's 400 or, with the
 * socket slack, fire the client timer first and surface as a misleading
 * "timed out waiting for a reply".
 */
function normalizeWaitArgs(args) {
  const seconds = typeof args?.timeoutSeconds === "number" ? args.timeoutSeconds : 50;
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error("timeoutSeconds must be a positive number");
  }
  return {
    until: args?.until,
    timeoutMs: Math.min(Math.round(seconds * 1000), WAIT_MAX_TIMEOUT_MS),
  };
}

const waitForSession = {
  name: "wait_for_session",
  description:
    "Block (server-side) until a child session you spawned needs attention — finished its turn, " +
    "is waiting on a permission/plan/question, hit an error, or exited — or until the timeout. " +
    "Returns {status, severity, detail, timedOut, eventSeq}. Prefer this to polling " +
    "list_child_sessions. The default timeout is 50s so it fits an MCP tool-call budget: on " +
    "timedOut:true just call it again. Pass the previous result's eventSeq as afterSeq to ignore " +
    "a status you've already seen. Session scope may only wait on its own children.",
  inputSchema: {
    type: "object",
    required: ["sessionId"],
    properties: {
      sessionId: { type: "string", description: "The child session id to wait on." },
      until: {
        type: "array",
        items: { type: "string" },
        description:
          "Statuses (e.g. 'finished', 'awaiting_permission', 'exited') and/or severities " +
          "('done','blocked','waiting','failed','gone','busy','dormant') to stop at. Default: " +
          "done, blocked, waiting, failed, gone.",
      },
      timeoutSeconds: {
        type: "number",
        description: "Max seconds to wait (default 50, max 3600).",
      },
      afterSeq: {
        type: "number",
        description: "Only match once the session has emitted an event newer than this seq.",
      },
    },
  },
  async handler(args, client) {
    if (typeof args?.sessionId !== "string" || args.sessionId.length === 0) {
      throw new Error("sessionId is required");
    }
    const { until, timeoutMs } = normalizeWaitArgs(args);
    // Same local check as the CLI's --after-seq (saves a round trip and the
    // server's raw 400).
    if (
      args.afterSeq !== undefined &&
      (typeof args.afterSeq !== "number" || !Number.isInteger(args.afterSeq) || args.afterSeq < 0)
    ) {
      throw new Error("afterSeq must be a non-negative integer");
    }
    const result = await client.waitForSession({
      sessionId: args.sessionId,
      until,
      timeoutMs,
      afterSeq: args.afterSeq,
    });
    return JSON.stringify(result);
  },
};

const waitForOutput = {
  name: "wait_for_output",
  description:
    "Block (server-side) until a child session you spawned prints some text, or the timeout. " +
    "Returns {matched, text, line, outputOffset} on a match, {matched:false, timedOut:true} or " +
    "{matched:false, gone:true} (the child exited). `match` is a literal substring unless " +
    "regex:true (then no backreferences/lookarounds or nested quantifiers; max 256 chars). It " +
    "matches ANSI-stripped output (last 16 KiB window). To catch output a prompt_session just " +
    "provoked, pass that call's outputOffset as afterOffset — otherwise only output from now on " +
    "counts. Default timeout 50s: on timedOut:true just call it again. Session scope may only " +
    "wait on its own children.",
  inputSchema: {
    type: "object",
    required: ["sessionId", "match"],
    properties: {
      sessionId: { type: "string", description: "The child session id to watch." },
      match: { type: "string", description: "Text to wait for (max 256 chars)." },
      regex: { type: "boolean", description: "Treat `match` as a regular expression." },
      afterOffset: {
        type: "number",
        description: "A previous prompt_session/wait_for_output outputOffset to start from.",
      },
      timeoutSeconds: {
        type: "number",
        description: "Max seconds to wait (default 50, max 3600).",
      },
    },
  },
  async handler(args, client) {
    if (typeof args?.sessionId !== "string" || args.sessionId.length === 0) {
      throw new Error("sessionId is required");
    }
    if (typeof args.match !== "string" || args.match.length === 0) {
      throw new Error("match is required");
    }
    if (args.regex !== undefined && typeof args.regex !== "boolean") {
      throw new Error("regex must be a boolean");
    }
    if (
      args.afterOffset !== undefined &&
      (typeof args.afterOffset !== "number" ||
        !Number.isInteger(args.afterOffset) ||
        args.afterOffset < 0)
    ) {
      throw new Error("afterOffset must be a non-negative integer");
    }
    const { timeoutMs } = normalizeWaitArgs(args);
    const result = await client.waitForOutput({
      sessionId: args.sessionId,
      match: args.match,
      regex: args.regex,
      timeoutMs,
      afterOffset: args.afterOffset,
    });
    return JSON.stringify(result);
  },
};

const promptSession = {
  name: "prompt_session",
  description:
    "Type a prompt into a child session you spawned (Claude Code, Codex or opencode) and submit " +
    "it as a new turn — the way to give a worker a follow-up after spawn_child_session. With " +
    "wait:true it then blocks server-side until the child's turn ends (finished, or it needs a " +
    "permission/plan/question answer, errored, or exited) and returns the wait result alongside " +
    "{delivered, submitted, outputOffset} (pass outputOffset to wait_for_output as afterOffset); on wait.timedOut:true call wait_for_session to keep waiting. " +
    "Refused with 409 `agent_blocked` while the child is waiting on a dialog (typing would " +
    "answer it — resolve that first), 409 `agent_busy` if you pass wait:true while the child is " +
    "mid-turn (prompt without wait to queue the message, or wait_for_session first), and 501 for " +
    "a shell or unsupported agent. Session scope " +
    "may only prompt its own children. Text is limited to 32 KB; control characters are dropped.",
  inputSchema: {
    type: "object",
    required: ["sessionId", "text"],
    properties: {
      sessionId: { type: "string", description: "The child session id to prompt." },
      text: { type: "string", description: "The prompt to submit (max 32 KB)." },
      submit: {
        type: "boolean",
        description: "Press Enter after typing (default true). false only pastes the text.",
      },
      wait: {
        type: "boolean",
        description: "Block until the child's turn ends (default false). Requires submit.",
      },
      until: {
        type: "array",
        items: { type: "string" },
        description: "With wait: statuses/severities to stop at (see wait_for_session).",
      },
      timeoutSeconds: {
        type: "number",
        description: "With wait: max seconds to wait (default 50, max 3600).",
      },
    },
  },
  async handler(args, client) {
    if (typeof args?.sessionId !== "string" || args.sessionId.length === 0) {
      throw new Error("sessionId is required");
    }
    if (typeof args.text !== "string" || args.text.trim().length === 0) {
      throw new Error("text is required");
    }
    if (args.submit !== undefined && typeof args.submit !== "boolean") {
      throw new Error("submit must be a boolean");
    }
    if (args.wait !== undefined && typeof args.wait !== "boolean") {
      throw new Error("wait must be a boolean");
    }
    if (args.wait === true && args.submit === false) {
      throw new Error("wait cannot be combined with submit:false");
    }
    const result = await client.promptSession({
      sessionId: args.sessionId,
      text: args.text,
      submit: args.submit,
      wait: args.wait === true ? normalizeWaitArgs(args) : undefined,
    });
    return JSON.stringify(result);
  },
};

const killChildSession = {
  name: "kill_child_session",
  description:
    "Kill a child session the calling session spawned. Session scope may only name its own " +
    "children — naming itself, a sibling or an unrelated session is rejected with 403.",
  inputSchema: {
    type: "object",
    required: ["sessionId"],
    properties: {
      sessionId: { type: "string", description: "The child session id to kill." },
    },
  },
  async handler(args, client) {
    if (typeof args?.sessionId !== "string" || args.sessionId.length === 0) {
      throw new Error("sessionId is required");
    }
    await client.killChildSession(args.sessionId);
    return JSON.stringify({ killed: args.sessionId });
  },
};

const getScrollback = {
  name: "get_scrollback",
  description:
    "Get a session's terminal scrollback, decoded as text. Omit sessionId to get the calling " +
    "session's own scrollback; a child session the caller spawned (see list_child_sessions) can " +
    "be named too, from inside a normal agent session. Any other session's id requires full " +
    "scope (MULLION_AUTH_TOKEN).",
  inputSchema: {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
        description: "The session id to read. Defaults to the calling session.",
      },
    },
  },
  async handler(args, client) {
    // sessions.scrollback's result is `{ b64 }` (control-socket.ts) — decode
    // it here rather than returning the raw base64, the same
    // Buffer.from(result.b64, "base64") step `mullion session logs`
    // (src/cli/core.mjs) does before ever showing it to anything.
    const result = await client.getScrollback(args?.sessionId);
    const b64 = typeof result?.b64 === "string" ? result.b64 : "";
    return Buffer.from(b64, "base64").toString("utf8");
  },
};

const requestReview = {
  name: "request_review",
  description:
    "Ask the Mullion server to request an automated Hermes review of this session's pull " +
    "request. Reachable from inside a normal agent session (session scope). The review is " +
    "dispatched asynchronously and posts to the PR as the review bot within a few minutes; " +
    "the result carries a runId. " +
    REVIEW_PROTOCOL_NOTE +
    " Omit pr_number to use the open PR for the session's current branch. Fails with a clear " +
    "message if the relay isn't configured in Mullion's Settings → Integrations or no PR " +
    "exists yet. A commit that has ALREADY been reviewed is refused (409): there is nothing " +
    "new to review, so push a new commit to ask for another round, or dismiss that review " +
    "first. Use this for a re-review after pushing fixes; a newly opened PR is reviewed " +
    "automatically.",
  inputSchema: {
    type: "object",
    properties: {
      pr_number: {
        type: "integer",
        minimum: 1,
        description: "PR number to review. Defaults to the open PR for the current branch.",
      },
    },
  },
  async handler(args, client) {
    const result = await client.requestReview(args?.pr_number);
    return JSON.stringify(result);
  },
};

const reviewStatus = {
  name: "review_status",
  description:
    "Check a review requested with request_review: returns the run's Hermes status " +
    "(queued, running, stopping, completed, failed, cancelled, interrupted, unknown, not_found), the review " +
    "bot's reply or error, and whether the bot's review actually landed on the PR — including the " +
    "review's own text and a link to it. Call it ONCE, about ten minutes after requesting: a " +
    "review takes 10-30 minutes, and this is not a poll loop — a second request_review while " +
    "one is in flight is refused, and asking again anyway is what used to queue a second " +
    "review behind the first. " +
    "Omit pr_number to use the open PR for the session's current branch. not_found means " +
    "this Mullion has no run for the PR (never requested here, or the server restarted); unknown means Hermes answered with something unreadable — retry later.",
  inputSchema: {
    type: "object",
    properties: {
      pr_number: {
        type: "integer",
        minimum: 1,
        description: "PR number. Defaults to the open PR for the current branch.",
      },
    },
  },
  async handler(args, client) {
    return JSON.stringify(await client.reviewStatus(args?.pr_number));
  },
};

const stopReview = {
  name: "stop_review",
  description:
    "Stop a review run that this session started with request_review (pass its runId). " +
    "Runs started by other sessions are refused. Stopping is rarely needed — use it only for " +
    "a review that is stuck or was requested by mistake. Also stops a triage run this session " +
    "started with request_triage.",
  inputSchema: {
    type: "object",
    properties: {
      run_id: { type: "string", description: "The runId returned by request_review." },
    },
    required: ["run_id"],
  },
  async handler(args, client) {
    return JSON.stringify(await client.stopReview(args?.run_id));
  },
};

const requestTriage = {
  name: "request_triage",
  description:
    "Ask the Mullion server to relay an automated Hermes triage of an issue in this " +
    "session's repository. Reachable from inside a normal agent session (session scope). The " +
    "triage is dispatched asynchronously and posts its findings as a comment on the issue — " +
    "wait for it rather than requesting again (the result carries a runId; use triage_status " +
    "only to troubleshoot a triage that never shows up). One triage per issue at a time: a " +
    "request while one is running is refused with the run id of the triage that is already " +
    "working — that refusal is the answer, not an error to retry: wait for it, or stop it with " +
    "stop_review (it stops a triage run too). A repeat request for the same issue is also " +
    "refused for a cooldown period. " +
    "Fails with a clear message if the relay isn't configured in Mullion's Settings → " +
    "Integrations or the issue does not exist. The result may carry a warning when the issue " +
    "is closed — the request still goes through.",
  inputSchema: {
    type: "object",
    properties: {
      issue_number: {
        type: "integer",
        minimum: 1,
        description: "The issue number to triage, in this session's repository.",
      },
    },
    required: ["issue_number"],
  },
  async handler(args, client) {
    return JSON.stringify(await client.requestTriage(args?.issue_number));
  },
};

const triageStatus = {
  name: "triage_status",
  description:
    "Troubleshoot a triage requested with request_triage: returns the run's Hermes status " +
    "(queued, running, stopping, completed, failed, cancelled, interrupted, unknown, " +
    "not_found), the triage bot's reply or error, and whether its comment actually landed on " +
    "the issue — including the comment's text and a link to it. Use it when a requested triage " +
    "has not appeared after several minutes — not to poll in a loop. not_found means this " +
    "Mullion has no run for the issue (never requested here, or the server restarted).",
  inputSchema: {
    type: "object",
    properties: {
      issue_number: {
        type: "integer",
        minimum: 1,
        description: "The issue number the triage was requested for.",
      },
    },
    required: ["issue_number"],
  },
  async handler(args, client) {
    return JSON.stringify(await client.triageStatus(args?.issue_number));
  },
};

const listProjects = {
  name: "list_projects",
  description:
    "List registered Mullion projects. Requires full scope (MULLION_AUTH_TOKEN) — 403s from " +
    "inside a normal agent session when authentication is enabled (unrestricted if it's " +
    "disabled entirely).",
  inputSchema: { type: "object", properties: {} },
  async handler(_args, client) {
    const result = await client.listProjects();
    return JSON.stringify(result);
  },
};

const listActions = {
  name: "list_actions",
  description:
    "List a project's launcher actions and dock controls. Omit projectId to use the calling " +
    "session's own project (works from inside a normal agent session).",
  inputSchema: {
    type: "object",
    properties: {
      projectId: {
        type: "string",
        description: "The project id to query. Defaults to the calling session's own project.",
      },
    },
  },
  async handler(args, client) {
    const result = await client.listActions(args?.projectId);
    return JSON.stringify(result);
  },
};

const createPreview = {
  name: "create_preview",
  description:
    "Create a browser preview for a project's dev server, or for an arbitrary external URL. " +
    "Exactly one of projectId or url is required. Requires full scope (MULLION_AUTH_TOKEN) — " +
    "403s from inside a normal agent session when authentication is enabled (unrestricted if " +
    "it's disabled entirely).",
  inputSchema: {
    type: "object",
    properties: {
      projectId: {
        type: "string",
        description: "Create a preview for this project's dev server. Mutually exclusive with url.",
      },
      url: {
        type: "string",
        description: "Create a preview for this external URL. Mutually exclusive with projectId.",
      },
    },
  },
  async handler(args, client) {
    // The projectId/url mutual-exclusivity rule is enforced by
    // client.createPreview itself (client.mjs) — not re-checked here, so
    // there's exactly one place that rule can drift from.
    const projectId = typeof args?.projectId === "string" ? args.projectId : undefined;
    const url = typeof args?.url === "string" ? args.url : undefined;
    const result = await client.createPreview({ projectId, url });
    return JSON.stringify(result);
  },
};

const deletePreview = {
  name: "delete_preview",
  description:
    "Delete a browser preview by slug. Requires full scope (MULLION_AUTH_TOKEN) — 403s from " +
    "inside a normal agent session when authentication is enabled (unrestricted if it's " +
    "disabled entirely).",
  inputSchema: {
    type: "object",
    required: ["slug"],
    properties: {
      slug: { type: "string", description: "The preview slug to delete." },
    },
  },
  async handler(args, client) {
    const result = await client.deletePreview(args?.slug);
    return JSON.stringify(result);
  },
};

const listPreviews = {
  name: "list_previews",
  description:
    "List all registered Mullion browser previews. Requires full scope (MULLION_AUTH_TOKEN) — " +
    "403s from inside a normal agent session when authentication is enabled (unrestricted if " +
    "it's disabled entirely).",
  inputSchema: { type: "object", properties: {} },
  async handler(_args, client) {
    return JSON.stringify(await client.listPreviews());
  },
};

const getProjectTooling = {
  name: "get_project_tooling",
  description:
    "Get a project's Mullion tooling configuration (briefing, skill, reviewer agent). " +
    "Omit projectId to use the calling session's own project (works from inside a normal " +
    "agent session).",
  inputSchema: {
    type: "object",
    properties: {
      projectId: {
        type: "string",
        description: "The project id. Defaults to the calling session's own project.",
      },
    },
  },
  async handler(args, client) {
    const result = await client.getProjectTooling(args?.projectId);
    return JSON.stringify(result);
  },
};

const setProjectTooling = {
  name: "set_project_tooling",
  description:
    "Set a project's Mullion tooling configuration. Only provided fields are updated " +
    "(partial update). Requires full scope (MULLION_AUTH_TOKEN) — 403s from inside a " +
    "normal agent session when authentication is enabled. On a partial-failure upsert " +
    "(any supplied field's PUT returns ok:false, e.g. an oversized briefing or a skill " +
    "that fails frontmatter validation), this tool surfaces a generic tool-level error — " +
    "per-field diagnostics are not exposed through this tool. If a partial-failure caller " +
    "needs to know which field rejected and why, use the CLI instead: " +
    "`mullion project tooling <id> --briefing ... --skill ...` prints the full reply, " +
    "including the per-field ok/status/error for any field that failed.",
  inputSchema: {
    type: "object",
    required: ["projectId"],
    properties: {
      projectId: { type: "string", description: "The project id." },
      briefing: {
        type: "string",
        description: "The project briefing text. Omit to leave unchanged.",
      },
      skill: {
        type: "string",
        description:
          "The project skill content (YAML frontmatter + body). Omit to leave unchanged.",
      },
      reviewerAgent: {
        type: "string",
        description:
          "The project reviewer subagent content (YAML frontmatter + body). Omit to leave unchanged.",
      },
    },
  },
  async handler(args, client) {
    const result = await client.setProjectTooling({
      projectId: args?.projectId,
      briefing: args?.briefing,
      skill: args?.skill,
      reviewerAgent: args?.reviewerAgent,
    });
    return JSON.stringify(result);
  },
};

// device.* ops (control-socket.ts) are reachable at session scope with no
// full-scope requirement — unlike list_sessions/list_projects above, these
// work from inside a normal agent session, closing the "verify your own UI
// change" loop the whole device panel feature exists for. `deviceId` is
// always required (see control-socket.ts's own comment on why there's no
// "omit it, target your own" default the way get_scrollback has).
// `delete_device` is the one exception (full scope only, irreversibly drops
// the row) — see its own definition below.
const listDevices = {
  name: "list_devices",
  description:
    "List Mullion-managed Android devices (emulators/physical, see the device panel), " +
    "with each device's DB row and live status merged.",
  inputSchema: { type: "object", properties: {} },
  async handler(_args, client) {
    return JSON.stringify(await client.listDevices());
  },
};

const useDevice = {
  name: "use_device",
  description:
    "Execute a one-shot Android device action (screenshot, tap, swipe, text, key, logcat, " +
    "clipboard) against the device's live adb/scrcpy connection — works independently of " +
    "whether the device's video panel is currently open in the dashboard. Use list_devices " +
    "to find a deviceId first.",
  inputSchema: {
    type: "object",
    required: ["deviceId", "action"],
    properties: {
      deviceId: { type: "string", description: "The device's row id, from list_devices." },
      action: {
        type: "string",
        enum: ["screenshot", "tap", "swipe", "text", "key", "logcat", "clipboard"],
        description: "The device action to execute.",
      },
      x: {
        type: "number",
        description: "X coordinate, screen pixels — same space as screenshot (tap).",
      },
      y: {
        type: "number",
        description: "Y coordinate, screen pixels — same space as screenshot (tap).",
      },
      x1: {
        type: "number",
        description: "Start X, screen pixels — same space as screenshot (swipe).",
      },
      y1: {
        type: "number",
        description: "Start Y, screen pixels — same space as screenshot (swipe).",
      },
      x2: {
        type: "number",
        description: "End X, screen pixels — same space as screenshot (swipe).",
      },
      y2: {
        type: "number",
        description: "End Y, screen pixels — same space as screenshot (swipe).",
      },
      durationMs: { type: "number", description: "Swipe duration in milliseconds (swipe)." },
      text: {
        type: "string",
        description: "Text to type (text), or the text to place on the clipboard (clipboard set).",
      },
      androidKeyCode: {
        type: "number",
        description: "AOSP KEYCODE_* numeric value to send (key).",
      },
      lines: { type: "number", description: "Number of trailing log lines to return (logcat)." },
      filter: {
        type: "string",
        description: "logcat filter expression, e.g. 'MyApp:D *:S' (logcat).",
      },
      op: {
        type: "string",
        enum: ["get", "set"],
        description:
          "clipboard sub-operation (clipboard). 'get' returns the last-known device " +
          "clipboard text from a cache — never a live round-trip to the device, which scrcpy " +
          "only supports with clipboard autosync disabled (Mullion runs with it enabled). " +
          "'set' writes `text` to the device clipboard via the scrcpy control channel.",
      },
      paste: {
        type: "boolean",
        description:
          "Also simulate a paste action after setting the clipboard (clipboard set). " +
          "Defaults to false — set without pasting.",
      },
    },
  },
  async handler(args, client) {
    const { deviceId, ...actionPayload } = args ?? {};
    if (!deviceId) throw new Error("deviceId is required");
    return JSON.stringify(await client.deviceAction(deviceId, actionPayload));
  },
};

const deviceAction = { ...useDevice, name: "device_action" };

// Lifecycle trio, one shared `deviceId` schema for the lot. `start`/`stop`
// inherit the session-scope reachability the block above argues for (both
// reversible — a stop leaves the row, a start is its own inverse);
// `delete_device` is the exception that keeps proving the rule, its op is
// full-scope only, same blast-radius reasoning as device.pair.
const deviceIdProperty = { type: "string", description: "The device's row id, from list_devices." };

const startDevice = {
  name: "start_device",
  description:
    "Start a Mullion-managed Android device (spawn the emulator, reconnect the phone, or " +
    "resume a scope that survived a restart) and flip its row back to active. No-op-ish when " +
    "it is already running. Use list_devices to find a deviceId first.",
  inputSchema: {
    type: "object",
    required: ["deviceId"],
    properties: { deviceId: deviceIdProperty },
  },
  async handler(args, client) {
    const { deviceId } = args ?? {};
    if (!deviceId) throw new Error("deviceId is required");
    return JSON.stringify(await client.startDevice(deviceId));
  },
};

const stopDevice = {
  name: "stop_device",
  description:
    "Stop a Mullion-managed Android device's stream/process, leaving its row in place so it " +
    "can be started again. Unlike delete_device this is reversible. Use list_devices to find " +
    "a deviceId first.",
  inputSchema: {
    type: "object",
    required: ["deviceId"],
    properties: { deviceId: deviceIdProperty },
  },
  async handler(args, client) {
    const { deviceId } = args ?? {};
    if (!deviceId) throw new Error("deviceId is required");
    return JSON.stringify(await client.terminateDevice(deviceId));
  },
};

const deleteDevice = {
  name: "delete_device",
  description:
    "IRREVERSIBLY remove a Mullion-managed Android device's row after tearing it down — the " +
    "device disappears from every list. Prefer stop_device when the device may come back. " +
    "Full-scope only; use list_devices to find a deviceId first.",
  inputSchema: {
    type: "object",
    required: ["deviceId"],
    properties: { deviceId: deviceIdProperty },
  },
  async handler(args, client) {
    const { deviceId } = args ?? {};
    if (!deviceId) throw new Error("deviceId is required");
    return JSON.stringify(await client.deleteDevice(deviceId));
  },
};

const reportStatus = {
  name: "report_status",
  description:
    "Report this session's own state to Mullion — for agents whose CLI has no Mullion hook " +
    "adapter, so a parent's wait_for_session and the dashboard can tell when you are working, " +
    "done, or need a human. `working` when you start a task (clears a previous `done`; it is a " +
    "one-shot signal, not a sticky state), `done` when you finish it, `needs_input` when you are " +
    "blocked on a person.",
  inputSchema: {
    type: "object",
    required: ["state"],
    properties: {
      state: { type: "string", enum: SELF_REPORT_STATES },
      message: {
        type: "string",
        description:
          "Short note (max 200 chars, longer is cut): what finished, or what you need. Ignored for `working`.",
      },
    },
  },
  async handler(args, client) {
    const state = typeof args?.state === "string" ? args.state : "";
    if (!SELF_REPORT_STATES.includes(state)) {
      throw new Error(`state must be one of ${SELF_REPORT_STATES.join(", ")}`);
    }
    await client.reportStatus(state, typeof args?.message === "string" ? args.message : undefined);
    // `working` ignores the message, so there is nothing to have truncated.
    return `status reported: ${state}${state === "working" ? "" : statusTruncationNote(args?.message)}`;
  },
};

export const TOOLS = [
  promoteToWorktree,
  reportStatus,
  useBrowser,
  browserAction,
  listDevices,
  useDevice,
  deviceAction,
  startDevice,
  stopDevice,
  deleteDevice,
  listSessions,
  startDockSession,
  spawnChildSession,
  listChildSessions,
  waitForSession,
  waitForOutput,
  promptSession,
  killChildSession,
  stopDockSession,
  getScrollback,
  requestReview,
  reviewStatus,
  stopReview,
  requestTriage,
  triageStatus,
  listProjects,
  listActions,
  createPreview,
  deletePreview,
  listPreviews,
  getProjectTooling,
  setProjectTooling,
];
