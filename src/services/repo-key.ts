import type { FastifyInstance } from "fastify";
import type { GitHubRepoRef } from "./git-remote.js";
import { resolveRepoRefResult } from "./host-git.js";
import { LOCAL_HOST_ID } from "./host-registry.js";

/**
 * What "the same repo" means across Mullion: `owner/repo`, lower-cased (GitHub
 * treats both as case-insensitive, but a git remote keeps whatever case it was
 * cloned with). Shared by the Task Master issue import (one project per repo),
 * the webhook ingest, and the project-delete webhook guard (#2233, #2251).
 */
export function repoKey(ref: { owner: string; repo: string }): string {
  return `${ref.owner}/${ref.repo}`.toLowerCase();
}

/** `ref` is null when the repo is unknown right now (host unreachable, key
 * remembered from an earlier resolve) or the project is not a GitHub repo. */
export type ResolvedRepo = { ref: GitHubRepoRef | null; key: string | null };

type ProjectRef = { id: number; cwd: string; hostId: string | null };

// Last key each project resolved to. A remote host that is briefly unreachable
// must not look like "no repo": that would hand the repo to a younger project
// and duplicate every issue. Process-lifetime; a project whose repo really
// changes overwrites its entry on the next successful resolve. Project ids are
// AUTOINCREMENT, never reused, so entries never need pruning on delete.
const lastKnownKeys = new Map<number, string>();

// When each project with no remembered key first failed to resolve. See
// MAX_UNRESOLVED_MS.
const unresolvedSince = new Map<number, number>();

/**
 * How long a project that cannot be resolved and has no remembered key may
 * keep deferring every younger repo (`pickRepoOwners`). Past this it is treated
 * as having no GitHub repo, so one dead host cannot stop all younger projects
 * importing indefinitely. Recovery is automatic: the first successful resolve
 * puts it back in the ordering.
 */
export const MAX_UNRESOLVED_MS = 30 * 60 * 1000;

const RESOLVE_CONCURRENCY = 4;

/**
 * Resolve each project's repo (`ref: null, key: null` = reachable but not a
 * GitHub repo). An unreachable host falls back to the last key seen for that
 * project (with `ref: null`), or is omitted from the result when there is none
 * and the deferral window (MAX_UNRESOLVED_MS) has not run out. A legacy empty
 * `hostId` counts as the local host. Concurrency-limited so a large project
 * list does not fan out into one ssh/agent call each at once.
 */
export async function resolveRepoKeys(
  app: FastifyInstance,
  rows: ProjectRef[],
): Promise<Map<number, ResolvedRepo>> {
  const out = new Map<number, ResolvedRepo>();
  let next = 0;
  async function worker() {
    while (next < rows.length) {
      const row = rows[next++];
      const hostId = row.hostId || LOCAL_HOST_ID;
      const result = await resolveRepoRefResult(app, { cwd: row.cwd, hostId }).catch(() => null);
      if (result?.ok) {
        const key = result.value ? repoKey(result.value) : null;
        if (key) lastKnownKeys.set(row.id, key);
        else lastKnownKeys.delete(row.id);
        unresolvedSince.delete(row.id);
        out.set(row.id, { ref: result.value, key });
        continue;
      }
      const known = lastKnownKeys.get(row.id);
      if (known) {
        out.set(row.id, { ref: null, key: known });
        continue;
      }
      const since = unresolvedSince.get(row.id) ?? Date.now();
      unresolvedSince.set(row.id, since);
      if (Date.now() - since > MAX_UNRESOLVED_MS) {
        app.log.warn(
          {
            projectId: row.id,
            hostId,
            unresolvedMinutes: Math.round((Date.now() - since) / 60_000),
          },
          "[repo-key] project's repo has been unresolvable too long — treating it as having no GitHub repo so it stops deferring other projects' issue import; it rejoins when its host answers",
        );
        out.set(row.id, { ref: null, key: null });
      } else {
        app.log.warn(
          { projectId: row.id, hostId },
          "[repo-key] could not resolve this project's repo (host unreachable?) — issue import for younger repos is deferred until it answers",
        );
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(RESOLVE_CONCURRENCY, rows.length) }, worker));
  return out;
}

/**
 * repoKey → id of the project that owns the repo's issue import: the first of
 * `rows`, which the caller passes oldest-first (createdAt, then id).
 *
 * A project missing from `resolved` has an unresolvable repo (host
 * unreachable, nothing remembered, deferral window still open). Fails closed:
 * a repo first seen *after* such a project gets owner 0 (nobody) for this tick,
 * since the unknown older project may be on the same repo.
 */
export function pickRepoOwners(
  rows: Array<{ id: number }>,
  resolved: Map<number, ResolvedRepo>,
): Map<string, number> {
  const owners = new Map<string, number>();
  let unknownSeen = false;
  for (const row of rows) {
    const entry = resolved.get(row.id);
    if (!entry) {
      unknownSeen = true;
      continue;
    }
    if (entry.key && !owners.has(entry.key)) owners.set(entry.key, unknownSeen ? 0 : row.id);
  }
  return owners;
}

/** Test seam: forget remembered state between tests. */
export function resetRepoKeyCache(): void {
  lastKnownKeys.clear();
  unresolvedSince.clear();
}
