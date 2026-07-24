import net from "node:net";

// Issue #271 — the transport half of the `mullion mcp` server (issue #134's
// eventual CLI/MCP surface starts here): a thin client wrapping however a
// tool handler actually reaches Mullion. Today the only method is
// `promoteRequest`, which reuses the existing hook socket
// (MULLION_HOOK_SOCKET/MULLION_HOOK_TOKEN — the same channel
// src/hooks/forwarder.mjs already speaks) rather than opening a new
// transport. #134's later tools (start_dock_session, list_sessions,
// create_preview, …) will add HTTP methods here, authenticated via
// MULLION_API_URL/MULLION_TOKEN instead — tool handlers call this class,
// never a socket or fetch() directly, so that addition doesn't touch
// server.mjs's dispatch loop or any existing tool's handler.

const PROMOTE_TIMEOUT_MS = 295_000;

export class MullionClient {
  constructor(env = process.env) {
    this.hookSocketPath = env.MULLION_HOOK_SOCKET;
    this.hookToken = env.MULLION_HOOK_TOKEN;
  }

  /** Whether the hook-socket transport is configured at all — a tool
   * handler checks this before calling promoteRequest() so it can return a
   * clear tool-level error instead of a confusing connection failure when
   * this MCP server is somehow run outside a Mullion session. */
  isConfigured() {
    return (
      typeof this.hookSocketPath === "string" &&
      this.hookSocketPath.length > 0 &&
      typeof this.hookToken === "string" &&
      this.hookToken.length > 0
    );
  }

  /**
   * Sends a blocking `promote_request` (issue #271) over the hook socket —
   * same protocol hooks.ts's "promote_request" handling expects (see that
   * file's `handleConnection`). Resolves with the human's decision once
   * POST /api/sessions/:id/promote or .../promote/decline delivers one, or
   * with a declined decision on any transport failure/timeout — this
   * method never rejects, matching src/hooks/forwarder.mjs's runGate/
   * runSessionStart posture of "every path resolves to SOME outcome."
   */
  promoteRequest(summary, suggestedBaseRef) {
    return new Promise((resolve) => {
      if (!this.isConfigured()) {
        resolve({
          decision: "declined",
          reason: "MULLION_HOOK_SOCKET is not set — not running inside a Mullion session",
        });
        return;
      }

      const socket = net.createConnection(this.hookSocketPath);
      let settled = false;
      const finish = (decision) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(decision);
      };
      const timer = setTimeout(
        () => finish({ decision: "declined", reason: "timed out waiting for a decision" }),
        PROMOTE_TIMEOUT_MS,
      );

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
          finish({ decision: "declined", reason: "malformed decision" });
          return;
        }
        if (reply?.decision === "accepted") {
          finish({
            decision: "accepted",
            worktreePath: typeof reply.worktreePath === "string" ? reply.worktreePath : null,
            newSessionId: typeof reply.newSessionId === "number" ? reply.newSessionId : null,
          });
        } else {
          finish({
            decision: "declined",
            reason: typeof reply?.reason === "string" ? reply.reason : undefined,
          });
        }
      });
      socket.on("error", () => finish({ decision: "declined", reason: "connection error" }));
      socket.on("close", () => finish({ decision: "declined", reason: "connection closed" }));
      socket.once("connect", () => {
        socket.write(`${JSON.stringify({ token: this.hookToken })}\n`);
        socket.write(`${JSON.stringify({ kind: "promote_request", summary, suggestedBaseRef })}\n`);
      });
    });
  }
}
