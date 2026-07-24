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

export const TOOLS = [promoteToWorktree];
