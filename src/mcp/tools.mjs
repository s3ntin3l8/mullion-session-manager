// Issue #271 — the `mullion mcp` tool registry (the extension point issue
// #134 builds on: adding a tool later is appending an entry here, never
// touching server.mjs's dispatch loop). Each entry is
// `{ name, description, inputSchema, handler(args, client) }` — `handler`
// returns a plain string (wrapped into MCP's `content: [{type:"text",...}]`
// shape by server.mjs) or throws, which server.mjs turns into a tool-level
// `isError: true` result rather than a protocol-level failure.

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
// session) and list_actions (defaults to the caller's own project) are
// reachable at session scope too.

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
      command: { type: "string", description: "Shell command line to run, e.g. 'claude', 'bash'." },
      name: { type: "string", description: "Optional cosmetic label for the new session." },
      cwd: {
        type: "string",
        description:
          "Optional working directory override. Must resolve inside the project's own " +
          "directory — a path outside it is rejected.",
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
    },
  },
  async handler(args, client) {
    const result = await client.spawnChildSession({
      command: args?.command,
      name: args?.name,
      cwd: args?.cwd,
      kind: args?.kind,
      skipPermissions: args?.skipPermissions,
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

const getScrollback = {
  name: "get_scrollback",
  description:
    "Get a session's terminal scrollback, decoded as text. Omit sessionId to get the calling " +
    "session's own scrollback (works from inside a normal agent session); targeting another " +
    "session's id requires full scope (MULLION_AUTH_TOKEN).",
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

export const TOOLS = [
  promoteToWorktree,
  useBrowser,
  browserAction,
  listSessions,
  startDockSession,
  spawnChildSession,
  stopDockSession,
  getScrollback,
  listProjects,
  listActions,
  createPreview,
  deletePreview,
  listPreviews,
];
