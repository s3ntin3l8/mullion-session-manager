import type { FastifyInstance } from "fastify";
import { projects } from "../db/schema.js";
import { normalizeGitRemote } from "./git-remote.js";
import { projectOrigin, type HostCandidateCache } from "./host-checkout-detect.js";
import { parseHostCwds } from "./placement.js";

// Issue #2231 — "does a project already exist for this checkout?" Used by the
// Discover route and by project create/edit, so adding a second host's clone
// of a repo attaches to the existing project instead of duplicating it.

export type RepoMatchReason = "path" | "origin";

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
  /** A project to leave out (PATCH: the project being edited). */
  excludeProjectId?: number;
  /** Precomputed `buildOriginIndex` result, so a caller matching many
   * candidates (Discover) reads each project's origin once. */
  originIndex?: OriginIndex;
}

/** projectId -> normalised origin (null when it cannot be told). */
export type OriginIndex = Map<number, string | null>;

/** Every project's normalised origin, best-effort. Each remote host is asked
 * for its discovery list at most once. */
export async function buildOriginIndex(app: FastifyInstance): Promise<OriginIndex> {
  const cache: HostCandidateCache = new Map();
  const index: OriginIndex = new Map();
  for (const p of app.db.select().from(projects).all()) {
    try {
      index.set(p.id, await projectOrigin(app, p, cache));
    } catch (err) {
      app.log.debug({ err, projectId: p.id }, "[repo-identity] project origin lookup failed");
      index.set(p.id, null);
    }
  }
  return index;
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
 * or an entry in any project's `hostCwds`), then by normalised origin on any
 * forge. The origin lookup is best-effort — an unreachable host or a path
 * discovery cannot see means path-only matching, never an error.
 */
export async function findProjectByRepoIdentity(
  app: FastifyInstance,
  query: RepoIdentityQuery,
): Promise<RepoMatch | null> {
  const all = app.db
    .select()
    .from(projects)
    .all()
    .filter((p) => p.id !== query.excludeProjectId);

  const byPath = all.find((p) => projectHasPath(p, query.hostId, query.cwd));
  if (byPath) return { project: byPath, reason: "path" };

  let origin: string | null = null;
  if (query.origin !== undefined && query.origin !== null) {
    origin = normalizeGitRemote(query.origin);
  } else if (query.origin === undefined) {
    try {
      origin = await projectOrigin(app, { hostId: query.hostId, cwd: query.cwd });
    } catch (err) {
      app.log.debug({ err, hostId: query.hostId }, "[repo-identity] origin lookup failed");
    }
  }
  if (origin === null) return null;

  const index = query.originIndex ?? (await buildOriginIndex(app));
  for (const p of all) {
    if (index.get(p.id) === origin) return { project: p, reason: "origin" };
  }
  return null;
}
