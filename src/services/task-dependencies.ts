// #667 — dependency-aware task claiming. Shared by task-watcher.ts's
// autoClaimReadyTasks (the poll path) and routes/webhooks.ts (the push
// path, both `issue_dependencies` deliveries and a blocker's own "closed"
// event) so the two paths can't drift — the same reason upsertIssueTask /
// syncClosedIssueToLocal are shared rather than duplicated per path.
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { tasks } from "../db/schema.js";
import { listBlockedByIssues } from "./github-write.js";
import { broadcastTaskEvent } from "./task-events.js";

export interface StoredBlocker {
  owner: string;
  repo: string;
  number: number;
  title: string;
  // Null for the synthetic "N blocker(s) not visible to this token" entry
  // refreshTaskBlockers adds below — nothing to link to.
  htmlUrl: string | null;
}

export type DependencyGate = "clear" | "blocked" | "unresolved";

/** Hermes review, PR #669 — a per-item shape check, not just "is this JSON an
 * array." `refreshTaskBlockers` below is the only writer today, so this is
 * low-risk in practice, but the column round-trips into the API response
 * (routes/tasks.ts) and the board/drawer render whatever's in it directly —
 * a malformed row (a hand edit, a future writer with a bug) should fail
 * closed here rather than hand a shape-mismatched value to the frontend. */
function isStoredBlocker(v: unknown): v is StoredBlocker {
  if (typeof v !== "object" || v === null) return false;
  const b = v as Record<string, unknown>;
  return (
    typeof b.owner === "string" &&
    typeof b.repo === "string" &&
    typeof b.number === "number" &&
    typeof b.title === "string" &&
    (b.htmlUrl === null || typeof b.htmlUrl === "string")
  );
}

/** Tolerant of a malformed/foreign blob — returns null (⇒ unresolved ⇒ fail
 * closed in dependencyGate) rather than throwing, since a task row's
 * blockedBy column is written only by refreshTaskBlockers below but read by
 * every auto-claim sweep. */
export function parseBlockedBy(json: string | null): StoredBlocker[] | null {
  if (json === null) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return null;
    return parsed.every(isStoredBlocker) ? parsed : null;
  } catch {
    return null;
  }
}

export interface DependencyGateRow {
  issueNumber: number | null;
  dependencyCount: number | null;
  blockedBy: string | null;
}

/**
 * The single truth table dependency-aware claiming is built on — see
 * docs/tasks.md's "Dependency-aware claiming" section for the full
 * rationale. `issueNumber` is part of the input, not an afterthought: it's
 * what separates "local task, never gated" (always `clear`, zero cost, zero
 * network dependency — preserves the pre-#667 "auto-claim works with no
 * GitHub connection at all" behavior for local tasks exactly) from
 * "GitHub-linked and not yet observed" (`unresolved`, fail-closed).
 *
 * | dependencyCount | issueNumber | blockedBy | gate       |
 * | --------------- | ----------- | --------- | ---------- |
 * | null            | null        | null      | clear      |
 * | null            | set         | any       | unresolved |
 * | 0                | set         | null      | clear      |
 * | >0               | set         | null      | unresolved |
 * | >0               | set         | "[]"      | clear      |
 * | >0               | set         | [{...}]   | blocked    |
 */
export function dependencyGate(row: DependencyGateRow): DependencyGate {
  if (row.issueNumber === null) return "clear";
  if (row.dependencyCount === null) return "unresolved";
  if (row.dependencyCount === 0) return "clear";
  const blockers = parseBlockedBy(row.blockedBy);
  if (blockers === null) return "unresolved";
  return blockers.length > 0 ? "blocked" : "clear";
}

