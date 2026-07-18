import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import path from "node:path";
import { WebSocket as NodeWebSocket } from "ws";
import {
  discoverCandidates,
  expandHome,
  parseProjectsRootsEnv,
  resolveProjectActions,
  resolveProjectDock,
} from "../services/project-config.js";
import { parseGitRemote } from "../services/git-remote.js";
import { getCachedAgents } from "../services/agent-detect.js";
import { resolveGlobalPresets } from "./actions.js";
import { attachSocketToSession } from "./terminal.js";
import type { SessionInfo } from "../services/pty-manager.js";
import { buildUpstreamRequestHeaders, relayFetchResponse } from "../services/http-proxy.js";
import { pipeWsFrames, toWsUrl } from "../services/ws-pipe.js";

interface SpawnSessionBody {
  id: string;
  cwd: string;
  command: string;
  cols: number;
  rows: number;
}

interface LiveStatusBody {
  ids: string[];
  idleThresholdMs: number;
}

interface LivenessBody {
  ids: string[];
}

// A session id is always the primary's stringified integer row id
// (String(sessionId) — see terminal.ts/sessions.ts) by construction, but
// this schema is the agent's only defense against a malformed one: it flows
// straight into pty-manager.ts's scopeUnitName(id) -> `crs-session-<id>`,
// naming a real systemd --user scope and dtach socket file. An id with
// systemd- or filesystem-illegal characters (e.g. "/") wouldn't be an
// injection (spawn/stop always use an argv array, never a shell string),
// but would make bootstrap/terminate silently target the wrong unit/file.
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const SESSION_ID_SCHEMA = {
  type: "string",
  minLength: 1,
  pattern: SESSION_ID_PATTERN.source,
} as const;

const spawnSessionSchema = {
  body: {
    type: "object",
    required: ["id", "cwd", "command", "cols", "rows"],
    additionalProperties: false,
    properties: {
      id: SESSION_ID_SCHEMA,
      cwd: { type: "string", minLength: 1 },
      command: { type: "string", minLength: 1 },
      cols: { type: "integer", minimum: 1 },
      rows: { type: "integer", minimum: 1 },
    },
  },
};

const liveStatusSchema = {
  body: {
    type: "object",
    required: ["ids", "idleThresholdMs"],
    additionalProperties: false,
    properties: {
      ids: { type: "array", items: SESSION_ID_SCHEMA },
      idleThresholdMs: { type: "integer", minimum: 0 },
    },
  },
};

const livenessSchema = {
  body: {
    type: "object",
    required: ["ids"],
    additionalProperties: false,
    properties: {
      ids: { type: "array", items: SESSION_ID_SCHEMA },
    },
  },
};

const terminateSchema = {
  params: {
    type: "object",
    required: ["id"],
    properties: {
      id: SESSION_ID_SCHEMA,
    },
  },
};

// Not a public rate limit exemption — a distinct, higher ceiling. A primary
// polling this agent's bulk live-status/liveness endpoints at the reconcile
// cadence (a follow-up PR) is legitimate, frequent traffic from a single
// caller, unlike the public-facing default (security.ts's RATE_LIMIT_MAX,
// tuned for a browser). Still bounded, since the token alone doesn't prove
// the caller is well-behaved.
const INTERNAL_RATE_LIMIT = { config: { rateLimit: { max: 1000, timeWindow: "1 minute" } } };

/** Constant-time token compare — crypto.timingSafeEqual throws on unequal
 * lengths, so the length check that guards it is an unavoidable, accepted
 * side channel (the token's length, not its content) for a long random
 * shared secret; see src/plugins/env.ts's TESSERA_AGENT_TOKEN doc. */
