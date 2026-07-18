import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import {
  discoverCandidates,
  expandHome,
  parseProjectsRootsEnv,
  resolveProjectActions,
  resolveProjectDock,
} from "../services/project-config.js";
import { getCachedAgents } from "../services/agent-detect.js";
import { resolveGlobalPresets } from "./actions.js";
import { attachSocketToSession } from "./terminal.js";
import type { SessionInfo } from "../services/pty-manager.js";

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

const spawnSessionSchema = {
  body: {
    type: "object",
    required: ["id", "cwd", "command", "cols", "rows"],
    additionalProperties: false,
    properties: {
      id: { type: "string", minLength: 1 },
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
      ids: { type: "array", items: { type: "string", minLength: 1 } },
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
      ids: { type: "array", items: { type: "string", minLength: 1 } },
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
      const globalPresets = await resolveGlobalPresets(app);
      return resolveProjectActions(expandHome(cwd), globalPresets);
    },
  );

  app.get<{ Querystring: { cwd?: string } }>(
    "/internal/dock",
    INTERNAL_RATE_LIMIT,
    async (request, reply) => {
      const { cwd } = request.query;
      if (!cwd) return reply.badRequest("cwd query param is required");
      return resolveProjectDock(expandHome(cwd), app.config.CRS_CONFIG_DIR);
    },
  );

  app.get("/internal/agents", INTERNAL_RATE_LIMIT, async () => {
    return getCachedAgents();
  });

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
      const result: Record<string, SessionInfo | null> = {};
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
      return Object.fromEntries(entries);
    },
  );

  // Mirrors DELETE /api/sessions/:id's app.pty.terminate call — fully ends
  // the attach-client, the dtach master, and the program itself. The
  // primary is the one that marks the DB row "killed"; this only ever does
  // the host-side half.
  app.post<{ Params: { id: string } }>(
    "/internal/sessions/:id/terminate",
    INTERNAL_RATE_LIMIT,
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
}
