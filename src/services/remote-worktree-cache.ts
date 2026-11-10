// The remote agent's worktree listing, cached for a few seconds.
//
// Issue #2583 — the execution-context resolver asks the agent for its
// worktree list whenever a session's directory lies OUTSIDE the project's
// checkout (the sibling-worktree case). `resolveCtx` in routes/project-files.ts
// runs that resolver for every file request, so a busy file tree paid for one
// `git worktree list` round trip per request, for an answer that changes only
// when a worktree is created or removed.
//
// Three rules keep the cache honest:
//
//   - A HIT — the cwd is in the listing — is answered from the cache, without
//     a round trip. The TTL bounds how stale that answer may be.
//   - A MISS is NEVER answered from the cache: the listing is refreshed from
//     the agent first, so a worktree created seconds ago is still accepted.
//   - Failures are NOT cached: an agent that is too old, unreachable, or that
//     rejects the request must be asked again next time — and the caller
//     keeps its own error classification (execution-context.ts).
import type { FastifyInstance } from "fastify";
import { getRemoteHostClient } from "./remote-host-client.js";

/** How long a fetched worktree listing stays reusable. */
const REMOTE_WORKTREE_CACHE_TTL_MS = 10_000;

/**
 * The host fields that identify WHICH agent answers for a host id: its
 * address and the credentials presented to it. The same set
 * `getRemoteHostClient` compares to decide whether its cached client is still
 * the right one — a changed URL or credential may point at a different agent
 * (or at one that now refuses us), so the listing cached under the old one is
 * not reused.
 */
export interface RemoteHostIdentity {
  id: string;
  baseUrl: string | null;
  authTokenEnc: string | null;
  sessionIdEnc: string | null;
  sessionSecretEnc: string | null;
  /** When the session credential above stops being the one presented. */
  sessionExpiresAt: Date | null;
}

/** The identity of a host's agent, as one comparable string. */
function remoteHostIdentity(host: RemoteHostIdentity): string {
  return [
    host.baseUrl,
    host.authTokenEnc,
    host.sessionIdEnc,
    host.sessionSecretEnc,
    host.sessionExpiresAt?.getTime() ?? null,
  ].join(" ");
}

interface CacheEntry {
  /** The worktree paths, as the agent reported them (not resolved). */
  paths: string[];
  /** The host identity this listing was fetched under. */
  identity: string;
  /** Epoch ms after which the entry is stale. */
  expiresAt: number;
}

interface HostCache {
  /** The listing per checkout root on this host. */
  entries: Map<string, CacheEntry>;
  /** The in-flight request per checkout root (one request per key). */
  inflight: Map<string, Promise<string[]>>;
  /**
   * Bumped by every invalidation. A listing that was already in flight when
   * the invalidation happened describes the agent as it WAS, so it must not
   * land in the cache afterwards.
   */
  generation: number;
}

// Per app: tests build many Fastify instances in one process.
const caches = new WeakMap<FastifyInstance, Map<string, HostCache>>();

function hostCache(app: FastifyInstance, hostId: string): HostCache {
  let perApp = caches.get(app);
  if (!perApp) {
    perApp = new Map();
    caches.set(app, perApp);
  }
  let host = perApp.get(hostId);
  if (!host) {
    host = { entries: new Map(), inflight: new Map(), generation: 0 };
    perApp.set(hostId, host);
  }
  return host;
}

/**
 * Is the directory in question one of the worktrees the agent reports for the
 * checkout at `root`?
 *
 * `matches` decides whether the agent's reported paths contain the directory
 * — the caller owns the path rules (a Windows host resolves its paths with
 * `path.win32`), this module owns the caching.
 */
export async function isRemoteWorktree(
  app: FastifyInstance,
  host: RemoteHostIdentity,
  root: string,
  matches: (paths: readonly string[]) => boolean,
): Promise<boolean> {
  const cache = hostCache(app, host.id);
  const identity = remoteHostIdentity(host);
  const cached = cache.entries.get(root);
  if (
    cached &&
    cached.expiresAt > Date.now() &&
    cached.identity === identity &&
    matches(cached.paths)
  ) {
    return true;
  }
  // Either there is no usable listing, or it does not mention this directory.
  // A cached listing is never the final word on a miss: ask the agent, so a
  // worktree created moments ago is accepted.
  const paths = await load(app, host.id, root, identity);
  return matches(paths);
}

/**
 * Fetches the listing for this checkout root, coalescing concurrent lookups
 * for the same key into ONE request. A rejected fetch caches nothing and
 * leaves the next caller free to try again.
 */
function load(
  app: FastifyInstance,
  hostId: string,
  root: string,
  identity: string,
): Promise<string[]> {
  const cache = hostCache(app, hostId);
  // Keyed by identity as well as root: a request fetched under one set of
  // host credentials must not be adopted by a caller whose credentials have
  // since changed — that listing may describe a DIFFERENT agent.
  const key = `${root}\0${identity}`;
  const running = cache.inflight.get(key);
  if (running) return running;
  const generation = cache.generation;
  const request = (async () => {
    const listed = await getRemoteHostClient(app, hostId).resolveGitBranches(root);
    const paths = listed?.worktrees.map((wt) => wt.path) ?? [];
    // A worktree change that landed while this listing was in flight makes
    // it describe the agent as it was — do not cache it.
    if (cache.generation === generation) {
      cache.entries.set(root, {
        paths,
        identity,
        expiresAt: Date.now() + REMOTE_WORKTREE_CACHE_TTL_MS,
      });
    }
    return paths;
  })();
  cache.inflight.set(key, request);
  // Both arms clear the slot: a failed request must not be remembered, and a
  // successful one must not be joined by a later caller.
  request.then(
    () => {
      if (cache.inflight.get(key) === request) cache.inflight.delete(key);
    },
    () => {
      if (cache.inflight.get(key) === request) cache.inflight.delete(key);
    },
  );
  return request;
}

/**
 * Drops this host's cached listing. Called whenever Mullion itself changes a
 * worktree on the host (issue #2583): the agent's listing is about to change,
 * and a cached one would answer for a worktree that no longer exists.
 *
 * Host-wide, not per checkout root: a worktree change affects the worktrees
 * OF a repository, and which repository the caller means is not always the
 * one the listing was fetched for. Dropping a little extra is cheaper than
 * keeping an entry that answers for a worktree that is gone.
 */
export function invalidateRemoteWorktreeCache(app: FastifyInstance, hostId: string): void {
  const cache = caches.get(app)?.get(hostId);
  if (!cache) return;
  cache.entries.clear();
  // A listing already in flight belongs to the state before this change —
  // both for the answer it gives and for the fact that it must not be
  // stored. Dropping the slot lets the next caller fetch the NEW state
  // instead of joining that request.
  cache.inflight.clear();
  cache.generation += 1;
}