/**
 * Resolves and stores a task's current open blockers. Called lazily by
 * task-watcher.ts's autoClaimReadyTasks (only for a candidate it's actually
 * about to try) and eagerly by routes/webhooks.ts's `issue_dependencies`/
 * blocker-close pushes. On any failure: logs and returns WITHOUT touching
 * `blockedBy`/`blockedByCheckedAt`/`dependencyCount` — a prior "[]" stays
 * valid, a never-resolved null stays fail-closed. Never throws.
 *
 * Also refreshes `dependencyCount` itself, to `blockers.length` (the
 * count actually stored, including the defensive-shortfall entry below when
 * present) — NOT left at whatever `params.dependencyCount` was passed in.
 * `params.dependencyCount` is only the shortfall check's "what did GitHub's
 * summary say" baseline. Writing the observed count back matters most for
 * the webhook push path (routes/webhooks.ts): a `blocked_by_added` delivery
 * for a task whose `dependencyCount` was 0 before the edge existed would
 * otherwise store a real open blocker in `blockedBy` while `dependencyCount`
 * stayed 0 — and `dependencyGate` short-circuits to "clear" on
 * `dependencyCount === 0` *before* ever looking at `blockedBy`, silently
 * defeating the whole gate. Ingest (task-watcher.ts's upsertIssueTask)
 * always refreshes `dependencyCount` before this runs in the poll path, so
 * this is normally a no-op there — but making refreshTaskBlockers
 * self-consistent removes the ordering dependency entirely rather than
 * relying on every future caller to get it right.
 */
export type BlockerRefreshOutcome = "ok" | "shortfall" | "error";

