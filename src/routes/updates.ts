import type { FastifyInstance, FastifyRequest } from "fastify";
import { appVersion } from "./server-info.js";
import { checkForUpdate, UpdateCheckError } from "../services/update-checker.js";
import {
  applyUpdateSchema,
  readStatus,
  spawnSelfUpdate,
  type ApplyUpdateBody,
} from "../services/update-apply.js";

// Per-IP sliding-window limiter for forced update checks (?force=true). Each
// forced check hits GitHub's unauthenticated REST API (60 req/hr/IP), so this
// is deliberately tighter than the route-level 30/min Fastify limit — 5 per
// 10 minutes per IP keeps a manual "Check again" clicker well under GitHub's
// cap even behind a shared egress IP. Scoped inside updatesRoute so each app
// instance (including per-test buildApp calls) gets its own map.
const FORCE_CHECK_WINDOW_MS = 10 * 60 * 1000;
const FORCE_CHECK_MAX = 5;

function makeForceCheckLimiter() {
  // Per-IP sliding-window map. Pruned on each access: when an IP's
  // recorded timestamps have all aged out of the window the entry is
  // deleted, so the outer map is bounded by IPs active within the last
  // FORCE_CHECK_WINDOW_MS, not by total distinct IPs over process lifetime.
  const attempts = new Map<string, number[]>();
  return (request: FastifyRequest): boolean => {
    const ip = request.ip;
    const now = Date.now();
    const existing = attempts.get(ip);
    // Filter to only timestamps still within the window.
    const recent = existing ? existing.filter((t) => now - t < FORCE_CHECK_WINDOW_MS) : [];
    if (recent.length === 0 && existing) {
      attempts.delete(ip);
    }
    if (recent.length >= FORCE_CHECK_MAX) {
      if (recent.length > 0) attempts.set(ip, recent);
      return false;
    }
    recent.push(now);
    attempts.set(ip, recent);
    return true;
  };
}

export async function updatesRoute(app: FastifyInstance) {
  const checkForceLimit = makeForceCheckLimiter();

  // Rate-limited like GET /api/projects/discover and the GitHub integration
  // routes (src/routes/projects.ts, src/routes/integrations.ts) — this also
  // reaches out to api.github.com (CodeQL: js/missing-rate-limiting).
  app.get<{ Querystring: { force?: string } }>(
    "/api/updates/check",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const repo = app.config.MULLION_UPDATE_REPO;
      const applyAvailable = app.config.MULLION_HOME.trim() !== "";
      const force = request.query.force === "true";
      if (force && !checkForceLimit(request)) {
        return reply.tooManyRequests("too many forced update checks — try again later");
      }
      try {
        return await checkForUpdate(repo, appVersion, applyAvailable, force);
      } catch (err) {
        if (!(err instanceof UpdateCheckError)) throw err;
        app.log.warn({ repo, statusCode: err.statusCode }, "update check unavailable");
        return reply.badGateway(`could not check for updates: ${err.message}`);
      }
    },
  );

  // Bounded well above the frontend's own poll cadence (UPDATE_STATUS_POLL_MS
  // = 2000ms in Settings.tsx, i.e. ~30 req/min from one open tab) so normal
  // polling — including from a couple of tabs open at once — never trips
  // this, while still bounding the file read CodeQL flagged
  // (js/missing-rate-limiting) against being hammered directly.
  app.get(
    "/api/updates/status",
    { config: { rateLimit: { max: 90, timeWindow: "1 minute" } } },
    async () => {
      const mullionHome = app.config.MULLION_HOME;
      if (mullionHome.trim() === "") return { phase: "unavailable" };
      return readStatus(mullionHome);
    },
  );

  app.post<{ Body: ApplyUpdateBody }>(
    "/api/updates/apply",
    {
      schema: applyUpdateSchema,
      // Tighter than any other route in this repo — each call can spawn a
      // systemd-run child that downloads a release and runs `npm ci` (CodeQL:
      // js/missing-rate-limiting flagged both the file read and the process
      // spawn below). The in-flight-phase check above and self-update.sh's
      // own filesystem lock already prevent concurrent applies from doing
      // real damage; this just bounds how many spawn attempts a client can
      // fire in a burst.
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const result = spawnSelfUpdate(app, request.body);
      if (!result.ok) {
        reply.code(result.status);
        return { message: result.message };
      }
      reply.code(result.status);
      return result.body;
    },
  );
}
