import path from "node:path";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { projects } from "../db/schema.js";
import { LOCAL_HOST_ID, MAX_HOST_CWDS } from "../shared/constants.js";
import { normalizeGitRemote, readOriginUrl } from "./git-remote.js";
import { parseHostCwdsMeta, serializeHostCwdsMeta } from "./host-cwds-meta.js";
import { listHosts, type HostSummary } from "./host-registry.js";
import { parseHostCwds, serializeHostCwds } from "./placement.js";
import { discoverCandidates, type DiscoveredCandidate } from "./project-config.js";
import { resolveProjectRoots } from "./project-roots.js";
import { getRemoteHostClient } from "./remote-host-client.js";
import { getStoredSettings } from "./settings.js";

// Issue #2090 — find a project's checkout on OTHER hosts, and (opt-in) record
// it in `projects.hostCwds`. `hostCwds` is the operator's map of where a
// project lives on other hosts, and it is also what limits where a
// session-scoped child can be sent (control-socket.ts), so everything that
// WRITES it here is conservative: only on an exact, unambiguous `origin`
// match; never over an existing entry; never for a host the operator
// declined; and always visible (logged + flagged `auto` in hostCwdsMeta).

/** Most mappings one auto-fill run adds, so a first run over a big fleet
 * cannot rewrite the whole project list in one go. */
export const MAX_AUTOFILL_PER_RUN = 20;

/** Bounds on what a host's discovery reply may contain. The reply comes from a
 * REMOTE agent, so it is untrusted input: anything outside these is dropped,
 * never stored and never allowed to throw into a whole run. */
const MAX_DISCOVERED = 2000;
const MAX_FIELD_LENGTH = 4096;

export type CheckoutMatch = "origin" | "name";

export interface CheckoutCandidate {
  cwd: string;
  /** `origin`: same normalised `origin` remote. `name`: only the directory
   * name matches — a weaker suggestion that is NEVER auto-filled. */
  match: CheckoutMatch;
}

export interface HostCheckoutSuggestion {
  hostId: string;
  hostName: string;
  /** Origin matches first, then name matches. Never empty. */
  candidates: CheckoutCandidate[];
  /** More than one clone on the host has the project's origin. */
  ambiguous: boolean;
  /** The operator removed a mapping for this host earlier: it is still
   * suggested, but auto-fill skips it. */
  declined: boolean;
}

/** Discovery results per host for ONE run: a host is asked once, however
 * many projects are checked against it (the primary's discover route is
 * rate-limited, and an agent scans its roots on every call). */
export type HostCandidateCache = Map<string, Promise<DiscoveredCandidate[] | null>>;

type ProjectRow = typeof projects.$inferSelect;

function isOnline(app: FastifyInstance, host: HostSummary): boolean {
  if (host.isLocal) return true;
  return app.hostHeartbeatTracker?.getHealth(host.id)?.status === "online";
}

/**
 * Keeps only the well-formed candidates of a discovery reply. `null` means the
 * reply was not a list at all (a misbehaving or non-Mullion service). A
 * candidate with a field of the wrong type, or an oversized one, is skipped on
 * its own; an `origin` that is not a string reads as "no origin" and a missing
 * one (an older agent) stays missing.
 */
function sanitizeCandidates(raw: unknown): DiscoveredCandidate[] | null {
  if (!Array.isArray(raw)) return null;
  const out: DiscoveredCandidate[] = [];
  for (const entry of raw.slice(0, MAX_DISCOVERED)) {
    if (typeof entry !== "object" || entry === null) continue;
    const c = entry as Record<string, unknown>;
    if (typeof c.name !== "string" || typeof c.cwd !== "string") continue;
    if (typeof c.isGitRepo !== "boolean") continue;
    if (c.name.length > MAX_FIELD_LENGTH || c.cwd.length > MAX_FIELD_LENGTH) continue;
    const candidate: DiscoveredCandidate = { name: c.name, cwd: c.cwd, isGitRepo: c.isGitRepo };
    if (c.origin !== undefined) {
      candidate.origin =
        typeof c.origin === "string" && c.origin.length <= MAX_FIELD_LENGTH ? c.origin : null;
    }
    if (typeof c.isWorktree === "boolean") candidate.isWorktree = c.isWorktree;
    out.push(candidate);
  }
  return out;
}

/** A path that is safe to store in `hostCwds`: absolute POSIX, bounded, no
 * control characters and no `..` segment (the API itself only checks `^/`). */
export function isStorablePath(cwd: string): boolean {
  return (
    cwd.startsWith("/") &&
    cwd.length <= MAX_FIELD_LENGTH &&
    !/[\0\r\n]/.test(cwd) &&
    !cwd.split("/").includes("..")
  );
}