export async function refreshTaskBlockers(
  app: FastifyInstance,
  params: {
    taskId: number;
    projectId: number;
    owner: string;
    repo: string;
    issueNumber: number;
    dependencyCount: number | null;
    token: string;
    // Display-refresh pass only (task-watcher.ts's resolveStaleTaskBlockers)
    // — the claim path and both webhooks.ts callers omit this and keep the
    // documented behavior below (retry on the very next sweep/delivery).
    // Scoped to the HARD-ERROR outcome only (see the catch block below) — it
    // does NOT extend to a shortfall. A shortfall's whole point is that it
    // might be a transient GitHub-side eventual-consistency lag (see the
    // comment on `shortfall` above), and `blockedByCheckedAt` is the one TTL
    // column both this pass and the claim path's own lazy check
    // (BLOCKER_RECHECK_TTL_MS, 5 min) read. Reviewed and confirmed live:
    // stamping it here on a shortfall would leak into the claim path too —
    // a task the claim path itself just shortfall-checked this same sweep
    // would read as "freshly checked" on the *next* sweep and skip its own
    // 5-minute-TTL re-check, silently stretching a claim decision's
    // freshness window to this pass's 30-minute one. A permanently-visible-
    // as-shortfall row is instead bounded the same way the claim path
    // already bounds it today: by this pass's own per-sweep cap
    // (MAX_DISPLAY_DEPENDENCY_CHECKS_PER_SWEEP), not by stamping. A hard
    // error (network, 404, 403, an under-scoped token) has no such
    // freshness ambiguity — there's no "maybe GitHub just hasn't caught up
    // yet" reading of an exception — so it's safe to stamp and back off.
    stampOnFailure?: boolean;
  },
): Promise<BlockerRefreshOutcome> {
  try {
    const results = await listBlockedByIssues(
      params.token,
      params.owner,
      params.repo,
      params.issueNumber,
    );

    // Defensive count check — verified live against the API during Hermes
    // review (PR #669): `total_blocked_by` counts ALL blockers regardless of
    // open/closed state (matches `results.length`'s own scope — the list
    // endpoint returns closed blockers too, just with `state: "closed"`),
    // and does NOT change when a blocker merely closes. It DOES change when
    // a dependency edge is added/removed — and GitHub's own summary field
    // lags there: a fresh re-fetch of the issue immediately after a
    // `blocked_by_removed` DELETE still returned the PRE-removal count in
    // one verified test, while the list endpoint itself was already
    // consistent. So `params.dependencyCount` (a caller-supplied snapshot,
    // potentially from before an edge changed, and potentially still stale
    // even freshly re-fetched) can legitimately read higher than reality —
    // this is expected, not just a caller bug. Treated as "some blockers
    // aren't visible to this token" rather than "GitHub simply reports
    // fewer than the summary said," and fails toward blocked rather than
    // risk claiming a genuinely blocked task — but see the
    // `blockedByCheckedAt` handling below for how a false positive here
    // self-corrects quickly rather than sticking for a full TTL window.
    const expected = params.dependencyCount ?? 0;
    const openBlockers: StoredBlocker[] = results
      .filter((r) => r.state === "open")
      .map((r) => ({
        owner: r.owner,
        repo: r.repo,
        number: r.number,
        title: r.title,
        htmlUrl: r.htmlUrl,
      }));

    let blockers = openBlockers;
    const shortfall = results.length < expected;
    if (shortfall) {
      const hidden = expected - results.length;
      app.log.warn(
        { taskId: params.taskId, expected, visible: results.length },
        "[task-dependencies] fewer blockers visible to this token than GitHub reports — treating as blocked",
      );
      blockers = [
        {
          owner: params.owner,
          repo: params.repo,
          number: 0,
          title: `${hidden} blocker(s) not visible to this token`,
          htmlUrl: null,
        },
        ...openBlockers,
      ];
    }

    // Hermes review, PR #669 — `blockedByCheckedAt` is deliberately NOT
    // stamped on a shortfall, by ANY caller, including the display-refresh
    // pass (`stampOnFailure` deliberately does not reach this branch — see
    // that param's own doc comment for why: this column is shared with the
    // claim path's own 5-minute TTL, and stamping it here would silently
    // extend that path's freshness window too). It's the TTL
    // task-watcher.ts's autoClaimReadyTasks uses to skip a re-check for up
    // to 5 minutes; stamping it on a result that might just be the
    // caller-supplied `expected` being transiently stale (per the comment
    // above — a real, observed GitHub-side eventual-consistency lag, not
    // only a hypothetical) would lock in a possibly-wrong "blocked" verdict
    // for that whole window instead of letting the very next sweep retry
    // with (hopefully) a fresher count. A clean result (no shortfall) has no
    // such doubt and gets the normal TTL.
    app.db
      .update(tasks)
      .set({
        // #667 — self-consistency write-back: dependencyCount reflects what
        // was actually just observed (blockers.length), not the caller's
        // possibly-stale `params.dependencyCount` — see this function's own
        // doc comment for why (the blocked_by_added-on-a-zero-count case).
        dependencyCount: blockers.length,
        blockedBy: JSON.stringify(blockers),
        ...(!shortfall ? { blockedByCheckedAt: new Date() } : {}),
      })
      .where(eq(tasks.id, params.taskId))
      .run();

    broadcastTaskEvent({
      taskId: params.taskId,
      projectId: params.projectId,
      kind: "blockers",
      ts: Date.now(),
    });
    return shortfall ? "shortfall" : "ok";
  } catch (err) {
    app.log.warn(
      { err, taskId: params.taskId, owner: params.owner, repo: params.repo },
      "[task-dependencies] failed to resolve blockers — leaving prior state (fail closed)",
    );
    // Display-refresh pass only (see stampOnFailure's own doc comment) — a
    // hard error (network, 404, 403, an under-scoped token) stamps just the
    // TTL column, not blockedBy/dependencyCount, so the board keeps
    // whatever it last knew while this row backs off from being re-fetched
    // every tick. The claim path and both webhooks.ts callers never pass
    // this, so their existing "retry on the very next attempt" behavior on
    // error is unchanged. Guarded in its own try/catch — this function's own
    // doc/callers rely on it never throwing (resolveStaleTaskBlockers does
    // not wrap this call), so a DB error here must not escape and abort the
    // rest of the sweep.
    if (params.stampOnFailure) {
      try {
        app.db
          .update(tasks)
          .set({ blockedByCheckedAt: new Date() })
          .where(eq(tasks.id, params.taskId))
          .run();
      } catch (stampErr) {
        app.log.warn(
          { err: stampErr, taskId: params.taskId },
          "[task-dependencies] failed to stamp blockedByCheckedAt after a hard error",
        );
      }
    }
    return "error";
  }
}
