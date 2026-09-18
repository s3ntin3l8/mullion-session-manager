import net from "node:net";
import { MullionSocketClient, MullionSocketError } from "../cli/client.mjs";

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
// from inside a session. spawn_child_session (Phase 5, issue #193 5.3b)
// joins that short list, and is the first of the two that CREATES a
// session rather than just reading one — sessions.spawn_child is
// deliberately session-scope-reachable (see control-socket.ts's own
// comment), unlike sessions.create above it. Staying "fully usable" on an
// auth-disabled host specifically relies on ownSessionId's env fallback
// below (issue #1291): full scope has no connection-level pin to resolve
// "self" from, so without that fallback all three would 400 on the exact
// omit-it-to-target-yourself usage this paragraph describes.

const PROMOTE_TIMEOUT_MS = 295_000;
const BROWSER_ACTION_TIMEOUT_MS = 30_000;

/** Issue #1291 (Hermes review, PR #1292) — true only for the exact
 * "no pin to resolve this id from" 400 a given op's resolve* helper
 * (control-socket.ts) produces when its id is omitted and the connection
 * has no session-scoped pin (full scope). Narrower than "any 400", so an
 * unrelated failure (e.g. a genuinely bad explicit id) propagates as
 * itself instead of triggering a same-shaped but unrelated retry. */
function isMissingIdError(err, message) {
  return err instanceof MullionSocketError && err.status === 400 && err.message === message;
}

export class MullionClient {
  constructor(env = process.env) {
    this.hookSocketPath = env.MULLION_HOOK_SOCKET;
    this.hookToken = env.MULLION_HOOK_TOKEN;
    this._env = env;
  }

