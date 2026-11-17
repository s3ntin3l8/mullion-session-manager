// Issue #3194 — WHERE a queued retry runs.
//
// A retry resumes the task's preserved branch, and that branch normally lives
// on the host its worker ran on. When that host is offline the retry cannot
// start at all: the preserved branch usually exists ONLY there (a budget
// failure or a rate-limit park happens before the worker's commits are
// pushed), so there is nothing to check out elsewhere.
//
// This module decides the retry's host, in this order:
//
//   1. the ORIGINAL worker host, if it is online, un-parked and still
//      satisfies the task's placement requirement (`Platform:` / `Host:` /
//      `Capability:`);
//   2. otherwise ANOTHER eligible host that satisfies the requirement — but
//      ONLY when the task's branch is on origin, CONFIRMED through the
//      project's GitHub helpers (never assumed: an unconfirmed branch stays
//      where it is);
//   3. otherwise the task WAITS for its original host, with the reason on the
//      card. A wait whose branch is CONFIRMED to be only on that host (a 404
//      from origin) is deliberately NOT failed after 6h (the give-up in
//      task-dispatch.ts): the branch is on that host, so failing the task
//      would free nothing and would throw away the work. A wait whose branch
//      is safely on origin — or whose origin state could not be confirmed —
//      is an ordinary placement wait and keeps the 6-hour give-up.
//
// The placement decision itself is NOT re-implemented here: the same
// `resolveTargetHost`/`resolvePlacement` calls a fresh claim makes decide
// eligibility (online, un-parked, capacity reported, the project mapped or
// cloneable, the agent CLIs and capabilities the task needs), so a retry can
// never land somewhere a fresh claim would have refused.

import type { FastifyInstance } from "fastify";
import type { projects, tasks } from "../db/schema.js";
import { GitHubApiError } from "./github-fetch.js";
import { githubRequest } from "./github-request.js";
import { resolveGitHubToken } from "./github-integration.js";
import { resolveRepoRef } from "./host-git.js";
import { listHosts } from "./host-registry.js";
import { LOCAL_HOST_ID } from "../shared/constants.js";
import {
  resolvePlacement,
  resolveTargetHost,
  type LaunchNeeds,
  type PlacementDecision,
  type PlacementTarget,
} from "./placement.js";

/** What the retry's host decision came to. */
export type RetryHostDecision =
  /**
   * The original host can take the retry: resume the preserved branch there,
   * exactly as before this issue.
   */
  | { kind: "resume"; hostId: string }
  /**
   * Another eligible host takes the retry: it checks the branch out FROM
   * ORIGIN (the branch is confirmed to be there), so the task's `worktreePath`
   * moves to that host.
   */
  | { kind: "replace"; hostId: string; placement: PlacementDecision }
  /**
   * The retry waits for its original host. `detail` is the reason shown on the
   * card; `hostId` is the host it waits for.
   *
   * `strandedOnHost` says whether the preserved branch is CONFIRMED to be
   * only on that host (it is not on origin): that is the one wait where
   * failing the task frees nothing — the work is on the host, and it is there
   * for good — so it is exempt from the 6-hour give-up and offers the
   * operator "Start fresh". A wait whose branch is safely on origin, or whose
   * origin state could not be confirmed, is an ordinary wait: the give-up
   * applies to it like to every other placement wait.
   */
  | { kind: "wait"; hostId: string; detail: string; strandedOnHost: boolean };

/** The project's placement inputs, in the shape the placement code wants. */
function placementProjectOf(project: typeof projects.$inferSelect) {
  return {
    hostId: project.hostId,
    placement: project.placement,
    cwd: project.cwd,
    hostCwds: project.hostCwds,
    placementConstraints: project.placementConstraints,
  };
}

/**
 * Where the task's branch is, as far as origin can tell us.
 *
 *   - "present" — the ref exists on origin: the branch's work is safe there,
 *     and a retry may be re-placed onto another host.
 *   - "absent" — GitHub's 404: the branch is CONFIRMED not to be on origin,
 *     so it exists only on its original host.
 *   - "unknown" — the lookup could not be made (no repository, no token, a
 *     rate limit, a network error). Not a confirmation either way.
 *
 * The distinction between "absent" and "unknown" is what keeps the wait
 * reason honest: only "absent" proves the branch is stranded on its host.
 */
