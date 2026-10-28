import type { FastifyInstance } from "fastify";
import { LOCAL_HOST_ID } from "../shared/constants.js";
import { projects } from "../db/schema.js";
import { gitRemoteGateKey } from "./git-remote.js";
import { projectRemoteUrl, type HostCandidateCache } from "./host-checkout-detect.js";
import { parseHostCwds } from "./placement.js";

// Issue #2231 — "does a project already exist for this checkout?" Used by the
// Discover route and by project create/edit, so adding a second host's clone
// of a repo attaches to the existing project instead of duplicating it.

export type RepoMatchReason = "path" | "origin";

type ProjectRow = typeof projects.$inferSelect;

/** How long one host may take to answer a discovery before its projects are
 * treated as having no readable origin, so an offline host cannot stretch a
 * Discover refresh. It bounds the AWAIT only: the host's `discover()` is not
 * aborted and stays pending for the rest of the request (the host cache is
 * per request, so nothing outlives it). */
export const ORIGIN_HOST_TIMEOUT_MS = 3000;

export interface RepoMatch {
  project: typeof projects.$inferSelect;
  reason: RepoMatchReason;
}

export interface RepoIdentityQuery {
  hostId: string;
  cwd: string;
  /** Raw or normalised origin of the candidate, when the caller already has
   * it (the Discover list carries one). Otherwise it is looked up, best
   * effort. */
  origin?: string | null;
  /** The project rows, when the caller has already loaded them (read from the
   * table otherwise). */
  projects?: ProjectRow[];
  /** A project to leave out (PATCH: the project being edited). */
  excludeProjectId?: number;
  /** Precomputed `buildOriginIndex` result, so a caller matching many
   * candidates (Discover) reads each project's origin once. */
  originIndex?: OriginIndex;
  /** A holder shared across calls of one request: the index is built on first
   * need (never when every candidate matches by path or has no origin) and
   * reused after, so a request scans each remote host at most once. */
  originIndexRef?: { current?: OriginIndex };
  /** Never touch the network: compare against local projects' origins only,
   * and skip the candidate's own remote lookup. Create/edit use this so saving
   * a project never waits on (or fails because of) another host. */
  localOnly?: boolean;
}

/** projectId -> the duplicate gate's origin key (null when it cannot be told). */
export type OriginIndex = Map<number, string | null>;

/** Every project's origin key, best-effort. Projects are looked up in parallel
 * (a remote host is asked for its discovery list once, shared through the
 * cache) and each lookup is bounded by `timeoutMs`, so one offline host only
 * costs its own projects an origin. */
export async function buildOriginIndex(
  app: FastifyInstance,
  opts: { localOnly?: boolean; timeoutMs?: number; projects?: ProjectRow[] } = {},
): Promise<OriginIndex> {
  const cache: HostCandidateCache = new Map();
  const rows = (opts.projects ?? app.db.select().from(projects).all()).filter(
    (p) => !opts.localOnly || p.hostId === LOCAL_HOST_ID,
  );
  const timeoutMs = opts.timeoutMs ?? ORIGIN_HOST_TIMEOUT_MS;
  const entries = await Promise.all(
    rows.map(async (p): Promise<[number, string | null]> => {
      let timer: NodeJS.Timeout | undefined;
      try {
        const raw = await Promise.race([
          projectRemoteUrl(app, p, cache),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), timeoutMs);
          }),
        ]);
        return [p.id, raw === null ? null : gitRemoteGateKey(raw)];
      } catch (err) {
        app.log.debug({ err, projectId: p.id }, "[repo-identity] project origin lookup failed");
        return [p.id, null];
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  return new Map(entries);
}

/** True when `cwd` on `hostId` is the project's own checkout or a mapped one. */
export function projectHasPath(
  project: typeof projects.$inferSelect,
  hostId: string,
  cwd: string,
): boolean {
  if (project.hostId === hostId && project.cwd === cwd) return true;
  return parseHostCwds(project.hostCwds)[hostId] === cwd;
}

/**
 * The existing project for a checkout: first by path (its `cwd` on its host,
 * or an entry in any project's `hostCwds`), then by origin on any forge (the
 * gate key: host, port if non-default, path). The origin lookup is best-effort — an unreachable host or a path
 * discovery cannot see means path-only matching, never an error.
 */
export async function findProjectByRepoIdentity(
  app: FastifyInstance,
  query: RepoIdentityQuery,
): Promise<RepoMatch | null> {
  const rows = query.projects ?? app.db.select().from(projects).all();
  const all = rows.filter((p) => p.id !== query.excludeProjectId);

  const byPath = all.find((p) => projectHasPath(p, query.hostId, query.cwd));
  if (byPath) return { project: byPath, reason: "path" };

  let origin: string | null = null;
  if (query.origin !== undefined && query.origin !== null) {
    origin = gitRemoteGateKey(query.origin);
  } else if (query.origin === undefined && !(query.localOnly && query.hostId !== LOCAL_HOST_ID)) {
    try {
      const raw = await projectRemoteUrl(app, { hostId: query.hostId, cwd: query.cwd });
      origin = raw === null ? null : gitRemoteGateKey(raw);
    } catch (err) {
      app.log.debug({ err, hostId: query.hostId }, "[repo-identity] origin lookup failed");
    }
  }
  if (origin === null) return null;

  let index = query.originIndex ?? query.originIndexRef?.current;
  if (!index) {
    index = await buildOriginIndex(app, { localOnly: query.localOnly, projects: rows });
    if (query.originIndexRef) query.originIndexRef.current = index;
  }
  for (const p of all) {
    if (index.get(p.id) === origin) return { project: p, reason: "origin" };
  }
  return null;
}