function timingSafeTokenMatch(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

/**
 * Constrain a request-supplied cwd to this agent's own PROJECTS_ROOTS before
 * it reaches a filesystem read — the sole trust anchor a DB-less agent has,
 * and the same scope /internal/discover already surfaces. Returns the
 * resolved absolute path when `cwd` is one of (or a descendant of) a
 * configured root, else null. Without this, /internal/actions and
 * /internal/dock would read whatever `.crs/actions.json`/`.crs/dock.json`/
 * `package.json`/`.vscode/tasks.json` happens to exist at ANY path the
 * caller names — flagged by CodeQL as uncontrolled data in a path
 * expression (and, downstream, a log-injection sink in project-config.ts's
 * warn() calls) once these routes started passing a raw request query
 * param into project-config.ts's file reads.
 *
 * Deliberately NOT applied to /internal/sessions or /internal/ws/attach
 * (session spawn/attach) below: a session's cwd is the whole point of the
 * feature and, like the primary's own unrestricted POST /api/projects cwd,
 * isn't scoped to PROJECTS_ROOTS today — spawning a program is already
 * fully gated by the shared token, the same trust boundary a roots check
 * here wouldn't add anything to. This is a deliberate, narrower scope than
 * "every cwd-accepting route," not an oversight.
 */
function resolveWithinRoots(app: FastifyInstance, cwd: string): string | null {
  const resolved = path.resolve(expandHome(cwd));
  const roots = parseProjectsRootsEnv(app.config.PROJECTS_ROOTS).map((root) => path.resolve(root));
  const withinRoots = roots.some(
    (root) => resolved === root || resolved.startsWith(root + path.sep),
  );
  return withinRoots ? resolved : null;
}

// Same shape as projects.ts's DEV_SERVER_PORT_ONLY — a bare 1-65535 port,
// nothing else. Used for both /internal/preview/:port/* and
// /internal/ws/preview's ?port= (issue #28 phase 6).
const PORT_PATTERN = /^\d{1,5}$/;

function parsePort(value: string): number | null {
  if (!PORT_PATTERN.test(value)) return null;
  const port = Number(value);
  return port >= 1 && port <= 65535 ? port : null;
}

/**
 * Resolves a caller-supplied path+query (from the primary, ultimately
 * derived from a browser's preview request) against this agent's own
 * loopback dev server at `port` — and never anything else. This is the
 * whole security promise of this phase (see projects.ts's own
 * isValidDevServerUrl comment: "the preview proxy forces the connection to
 * the owning agent's own loopback"), so it's deliberately not just "parse
 * and trust": naively string-concatenating `pathAndQuery` into
 * `http://127.0.0.1:${port}${pathAndQuery}` (or its ws:// equivalent) is
 * bypassable — a network-path reference ("//evil.com/x") overrides the
 * host entirely, and a leading "@evil.com/" turns "127.0.0.1:<port>" into
 * HTTP userinfo with "evil.com" as the actual host — both confirmed via
 * `new URL()` directly, not just reasoned about. The fix: `pathAndQuery` is
 * first parsed *alone*, against a throwaway placeholder base, so any
 * authority-like syntax it contains resolves into that placeholder's own
 * host/userinfo — which is then thrown away, keeping only `.pathname` and
 * `.search`. Only those two — guaranteed to start with "/" or be empty,
 * never authority syntax — are then combined with the real,
 * literally-constructed loopback base. The `hostname`/`port` assertion
 * below is redundant with that construction by design; it's still worth
 * asserting outright rather than trusting reasoning about which forms of
 * `pathAndQuery` are safe (see internal.test.ts's adversarial cases for
 * both).
 */
function resolveLoopbackPreviewUrl(pathAndQuery: string, port: number): URL | null {
  // Both `new URL()` calls below can throw outright for a sufficiently
  // malformed `pathAndQuery` (confirmed: a bracketed-but-invalid literal
  // like "//[::a.b.c.d]/x" throws TypeError rather than just parsing into
  // something this function would otherwise reject) — every caller already
  // treats a null return as "reject with 400", so folding a parse failure
  // into that same null case (Hermes review, PR #48) keeps this function's
  // contract honest ("tells you whether the input is usable," not "usable
  // unless it happens to throw") without pushing a try/catch onto every
  // call site.
  try {
    const parsed = new URL(pathAndQuery, "http://internal-preview-placeholder/");
    const upstreamUrl = new URL(parsed.pathname + parsed.search, `http://127.0.0.1:${port}`);
    const resolvedPort = upstreamUrl.port === "" ? 80 : Number(upstreamUrl.port);
    if (upstreamUrl.hostname !== "127.0.0.1" || resolvedPort !== port) return null;
    return upstreamUrl;
  } catch {
    return null;
  }
}

/**
 * The token-gated API a DB-less "agent" role (issue #26) exposes to a
 * primary: project discovery, actions/dock resolution, agent detection, and
 * PTY spawn/attach/terminate/liveness — all scoped to this host's own
 * filesystem and app.pty, with no DB anywhere in this module. Only
 * registered when TESSERA_ROLE=agent (see src/app.ts).
 */
export async function internalRoutes(app: FastifyInstance) {
  // Every route below — including the /internal/ws/attach WS upgrade, since
  // onRequest fires before that upgrade completes (the same guarantee
  // terminal.ts's own preValidation relies on for session-status gating) —
  // requires TESSERA_AGENT_TOKEN as a bearer token. This hook is registered
  // in this plugin's own encapsulated context (not via fastify-plugin), so
  // it stays scoped to /internal/* and never leaks onto /health or anything
  // else registered outside this file.
  app.addHook("onRequest", async (request, reply) => {
    const header = request.headers.authorization;
    const provided = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (!timingSafeTokenMatch(provided, app.config.TESSERA_AGENT_TOKEN)) {
      return reply.unauthorized("invalid or missing agent token");
    }
  });

  // This agent's own PROJECTS_ROOTS, always read straight from env — unlike
  // the primary's resolveProjectRoots (routes/projects.ts), there's no
  // Settings override to check since an agent has no DB.
  app.get("/internal/discover", INTERNAL_RATE_LIMIT, async () => {
    return discoverCandidates(parseProjectsRootsEnv(app.config.PROJECTS_ROOTS));
  });

  // resolveGlobalPresets (actions.ts) reads app.config.CRS_CONFIG_DIR and
  // calls getCachedAgents() — both already mean "this host's own" on an
  // agent process, exactly the reason this can't be computed on the primary
  // side instead (a remote box can have a different set of installed CLIs
  // than the primary — see the design plan).
  app.get<{ Querystring: { cwd?: string } }>(
    "/internal/actions",
    INTERNAL_RATE_LIMIT,
    async (request, reply) => {
      const { cwd } = request.query;
      if (!cwd) return reply.badRequest("cwd query param is required");
      const resolvedCwd = resolveWithinRoots(app, cwd);
      if (!resolvedCwd) return reply.badRequest("cwd must be within this agent's PROJECTS_ROOTS");
      const globalPresets = await resolveGlobalPresets(app);
      return resolveProjectActions(resolvedCwd, globalPresets);
    },
  );

  app.get<{ Querystring: { cwd?: string } }>(
    "/internal/dock",
    INTERNAL_RATE_LIMIT,
    async (request, reply) => {
      const { cwd } = request.query;
      if (!cwd) return reply.badRequest("cwd query param is required");
      const resolvedCwd = resolveWithinRoots(app, cwd);
      if (!resolvedCwd) return reply.badRequest("cwd must be within this agent's PROJECTS_ROOTS");
      return resolveProjectDock(resolvedCwd, app.config.CRS_CONFIG_DIR);
    },
  );

  app.get("/internal/agents", INTERNAL_RATE_LIMIT, async () => {
    return getCachedAgents();
  });

  // Owner/repo derivation for a remote-host project's GitHub widget (issue
  // #27) — a remote project's cwd is a path on *this* agent's filesystem,
  // so reading its .git/config has to happen here, not on the primary (same
  // reasoning as /internal/actions and /internal/dock above). The actual
  // GitHub API calls still happen on the primary, which is the only side
  // holding the credential (routes/projects.ts).
  app.get<{ Querystring: { cwd?: string } }>(
    "/internal/github-repo",
    INTERNAL_RATE_LIMIT,
    async (request, reply) => {
      const { cwd } = request.query;
      if (!cwd) return reply.badRequest("cwd query param is required");
      const resolvedCwd = resolveWithinRoots(app, cwd);
      if (!resolvedCwd) return reply.badRequest("cwd must be within this agent's PROJECTS_ROOTS");
      return parseGitRemote(resolvedCwd);
    },
  );

  // Mirrors POST /api/sessions' "create the row and spawn immediately" — an
  // agent has no row to create, just the spawn half. Idempotent the same way
  // app.pty.getOrCreate always is: calling this again for an id already
  // tracked in this process's memory is a no-op beyond respawning a dead
  // attach-client, same as a fresh /internal/ws/attach would do.
  app.post<{ Body: SpawnSessionBody }>(
    "/internal/sessions",
    { ...INTERNAL_RATE_LIMIT, schema: spawnSessionSchema },
    async (request, reply) => {
      const { id, cwd, command, cols, rows } = request.body;
      app.pty.getOrCreate({ id, cwd: expandHome(cwd), command, cols, rows });
      reply.code(201);
      return { ok: true };
    },
  );

  // Bulk live status for a batch of ids — a primary polling this per-session
  // would be one HTTP round-trip per session on every list refresh; this is
  // the endpoint that makes a single-request-per-host list refresh possible
  // (see the design plan's "batched per-host live status"). idleThresholdMs
  // comes from the primary's own Settings -> Notifications & status (an
  // agent has no Settings to read it from itself). An id this process has
  // never tracked (never spawned/attached here, or spawned by a since-
  // restarted process) maps to null — same "no live signal yet" semantics
  // as routes/sessions.ts's withLiveStatus falls back to for app.pty.get
  // returning undefined.
  app.post<{ Body: LiveStatusBody }>(
    "/internal/sessions/live",
    { ...INTERNAL_RATE_LIMIT, schema: liveStatusSchema },
    async (request) => {
      const { ids, idleThresholdMs } = request.body;
      // Object.create(null): `ids` are fully caller-controlled and become
      // object keys below — a plain `{}` is reachable via a key like
      // "__proto__" (CodeQL: remote property injection). A null-prototype
      // object serializes identically through JSON.stringify but has no
      // __proto__ setter to hijack.
      const result: Record<string, SessionInfo | null> = Object.create(null);
      for (const id of ids) {
        result[id] = app.pty.get(id)?.toInfo(idleThresholdMs) ?? null;
      }
      return result;
    },
  );

  // Bulk systemd-scope liveness for the reconciler (a follow-up PR) — same
  // batching motivation as /internal/sessions/live above, but backed by
  // app.pty.isMasterAlive's `systemctl --user is-active` rather than
  // in-memory state, so it's correct even for a session this process has
  // never tracked (e.g. right after this agent itself restarted).
  app.post<{ Body: LivenessBody }>(
    "/internal/sessions/liveness",
    { ...INTERNAL_RATE_LIMIT, schema: livenessSchema },
    async (request) => {
      const { ids } = request.body;
      const entries = await Promise.all(
        ids.map(async (id) => [id, await app.pty.isMasterAlive(id)] as const),
      );
      // Same null-prototype treatment as /internal/sessions/live above:
      // Object.fromEntries builds a plain `{}` internally, equally
      // reachable via a caller-controlled "__proto__" key.
      const result: Record<string, boolean> = Object.create(null);
      for (const [id, alive] of entries) result[id] = alive;
      return result;
    },
  );

  // Mirrors DELETE /api/sessions/:id's app.pty.terminate call — fully ends
  // the attach-client, the dtach master, and the program itself. The
  // primary is the one that marks the DB row "killed"; this only ever does
  // the host-side half.
  app.post<{ Params: { id: string } }>(
    "/internal/sessions/:id/terminate",
    { ...INTERNAL_RATE_LIMIT, schema: terminateSchema },
    async (request, reply) => {
      await app.pty.terminate(request.params.id);
      reply.code(204);
    },
  );

  // The DB-less counterpart to /ws/terminal (terminal.ts): the primary
  // resolves `cwd`/`command` from its own DB (a session's row, falling back
  // to its project's), then passes them straight through as query params —
  // this agent has nowhere else to get them from. Everything past that is
  // identical: attachSocketToSession's getOrCreate is the same idempotent
  // spawn-or-reattach /ws/terminal itself relies on for the post-restart
  // reattach case, so this endpoint needs no separate "attach only, don't
  // spawn" variant.
  app.get(
    "/internal/ws/attach",
    {
      websocket: true,
      config: INTERNAL_RATE_LIMIT.config,
      preValidation: async (request, reply) => {
        const query = request.query as Record<string, string | undefined>;
        if (!query.id || !query.cwd || !query.command) {
          return reply.badRequest("id, cwd, and command query params are required");
        }
        // Same shape as SESSION_ID_SCHEMA above — this route takes id as a
        // query param, not a JSON body, so it can't use the ajv schema
        // directly, but the id flows into the exact same scopeUnitName(id)
        // sink (pty-manager.ts) either way.
        if (!SESSION_ID_PATTERN.test(query.id)) {
          return reply.badRequest("id must match ^[A-Za-z0-9_-]+$");
        }
      },
    },
    (socket, req) => {
      const query = req.query as Record<string, string | undefined>;
      const cols = Number(query.cols) || 80;
      const rows = Number(query.rows) || 24;

      attachSocketToSession(app, socket, {
        id: query.id as string,
        cwd: expandHome(query.cwd as string),
        command: query.command as string,
        cols,
        rows,
      });
    },
  );

  // The two-hop preview proxy's agent-side half (issue #28 phase 6): the
  // primary's own preview-proxy.ts forwards a browser's preview request
  // here instead of dialing a remote-hosted project's dev server directly
  // (which it has no network path to) — this agent dials it instead, on
  // its own loopback only (see resolveLoopbackPreviewUrl above). `*` is
  // Fastify's wildcard, always preceded by a literal "/" — safe because
  // the primary's own upstreamUrl.pathname (preview-proxy.ts's
  // buildUpstreamUrl) always starts with "/", so the request path here
  // always has one too, even for the dev server's own root ("/internal/
  // preview/5173/").
  app.all<{ Params: { port: string } }>(
    "/internal/preview/:port/*",
    INTERNAL_RATE_LIMIT,
    async (request, reply) => {
      const port = parsePort(request.params.port);
      if (port === null) return reply.badRequest("port must be 1-65535");

      // request.raw.url, not Fastify's own decoded wildcard param: the
      // exact bytes the primary sent (including the query string, which a
      // wildcard route param wouldn't include) are what matter here, not
      // a re-encoded reconstruction of them.
      const prefix = `/internal/preview/${request.params.port}`;
      const rawUrl = request.raw.url ?? "/";
      const rest = rawUrl.startsWith(prefix) ? rawUrl.slice(prefix.length) : "/";

      const upstreamUrl = resolveLoopbackPreviewUrl(rest || "/", port);
      if (!upstreamUrl) return reply.badRequest("invalid preview path");

      // Strips the caller's own "authorization" header — the bearer token
      // this same request just authenticated with — before it reaches
      // arbitrary project dev-server code (see buildUpstreamRequestHeaders'
      // own comment on why this exclusion exists).
      const headers = buildUpstreamRequestHeaders(request, upstreamUrl.host, ["authorization"]);

      let upstreamResponse: Response;
      try {
        upstreamResponse = await fetch(upstreamUrl, {
          method: request.method,
          headers,
          // Never auto-follow — forward the redirect to the primary (and,
          // from there, the browser) as-is, same posture as
          // preview-proxy.ts's own local-case fetch.
          redirect: "manual",
        });
      } catch (err) {
        app.log.warn({ err, port }, "internal preview proxy: upstream unreachable");
        return reply.badGateway(`dev server on port ${port} is unreachable`);
      }
      return relayFetchResponse(reply, request.method, upstreamResponse);
    },
  );

  // The WS analog of /internal/preview/:port/* above, for a remote-hosted
  // project's HMR connection (issue #28 phase 6) — port and the dev
  // server's own path+query travel as query params (a WS upgrade request
  // has no body), validated and resolved against this agent's own loopback
  // by the same resolveLoopbackPreviewUrl before the handshake completes.
  app.get(
    "/internal/ws/preview",
    {
      websocket: true,
      config: INTERNAL_RATE_LIMIT.config,
      preValidation: async (request, reply) => {
        const query = request.query as Record<string, string | undefined>;
        const port = query.port !== undefined ? parsePort(query.port) : null;
        if (port === null) return reply.badRequest("port must be 1-65535");
        if (query.path === undefined) return reply.badRequest("path query param is required");
        if (!resolveLoopbackPreviewUrl(query.path, port)) {
          return reply.badRequest("invalid preview path");
        }
      },
    },
    (socket, req) => {
      const query = req.query as Record<string, string | undefined>;
      // Re-derived, not trusted from preValidation's own run: cheap, pure,
      // and already proven to succeed by preValidation passing at all.
      const port = parsePort(query.port as string) as number;
      const upstreamUrl = resolveLoopbackPreviewUrl(query.path as string, port) as URL;

      const upstream = new NodeWebSocket(toWsUrl(upstreamUrl), {
        headers: { host: upstreamUrl.host },
      });
      pipeWsFrames(app, socket, upstream, { port });
    },
  );
}