export type BranchOriginState = "present" | "absent" | "unknown";

/**
 * Is the task's branch on `origin`?
 *
 * CONFIRMED, never assumed: the branch is looked up in the project's GitHub
 * repository, and anything that is not a positive answer counts as "not on
 * origin" — the safe direction, because re-placing a task onto another host
 * starts it from origin, so a branch that is really only on the original host
 * would silently lose its commits.
 *
 * The three states keep the two failures apart: a 404 is GitHub saying "no
 * such ref" (the branch is confirmed NOT on origin), while a missing token, a
 * rate limit or a network error means the lookup never happened (the branch's
 * whereabouts are UNKNOWN). A wait that says "it is not on origin" when the
 * lookup merely failed sends the operator after the wrong thing — they would
 * go looking for a branch that may well be on origin.
 *
 * Only GitHub remotes can be confirmed: the project's own remote is resolved
 * through `resolveRepoRef`, which recognises a GitHub origin. A repository
 * with another remote (or none) is never re-placed onto — it waits, and the
 * operator can start it fresh by hand.
 */
export async function branchOnOrigin(
  app: FastifyInstance,
  project: { cwd: string; hostId: string },
  branchName: string,
): Promise<BranchOriginState> {
  // No branch to look up: nothing can be confirmed about it.
  if (branchName.length === 0) return "unknown";
  try {
    const repoRef = await resolveRepoRef(app, project);
    if (repoRef === null) return "unknown";
    const token = await resolveGitHubToken(app, repoRef);
    if (token === null || token === undefined) return "unknown";
    // A 404 is GitHub's "no such ref" — the branch is not on origin.
    await githubRequest<unknown>(
      token,
      repoRef.owner,
      repoRef.repo,
      "GET",
      `/git/ref/heads/${encodeURIComponent(branchName)}`,
    );
    return "present";
  } catch (err) {
    if (err instanceof GitHubApiError && err.statusCode === 404) return "absent";
    // Anything else (rate limit, network, missing permission) is NOT a
    // confirmation — the branch stays where it is, and the wait says the
    // lookup failed rather than claiming the branch is elsewhere.
    app.log.warn(
      { err, branchName },
      "task retry: could not confirm the branch on origin — not re-placing",
    );
    return "unknown";
  }
}

/**
 * The host a queued retry runs on (issue #3194).
 *
 * `originalHostId` is the host the task's worker ran on — the host that holds
 * the preserved branch. `requirement` is the task's placement requirement
 * (null when the task asked for nothing).
 */
