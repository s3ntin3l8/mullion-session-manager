import net from "node:net";
import { MullionSocketClient } from "../cli/client.mjs";

// Issue #271 — the transport half of the `mullion mcp` server (issue #134's
// eventual CLI/MCP surface starts here): a thin client wrapping however a
// tool handler actually reaches Mullion. `promoteRequest`/`browserAction`
// reuse the existing hook socket (MULLION_HOOK_SOCKET/MULLION_HOOK_TOKEN —
// the same channel src/hooks/forwarder.mjs already speaks). #134 part 2's
// session/project/preview tools instead reuse the CONTROL socket via
// `MullionSocketClient` (src/cli/client.mjs) — same wire protocol, same
// resolveSocketPath/resolveToken discovery the `mullion` CLI itself uses, so
// there is exactly one implementation of that protocol in the repo. Every
// control-socket call opens a fresh connection and closes it when done
// (controlRequest below), matching this class's own existing per-call
// connect/destroy posture for the hook socket rather than holding one
// long-lived connection open for the MCP server's whole lifetime.
//
// Scope note (see docs/socket-api.md's per-scope op allowlist): most of the
// tools built on controlRequest below (list_sessions, start_dock_session,
// stop_dock_session, list_projects, create_preview, delete_preview,
// list_previews) call full-scope-only ops. A Claude Code session's
// auto-injected MCP config (buildClaudeMcpConfig, claude-code.ts) only ever
// carries the SESSION-scoped MULLION_HOOK_TOKEN as a control-socket
// credential too (resolveToken's fallback) — deliberately: injecting the
// full-scope MULLION_AUTH_TOKEN into a per-session config file would let any
// agent read its own full-scope credential straight off disk. So those tools
// 403 for a normal in-session agent by design, WHEN authentication is
// enabled; they're for a client that sets MULLION_AUTH_TOKEN itself (e.g.
// `mullion mcp` run directly by an operator, already supported since PR6).
// When auth is disabled entirely, every handshake resolves to full scope
// regardless (control-socket.ts's resolveHandshake) — not new to these
// tools, the existing socket-wide posture. get_scrollback (self only) and
// list_actions (own project) are the two tools that remain fully usable
// from inside a session.

const PROMOTE_TIMEOUT_MS = 295_000;
const BROWSER_ACTION_TIMEOUT_MS = 30_000;

export class MullionClient {
  constructor(env = process.env) {
    this.hookSocketPath = env.MULLION_HOOK_SOCKET;
    this.hookToken = env.MULLION_HOOK_TOKEN;
    this._env = env;
  }

  /** One-shot control-socket request: fresh MullionSocketClient, one
   * request, close. Rejects with a MullionSocketError (carrying the
   * REST-equivalent `status`) on `ok:false`, or a plain Error on a
   * transport failure — both are left to propagate to the caller, which
   * for every tool in tools.mjs means server.mjs's `handleToolsCall` turns
   * it into a tool-level `isError:true` with the error's own message, the
   * same posture as this class's other methods never throwing something
   * unhelpful. */
  async controlRequest(op, body) {
    const client = new MullionSocketClient({ env: this._env });
    try {
      return await client.request(op, body);
    } finally {
      client.close();
    }
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

  browserAction(actionPayload) {
    return new Promise((resolve) => {
      if (!this.isConfigured()) {
        resolve({
          error: "MULLION_HOOK_SOCKET is not set — not running inside a Mullion session",
        });
        return;
      }

      const socket = net.createConnection(this.hookSocketPath);
      let settled = false;

      const timer = setTimeout(() => {
        finish({ error: "timed out waiting for browser action response" });
      }, BROWSER_ACTION_TIMEOUT_MS);

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(result);
      };

      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) return;
        const line = buffer.slice(0, newlineIndex);
        try {
          const reply = JSON.parse(line);
          finish(reply);
        } catch {
          finish({ error: "malformed response from browser action" });
        }
      });
      socket.on("error", () => finish({ error: "connection error" }));
      socket.on("close", () => finish({ error: "connection closed" }));
      socket.once("connect", () => {
        socket.write(`${JSON.stringify({ token: this.hookToken })}\n`);
        socket.write(`${JSON.stringify({ kind: "browser_action", ...actionPayload })}\n`);
      });
    });
  }

  listSessions({ projectId, kind } = {}) {
    const body = {};
    if (projectId !== undefined) body.projectId = projectId;
    if (kind !== undefined) body.kind = kind;
    return this.controlRequest("sessions.list", body);
  }

  listProjects() {
    return this.controlRequest("projects.list", {});
  }

  listPreviews() {
    return this.controlRequest("previews.list", {});
  }

  // A bare positional arg here (and on stopDockSession/getScrollback/
  // deletePreview below), not an options object like listSessions/
  // createPreview — those two take more than one independent optional
  // field, everything else here takes exactly one.
  listActions(projectId) {
    return this.controlRequest("projects.actions", projectId !== undefined ? { projectId } : {});
  }

  /** Mirrors `mullion dock start`'s own two-step logic (src/cli/core.mjs):
   * resolve the project's dock controls, find the requested one by id, then
   * create a `kind:"dock"` session from its command/cwd. */
  async startDockSession(projectId, dockControlId) {
    const controls = await this.controlRequest("projects.dock", { projectId });
    const control = Array.isArray(controls)
      ? controls.find((candidate) => candidate.id === dockControlId)
      : undefined;
    if (!control) {
      throw new Error(`no dock control '${dockControlId}' for project ${projectId}`);
    }
    const body = { projectId, command: control.command, kind: "dock", name: control.title };
    if (control.cwd !== undefined) body.cwd = control.cwd;
    if (control.worktreeRefresh !== undefined) body.worktreeRefresh = control.worktreeRefresh;
    return this.controlRequest("sessions.create", body);
  }

  stopDockSession(sessionId) {
    return this.controlRequest("sessions.kill", { sessionId });
  }

  getScrollback(sessionId) {
    return this.controlRequest("sessions.scrollback", sessionId !== undefined ? { sessionId } : {});
  }

  /** `projectId`/`url` are mutually exclusive, same as `mullion preview
   * create` — self-guarding (not just validated by the caller, tools.mjs)
   * so this method is safe to call directly from anywhere, not only through
   * the create_preview tool's own handler. */
  async createPreview({ projectId, url }) {
    if (projectId === undefined && url === undefined) {
      throw new Error("one of projectId or url is required");
    }
    if (projectId !== undefined && url !== undefined) {
      throw new Error("projectId and url are mutually exclusive");
    }
    const body =
      projectId !== undefined ? { kind: "project", projectId } : { kind: "external", url };
    return this.controlRequest("previews.create", body);
  }

  deletePreview(slug) {
    return this.controlRequest("previews.delete", { slug });
  }
}