function discoverOnHost(
  app: FastifyInstance,
  hostId: string,
  cache: HostCandidateCache,
): Promise<DiscoveredCandidate[] | null> {
  let pending = cache.get(hostId);
  if (!pending) {
    pending = (async () => {
      try {
        const raw =
          hostId === LOCAL_HOST_ID
            ? discoverCandidates(resolveProjectRoots(app))
            : await getRemoteHostClient(app, hostId).discover();
        const list = sanitizeCandidates(raw);
        if (list === null) {
          app.log.warn({ hostId }, "[host-checkout-detect] discovery did not return a list");
        }
        return list;
      } catch (err) {
        // An unreachable host, or an agent too old to have the route, is
        // "nothing to suggest here", not a failure of the whole detection.
        app.log.debug({ err, hostId }, "[host-checkout-detect] discovery failed, skipping host");
        return null;
      }
    })();
    cache.set(hostId, pending);
  }
  return pending;
}

/** The normalised origin of the checkout at `cwd` on `hostId`, or null when
 * it cannot be told (no origin, a path outside the host's discovery roots, an
 * agent too old to report one, an unreachable host). Null means: no
 * origin-based matching for this checkout. */
export async function projectOrigin(
  app: FastifyInstance,
  project: { hostId: string; cwd: string },
  cache: HostCandidateCache = new Map(),
): Promise<string | null> {
  if (project.hostId === LOCAL_HOST_ID) {
    const raw = readOriginUrl(project.cwd);
    return raw === null ? null : normalizeGitRemote(raw);
  }
  const list = await discoverOnHost(app, project.hostId, cache);
  const own = list?.find((c) => c.cwd === project.cwd);
  return typeof own?.origin === "string" ? normalizeGitRemote(own.origin) : null;
}

/**
 * For each OTHER host (online, not drained, the project has no entry for it),
 * the clones there that look like this project. A host with no candidate is
 * omitted. `onlyHostId` limits the walk to one host (the host-came-online
 * trigger).
 */
export async function detectCheckouts(
  app: FastifyInstance,
  project: ProjectRow,
  cache: HostCandidateCache = new Map(),
  onlyHostId?: string,
): Promise<HostCheckoutSuggestion[]> {
  const own = await projectOrigin(app, project, cache);
  const mapped = parseHostCwds(project.hostCwds);
  const declined = new Set(parseHostCwdsMeta(project.hostCwdsMeta).declined);
  const dirName = path.basename(project.cwd).toLowerCase();
  const out: HostCheckoutSuggestion[] = [];

  for (const host of listHosts(app)) {
    if (host.id === project.hostId) continue;
    if (onlyHostId !== undefined && host.id !== onlyHostId) continue;
    if (mapped[host.id] !== undefined) continue;
    if (host.drained || !isOnline(app, host)) continue;

    const list = await discoverOnHost(app, host.id, cache);
    if (list === null) continue;
    // A linked worktree/submodule is not a clone of its own, and a path the
    // sweep would refuse to store is not offered as a suggestion either (the
    // dialog's "Use" button would otherwise seed it).
    const repos = list.filter((c) => c.isGitRepo && c.isWorktree !== true && isStorablePath(c.cwd));

    const normalized = (c: DiscoveredCandidate): string | null =>
      typeof c.origin === "string" ? normalizeGitRemote(c.origin) : null;

    const byOrigin = own === null ? [] : repos.filter((c) => normalized(c) === own);
    const byName = repos.filter((c) => {
      if (byOrigin.includes(c) || c.name.toLowerCase() !== dirName) return false;
      // Same name but a DIFFERENT repository (a fork, an unrelated project
      // that shares a name) is not a suggestion at all.
      const theirs = normalized(c);
      return !(own !== null && theirs !== null && theirs !== own);
    });

    const candidates: CheckoutCandidate[] = [
      ...byOrigin.map((c) => ({ cwd: c.cwd, match: "origin" as const })),
      ...byName.map((c) => ({ cwd: c.cwd, match: "name" as const })),
    ];
    if (candidates.length === 0) continue;
    out.push({
      hostId: host.id,
      hostName: host.name,
      candidates,
      ambiguous: byOrigin.length > 1,
      declined: declined.has(host.id),
    });
  }
  return out;
}

export interface AutoFilledMapping {
  projectId: number;
  hostId: string;
  cwd: string;
}

/**
 * Adds `hostId -> cwd` to the project's `hostCwds` and marks it `auto`, in one
 * transaction that RE-READS the row: an entry or a decline that landed since
 * the detection ran wins, and nothing is ever overwritten.
 */