export async function decideRetryHost(
  app: FastifyInstance,
  opts: {
    task: typeof tasks.$inferSelect;
    project: typeof projects.$inferSelect;
    /** The task's `Platform:` / `Host:` / `Capability:` requirement, or null. */
    requirement: PlacementTarget | null;
    /** The agent CLI(s) the worker (and its reviewer) need on the host. */
    requiredAgent: readonly string[];
    /** The original worker's host — where the preserved branch lives. */
    originalHostId: string;
    /** What the launch needs of its host (the operations/options it negotiates). */
    launchNeeds?: LaunchNeeds;
  },
): Promise<RetryHostDecision> {
  const { task, project, requirement, originalHostId } = opts;
  const launchNeeds = opts.launchNeeds ?? {};

  // (1) The original host — if it can take the retry, it does: the preserved
  // branch is there, and nothing has to be checked out again.
  //
  // Two things decide that: the task's placement requirement (a HARD one —
  // see the issue's review focus) and whether the host is KNOWN to be
  // unavailable (offline, or parked).
  //
  // The full placement eligibility table (capacity reading, the project
  // mapped there, the agent CLI) is NOT applied here, and deliberately so:
  // that table picks a host for a NEW session, while this host already holds
  // the worktree the retry resumes. What matters is that the machine is
  // there and that the task's requirement still allows it.
  //
  // WHY the original host cannot take it is kept: it is what the wait reason
  // on the card has to say, and "offline" is not the same as "parked" — the
  // operator's next move differs.
  let originalHostUnavailable: string;
  if (satisfiesRequirement(app, originalHostId, requirement)) {
    const availability = originalHostAvailability(app, originalHostId);
    if (availability.available) {
      return { kind: "resume", hostId: originalHostId };
    }
    originalHostUnavailable = availability.reason;
    app.log.info(
      { taskId: task.id, hostId: originalHostId, reason: availability.reason },
      "task retry: the original host cannot take the retry right now",
    );
  } else {
    originalHostUnavailable = "it no longer matches the task's Platform:/Host: requirement";
    app.log.info(
      { taskId: task.id, hostId: originalHostId },
      "task retry: the original host no longer satisfies the task's placement requirement",
    );
  }

  // (2) Another eligible host that satisfies the requirement.
  const candidate = await findReplacementHost(app, {
    project,
    requirement,
    requiredAgent: opts.requiredAgent,
    originalHostId,
    launchNeeds,
  });

  const origin = await branchOnOrigin(app, project, task.branchName ?? "");
  if (candidate === null) {
    // No other host can take the retry right now.
    if (origin === "present") {
      // The branch is on origin, so nothing is stranded on the original host:
      // this is an ordinary placement wait, and the 6-hour give-up applies to
      // it like to every other placement wait.
      return {
        kind: "wait",
        hostId: originalHostId,
        strandedOnHost: false,
        detail: `the task's branch is on origin, but no other host can take this retry right now (offline, parked, or no capacity reading yet) — waiting for ${originalHostId} to come back`,
      };
    }
    return {
      kind: "wait",
      hostId: originalHostId,
      // Only a CONFIRMED 404 proves the branch is on the original host alone;
      // an unconfirmed lookup must not claim the work is stranded there.
      strandedOnHost: origin === "absent",
      detail: waitDetail({
        origin,
        originalHostId,
        unavailable: originalHostUnavailable,
        candidateHostId: null,
      }),
    };
  }
  if (origin !== "present") {
    // Re-placing would start the task from scratch and abandon the original
    // host's commits, so the retry waits instead.
    return {
      kind: "wait",
      hostId: originalHostId,
      strandedOnHost: origin === "absent",
      detail: waitDetail({
        origin,
        originalHostId,
        unavailable: originalHostUnavailable,
        candidateHostId: candidate.hostId,
      }),
    };
  }
  return { kind: "replace", hostId: candidate.hostId, placement: candidate };
}

/**
 * The reason a retry is waiting, in the words the card shows.
 *
 * It says what is actually known:
 *   - "it is not on origin" only when GitHub CONFIRMED the ref is missing
 *     (a 404) — the branch really is only on the original host;
 *   - "could not confirm" when the lookup itself failed, so the operator does
 *     not go hunting for a branch that may well be on origin;
 *   - the original host's REAL state (offline, parked, no longer eligible)
 *     rather than a blanket "is offline".
 */
function waitDetail(opts: {
  origin: BranchOriginState;
  originalHostId: string;
  unavailable: string;
  candidateHostId: string | null;
}): string {
  const { origin, originalHostId, unavailable, candidateHostId } = opts;
  const state = `${originalHostId} is ${unavailable}`;
  if (origin === "absent") {
    const stranded = `the task's branch is only on ${originalHostId} (it is not on origin)`;
    return candidateHostId === null
      ? `${stranded}, and ${state} — the retry waits for it to come back`
      : `${stranded}, so it cannot be moved to ${candidateHostId} — the retry waits for ${originalHostId} to come back; ${state}`;
  }
  const unconfirmed = `could not confirm that the task's branch is on origin`;
  return candidateHostId === null
    ? `${unconfirmed}, and ${state} — the retry waits for it to come back`
    : `${unconfirmed}, so it cannot be moved to ${candidateHostId} — the retry waits for ${originalHostId} to come back; ${state}`;
}

/**
 * Does the host satisfy the task's placement requirement?
 *
 * A `Host:` requirement names one host; a `Platform:` one names a platform;
 * a `Capability:` one names capabilities the host must have. An UNKNOWN value
 * fails open (a host that has not reported its platform or its capabilities
 * yet is not excluded) — the same posture the placement policy takes.
 */