  /** Issue #1291 — the calling session's own id (`MULLION_SESSION_ID`,
   * set in every spawned session's env by launch-plan.ts), used as a
   * client-side RETRY fallback (never an eager substitution — see
   * getScrollback/listActions/spawnChildSession below, all of which try
   * the direct, no-id request first) for "target the calling session/its
   * project" when the control socket can't resolve that from the
   * connection's own pin. `resolveHandshake` (control-socket.ts) collapses
   * every connection to full scope — no pinned session at all — whenever
   * auth is disabled entirely, which silently breaks the "omit it, get
   * your own" shape of those three methods on such a host even though
   * each is reachable at session scope by design. Trying the direct path
   * first (Hermes review, PR #1292) means a healthy session-scoped
   * connection never substitutes this at all, so a hypothetical
   * MULLION_SESSION_ID/pin mismatch can't turn a working call into a 403 —
   * only the exact "no pin" failure this issue targets triggers the
   * fallback. `undefined` when this MCP server isn't running as a
   * session's own subprocess (e.g. `mullion mcp` run directly by an
   * operator). */
  get ownSessionId() {
    const id = this._env.MULLION_SESSION_ID;
    return typeof id === "string" && id.length > 0 ? id : undefined;
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

  // device.* ops are reachable at session scope (control-socket.ts) with no
  // "omit it, target your own" fallback the way get_scrollback/list_actions
  // have — a device has no "belongs to this session" relationship to
  // default from (see that file's own comment on device.action), so
  // `deviceId` is always required here, unlike ownSessionId's retry
  // pattern below.
  listDevices() {
    return this.controlRequest("device.list", {});
  }

  getDevice(deviceId) {
    return this.controlRequest("device.get", { deviceId });
  }

  createDevice({ avdName, projectId, name }) {
    const body = { avdName };
    if (projectId !== undefined) body.projectId = projectId;
    if (name !== undefined) body.name = name;
    return this.controlRequest("device.create", body);
  }

  terminateDevice(deviceId) {
    return this.controlRequest("device.terminate", { deviceId });
  }

  deviceAction(deviceId, actionPayload) {
    return this.controlRequest("device.action", { deviceId, ...actionPayload });
  }

  // A bare positional arg here (and on stopDockSession/getScrollback/
  // deletePreview below), not an options object like listSessions/
  // createPreview — those two take more than one independent optional
  // field, everything else here takes exactly one.
  /** Issue #1291 — when `projectId` is omitted, tries the empty body first
   * (the control socket's own pin resolves it directly at real session
   * scope — resolveTargetProjectId, control-socket.ts — with no extra
   * round trip and no risk of diverging from that pin's own source of
   * truth). Only on the specific "no pin to fall back on" 400 (full scope,
   * which is what an auth-disabled host forces on every connection) does
   * this fall back to a `sessions.get` lookup of its own session
   * (`ownSessionId`) to derive a project id to retry with — no
   * `MULLION_PROJECT_ID` env var exists to shortcut this the way
   * getScrollback/spawnChildSession do for a session id, since a
   * session's project lives on its own row, not its env. (Hermes review,
   * PR #1292 — an earlier version of this fix always did the lookup,
   * which could diverge from the pin's own `app.pty.get()`-sourced
   * projectId if the REST-backed row and in-memory pty state ever
   * disagreed; trying the direct path first removes that risk entirely
   * for the already-working case.) */
  async listActions(projectId) {
    if (projectId !== undefined) {
      return this.controlRequest("projects.actions", { projectId });
    }
    try {
      return await this.controlRequest("projects.actions", {});
    } catch (err) {
      if (!isMissingIdError(err, "'projectId' is required") || this.ownSessionId === undefined) {
        throw err;
      }
      // Hermes review, PR #1292 — the lookup itself can fail (e.g.
      // MULLION_SESSION_ID names a stale/deleted session); that failure
      // must never mask the canonical "'projectId' is required" this
      // whole branch exists to recover from, so it's swallowed in favor
      // of rethrowing `err`.
      let session;
      try {
        session = await this.controlRequest("sessions.get", { sessionId: this.ownSessionId });
      } catch {
        throw err;
      }
      const ownProjectId = (session ?? {}).projectId;
      if (ownProjectId === undefined || ownProjectId === null) throw err;
      return this.controlRequest("projects.actions", { projectId: String(ownProjectId) });
    }
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
    // A docker-sourced control's own stable identity (dockHelpers.ts's
    // dockerSessionIdentity — this repo's own source of truth, since this
    // file can't import the frontend's TS helper) — `command` is
    // reconstructed fresh from live container labels on every discovery
    // poll and can change text without the underlying service having
    // changed, which would otherwise leave this session unmatched against
    // its own control (issue #73 follow-up plan, 5b) the same way a
    // command-string comparison already fails on the frontend. `nameLocked`
    // matches Dock.tsx's own identityOpts for the same control.
    const identity = control.docker ? `docker-logs:${control.docker.containerName}` : null;
    const body = {
      projectId,
      command: control.command,
      kind: "dock",
      name: identity ?? control.title,
      ...(identity ? { nameLocked: true } : {}),
    };
    if (control.cwd !== undefined) body.cwd = control.cwd;
    if (control.worktreeRefresh !== undefined) body.worktreeRefresh = control.worktreeRefresh;
    if (control.env !== undefined) body.env = control.env;
    return this.controlRequest("sessions.create", body);
  }

  stopDockSession(sessionId) {
    return this.controlRequest("sessions.kill", { sessionId });
  }

  /** Phase 5 (Track B, issue #193 5.3b) — spawns a real child session (own
   * PTY, own dtach socket) of `parentSessionId`, or of the calling session
   * itself when omitted, via the session-scoped connection's own pin.
   * Issue #1291 (Hermes review, PR #1292): only on the specific "no pin"
   * 400 (full scope, e.g. an auth-disabled host) does this retry with
   * `ownSessionId`'s env fallback — never substituted eagerly, so a
   * healthy session-scoped call never risks a hypothetical
   * MULLION_SESSION_ID/pin mismatch turning a working call into a 403 (see
   * ownSessionId's own doc comment). Unlike startDockSession/
   * stopDockSession/listSessions above, this is reachable from a Claude
   * Code session's own auto-injected MCP config: that config only ever
   * carries the session-scoped MULLION_HOOK_TOKEN, and spawn_child (unlike
   * sessions.create) accepts that scope by design. */
  async spawnChildSession({
    command,
    name,
    cwd,
    kind,
    initialPrompt,
    skipPermissions,
    parentSessionId,
    model,
    smallModel,
  } = {}) {
    const body = { command };
    if (name !== undefined) body.name = name;
    if (cwd !== undefined) body.cwd = cwd;
    if (kind !== undefined) body.kind = kind;
    // Sent as `seedPrompt`, not `initialPrompt` — POST /api/sessions (what
    // this control op ultimately forwards to) only accepts the former; the
    // route handler decides whether the command's hook adapter can turn it
    // into a real first-turn `initialPrompt` or must fall back to
    // context-only delivery. See routes/sessions.ts's createSessionSchema
    // and this same translation in its promote handler. Kept as
    // `initialPrompt` at the MCP-tool/client boundary because that's the
    // clearer name for an agent choosing to spawn a child — "seed" is
    // internal terminology carried over from the promote flow (see
    // task-agent-resolve.ts's own doc comment on why "seed" stuck).
    if (initialPrompt !== undefined) body.seedPrompt = initialPrompt;
    if (skipPermissions !== undefined) body.skipPermissions = skipPermissions;
    if (parentSessionId !== undefined) body.parentSessionId = parentSessionId;
    if (model !== undefined) body.model = model;
    if (smallModel !== undefined) body.smallModel = smallModel;
    try {
      return await this.controlRequest("sessions.spawn_child", body);
    } catch (err) {
      if (
        parentSessionId !== undefined ||
        !isMissingIdError(err, "'parentSessionId' is required") ||
        this.ownSessionId === undefined
      ) {
        throw err;
      }
      return this.controlRequest("sessions.spawn_child", {
        ...body,
        parentSessionId: this.ownSessionId,
      });
    }
  }

  /** Issue #1291 (Hermes review, PR #1292) — same "try direct, retry only
   * on the specific no-pin 400" shape as listActions/spawnChildSession
   * above; see ownSessionId's own doc comment for why. */
  async getScrollback(sessionId) {
    if (sessionId !== undefined) {
      return this.controlRequest("sessions.scrollback", { sessionId });
    }
    try {
      return await this.controlRequest("sessions.scrollback", {});
    } catch (err) {
      if (!isMissingIdError(err, "'sessionId' is required") || this.ownSessionId === undefined) {
        throw err;
      }
      return this.controlRequest("sessions.scrollback", { sessionId: this.ownSessionId });
    }
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

  getProjectTooling(projectId) {
    return this.controlRequest("projects.get_tooling", { projectId });
  }

  setProjectTooling({ projectId, briefing, skill, reviewerAgent }) {
    const body = { projectId };
    if (briefing !== undefined) body.briefing = briefing;
    if (skill !== undefined) body.skill = skill;
    if (reviewerAgent !== undefined) body.reviewerAgent = reviewerAgent;
    return this.controlRequest("projects.set_tooling", body);
  }
}