function commitAutoFill(
  app: FastifyInstance,
  projectId: number,
  hostId: string,
  cwd: string,
): boolean {
  return app.db.transaction((tx) => {
    const [row] = tx.select().from(projects).where(eq(projects.id, projectId)).all();
    if (!row) return false;
    const map = parseHostCwds(row.hostCwds);
    const meta = parseHostCwdsMeta(row.hostCwdsMeta);
    if (map[hostId] !== undefined || meta.declined.includes(hostId)) return false;
    if (Object.keys(map).length >= MAX_HOST_CWDS) return false;
    tx.update(projects)
      .set({
        hostCwds: serializeHostCwds({ ...map, [hostId]: cwd }),
        hostCwdsMeta: serializeHostCwdsMeta({
          auto: [...new Set([...meta.auto, hostId])],
          declined: meta.declined,
        }),
      })
      .where(eq(projects.id, projectId))
      .run();
    return true;
  });
}

export type AttachCheckoutResult = "attached" | "own-host" | "limit" | "not-found";

/**
 * Operator-initiated attach of `hostId -> cwd` to the project's `hostCwds`
 * (issue #2231): same transaction shape as `commitAutoFill`, but the operator
 * chose it, so it overwrites an earlier entry or decline for that host and is
 * NOT flagged `auto`. The project's own host is refused: a second checkout on
 * the same host stays a deliberate `allowDuplicate` project.
 */
export function attachHostCheckout(
  app: FastifyInstance,
  projectId: number,
  hostId: string,
  cwd: string,
): AttachCheckoutResult {
  return app.db.transaction((tx) => {
    const [row] = tx.select().from(projects).where(eq(projects.id, projectId)).all();
    if (!row) return "not-found";
    if (row.hostId === hostId) return "own-host";
    const map = parseHostCwds(row.hostCwds);
    const meta = parseHostCwdsMeta(row.hostCwdsMeta);
    if (map[hostId] === undefined && Object.keys(map).length >= MAX_HOST_CWDS) return "limit";
    tx.update(projects)
      .set({
        hostCwds: serializeHostCwds({ ...map, [hostId]: cwd }),
        hostCwdsMeta: serializeHostCwdsMeta({
          auto: meta.auto.filter((h) => h !== hostId),
          declined: meta.declined.filter((h) => h !== hostId),
        }),
      })
      .where(eq(projects.id, projectId))
      .run();
    return "attached";
  });
}

/**
 * The opt-in sweep (`settings.autoDetectHostCheckouts`): map each project onto
 * a host that has exactly ONE clone with the project's origin. `hostId`
 * restricts it to one host (the host-came-online trigger and "Detect now").
 * Returns `enabled: false` without touching anything while the setting is off.
 *
 * Trust model: a host's discovery answer, `origin` included, is self-reported by
 * that host's agent. A compromised agent can therefore claim to hold a clone of
 * any project. What that buys it is real: a `hostCwds` entry is what makes its
 * host a placement and spawn candidate for the project (placement.ts
 * `projectCwdOnHost`, task-claim.ts), so a spoofed `origin` can get that
 * project's sessions, and the code they check out, sent to that host. The host
 * is one the operator registered, and turning this setting on is the operator's
 * only gate; the per-run cap, the ambiguity rule and the path checks bound the
 * blast radius, and every addition is logged, flagged `auto`, and shown with a
 * badge in Edit project.
 */
export interface AutoFillResult {
  enabled: boolean;
  added: AutoFilledMapping[];
  /** Set when the run was for ONE host that cannot be asked right now, so a
   * caller can say "host offline" instead of "nothing found". */
  skipped?: "offline" | "drained";
}

export async function autoFillHostCwds(
  app: FastifyInstance,
  opts: { hostId?: string } = {},
): Promise<AutoFillResult> {
  if (!getStoredSettings(app.db).autoDetectHostCheckouts) return { enabled: false, added: [] };

  if (opts.hostId !== undefined) {
    const host = listHosts(app).find((h) => h.id === opts.hostId);
    if (host?.drained) return { enabled: true, added: [], skipped: "drained" };
    if (host && !isOnline(app, host)) return { enabled: true, added: [], skipped: "offline" };
  }

  const cache: HostCandidateCache = new Map();
  const added: AutoFilledMapping[] = [];
  for (const project of app.db.select().from(projects).all()) {
    if (added.length >= MAX_AUTOFILL_PER_RUN) break;
    const suggestions = await detectCheckouts(app, project, cache, opts.hostId);
    for (const s of suggestions) {
      if (s.declined || s.ambiguous) continue;
      const exact = s.candidates.filter((c) => c.match === "origin");
      // Exactly one origin match, and a path that is safe to store.
      if (exact.length !== 1 || !isStorablePath(exact[0].cwd)) continue;
      if (added.length >= MAX_AUTOFILL_PER_RUN) break;
      if (commitAutoFill(app, project.id, s.hostId, exact[0].cwd)) {
        added.push({ projectId: project.id, hostId: s.hostId, cwd: exact[0].cwd });
        app.log.info(
          { projectId: project.id, hostId: s.hostId, cwd: exact[0].cwd },
          "[host-checkout-detect] auto-filled hostCwds (matching origin)",
        );
      }
    }
  }
  return { enabled: true, added };
}