function satisfiesRequirement(
  app: FastifyInstance,
  hostId: string,
  requirement: PlacementTarget | null,
): boolean {
  if (requirement === null) return true;
  if (requirement.hostId !== undefined && requirement.hostId !== hostId) return false;
  if (requirement.platform !== undefined) {
    const platform = hostPlatform(app, hostId);
    if (platform !== null && platform.toLowerCase() !== requirement.platform.toLowerCase()) {
      return false;
    }
  }
  const capabilities = requirement.capabilities ?? [];
  if (capabilities.length > 0) {
    const known = app.hostAgentTracker?.get(hostId)?.capabilities ?? null;
    if (known !== null && !capabilities.every((cap) => known.includes(cap))) return false;
  }
  return true;
}

/** The platform a host reports, or null when it has not reported one. */
function hostPlatform(app: FastifyInstance, hostId: string): string | null {
  if (hostId === LOCAL_HOST_ID) return process.platform;
  const host = listHosts(app).find((h) => h.id === hostId);
  return host?.platform ?? app.hostCapacityTracker?.get(hostId)?.capacity.platform ?? null;
}

/**
 * Is the original host KNOWN to be unavailable?
 *
 * A host the registry does not know (a stale reference) is NOT treated as
 * unavailable: the resume attempt itself is the honest test of it, and a
 * host that has never been seen is not the same as a host that has been
 * reported down.
 *
 * The reason names the state, not just "it is offline": a PARKED host comes
 * back on the operator's say-so, an offline one on its own — the wait reason
 * on the card has to send the operator to the right place.
 */
function originalHostAvailability(
  app: FastifyInstance,
  hostId: string,
): { available: boolean; reason: string } {
  const host = listHosts(app).find((h) => h.id === hostId);
  if (host === undefined) return { available: true, reason: "" };
  if (host.drained) return { available: false, reason: "parked" };
  const health = app.hostHeartbeatTracker?.getHealth(hostId);
  if (health?.status === "offline") return { available: false, reason: "offline" };
  return { available: true, reason: "" };
}

/**
 * Another host that could take the retry — the same eligibility a fresh claim
 * requires, and the same requirement the task carries.
 *
 * A `Host:` requirement names exactly one host, so that host (when it is
 * eligible) is the only candidate. Without one, the project's own placement
 * policy picks the host — the very call `dispatchClaimedTask` makes.
 */
async function findReplacementHost(
  app: FastifyInstance,
  opts: {
    project: typeof projects.$inferSelect;
    requirement: PlacementTarget | null;
    requiredAgent: readonly string[];
    originalHostId: string;
    launchNeeds: LaunchNeeds;
  },
): Promise<PlacementDecision | null> {
  const placementProject = placementProjectOf(opts.project);
  const { requirement, originalHostId } = opts;

  let decision: PlacementDecision;
  if (requirement !== null) {
    // A task directive overrides the project's own platform flag (issue
    // #2241) — exactly as it does for a fresh claim.
    const targeted = resolveTargetHost(app, {
      project: placementProject,
      target: requirement,
      unattended: true,
      requestedBy: "the task's retry",
      requiredAgent: opts.requiredAgent,
      ...opts.launchNeeds,
    });
    if (!targeted.ok) {
      app.log.info(
        { detail: targeted.detail },
        "task retry: no other host satisfies the task's placement requirement",
      );
      return null;
    }
    decision = targeted.decision;
  } else {
    const auto = resolvePlacement(app, {
      project: placementProject,
      unattended: true,
      requiredAgent: opts.requiredAgent,
      ...opts.launchNeeds,
    });
    if (auto.refusal !== undefined || auto.fellBack) {
      app.log.info(
        { reason: auto.refusal?.detail ?? auto.reason },
        "task retry: no other host is eligible for this task",
      );
      return null;
    }
    decision = auto;
  }

  // The original host cannot take the retry (that is why we are here), so it
  // is never the replacement — and a PINNED project resolves to its own host
  // without checking whether that host is eligible at all, so the choice is
  // verified against the same eligibility table before it is used.
  if (decision.hostId === originalHostId) return null;
  const verified = resolveTargetHost(app, {
    project: placementProject,
    target: { hostId: decision.hostId },
    unattended: true,
    requestedBy: "the task's retry",
    requiredAgent: opts.requiredAgent,
    ...opts.launchNeeds,
  });
  if (!verified.ok) {
    app.log.info(
      { hostId: decision.hostId, detail: verified.detail },
      "task retry: the chosen replacement host is not eligible right now",
    );
    return null;
  }
  return verified.decision;
}
