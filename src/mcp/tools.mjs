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
    "starts in the worktree, seeded with `summary` as its starting context.",
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
    "Execute a browser automation action (navigate, click, fill, type, press, select, check, uncheck, hover, scroll, wait, dialog, get, screenshot, snapshot, console, errors, find).",
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

export const TOOLS = [promoteToWorktree, useBrowser, browserAction];
