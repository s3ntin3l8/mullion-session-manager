import type { FastifyInstance } from "fastify";
import { resolveRepoRefResult } from "./host-git.js";

/**
 * What "the same repo" means across Mullion: `owner/repo`, lower-cased (GitHub
 * treats both as case-insensitive, but a git remote keeps whatever case it was
 * cloned with). Shared by the Task Master issue import (one project per repo),
 * the webhook ingest, and the project-delete webhook guard (#2233, #2251).
 */
export function repoKey(ref: { owner: string; repo: string }): string {
  return `${ref.owner}/${ref.repo}`.toLowerCase();
}

type ProjectRef = { id: number; cwd: string; hostId: string };

// Last key each project resolved to. A remote host that is briefly unreachable
// must not look like "no repo": that would hand the repo to a younger project
// and duplicate every issue. Process-lifetime; a project whose repo really
// changes overwrites its entry on the next successful resolve.
const lastKnownKeys = new Map<number, string>();

const RESOLVE_CONCURRENCY = 4;

/**
 * Resolve each project's repo key (null = reachable but not a GitHub repo).
 * An unreachable host falls back to the last key seen for that project, or is
 * omitted from the result when there is none. Concurrency-limited so a large
 * project list does not fan out into one ssh/agent call each at once.
 */
export async function resolveRepoKeys(
  app: FastifyInstance,
  rows: ProjectRef[],
): Promise<Map<number, string | null>> {
  const out = new Map<number, string | null>();
  let next = 0;
  async function worker() {
    while (next < rows.length) {
      const row = rows[next++];
      const result = await resolveRepoRefResult(app, row).catch(() => null);
      if (result?.ok) {
        const key = result.value ? repoKey(result.value) : null;
        if (key) lastKnownKeys.set(row.id, key);
        else lastKnownKeys.delete(row.id);
        out.set(row.id, key);
      } else {
        const known = lastKnownKeys.get(row.id);
        if (known) out.set(row.id, known);
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
 * A project missing from `keys` has an unresolvable repo (host unreachable,
 * nothing remembered). Fails closed: a repo first seen *after* such a project
 * gets owner 0 (nobody) for this tick, since the unknown older project may be
 * on the same repo. Ingest resumes once the host answers.
 */
export function pickRepoOwners(
  rows: Array<{ id: number }>,
  keys: Map<number, string | null>,
): Map<string, number> {
  const owners = new Map<string, number>();
  let unknownSeen = false;
  for (const row of rows) {
    if (!keys.has(row.id)) {
      unknownSeen = true;
      continue;
    }
    const key = keys.get(row.id);
    if (key && !owners.has(key)) owners.set(key, unknownSeen ? 0 : row.id);
  }
  return owners;
}

/** Drop a deleted project's remembered key (ids can be reused by SQLite). */
export function forgetRepoKey(projectId: number): void {
  lastKnownKeys.delete(projectId);
}

/** Test seam: forget remembered keys between tests. */
export function resetRepoKeyCache(): void {
  lastKnownKeys.clear();
}
