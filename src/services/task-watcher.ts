import type { FastifyInstance } from "fastify";
import { and, eq, gt, inArray, isNotNull, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { projects, tasks } from "../db/schema.js";
import { resolveGitHubToken } from "./github-integration.js";
import { resolveRepoRef } from "./host-git.js";
import { GitHubApiError, listLabeledIssues, type TaskIssue } from "./github.js";
import { getIssueState, getIssueTitle } from "./github-write.js";
import { LOCAL_HOST_ID } from "./host-registry.js";
import { getStoredSettings } from "./settings.js";
import { resolveTaskMasterConfig } from "./task-config.js";
import { enqueueTask } from "./task-claim.js";
import { dispatchQueuedTasks } from "./task-dispatch.js";
import {
  syncClosedIssueToLocal,
  syncUnlabeledIssueToLocal,
  FAILURE_REASON_LABEL_LOST,
  FAILURE_REASON_ISSUE_CLOSED,
} from "./task-github-sync.js";
import { canTransition, recordTaskTransition, type TaskStatus } from "./task-state.js";
import { broadcastTaskEvent } from "./task-events.js";
import {
  dependencyGate,
  refreshTaskBlockers,
  type DependencyGateRow,
} from "./task-dependencies.js";

// Read-back (6.4/#217) — how many previously-tracked-but-now-missing
// issues get an individual GET check per project per sweep. Bounded so a
// repo where someone bulk-closes dozens of labeled issues at once can't
// turn one poll cycle into dozens of extra GitHub requests; the remainder
// just gets checked on a later sweep (nothing is permanently skipped,
// only deferred — logged when the cap is hit). #490a — applied
// INDEPENDENTLY to the close-sync candidate list and the unlabel-sync
// candidate list (see syncProjectTasks below), not shared between them:
// sharing one budget would let either kind of churn starve the other out
// of a sweep entirely.
const MAX_READBACK_CHECKS_PER_SWEEP = 20;

// #667 — bounds on the lazy dependency check in autoClaimReadyTasks below.
// The naive "check every ready task with dependencyCount > 0 during ingest"
// design doesn't survive this feature's own motivating scenario: a ~32-issue
// roadmap labeled ready up front has ~31 candidates with dependencies, so
// "only check tasks with dependencies" filters nothing — a per-sweep cap
// alone would still mean 20 calls/project/60s = 1200/hr against a 5000/hr
// core limit. (#759 added install-wide 429/Retry-After handling —
// githubApiFetch/githubRequest, github-fetch.ts — as the actual backstop
// against that overrun; these per-sweep caps below still matter on their
// own terms, to keep one project/pass from starving the others, not just
// to avoid tripping GitHub's limit.)
// So the check moved into autoClaimReadyTasks itself,
// where it only ever resolves blockers for a candidate the loop is actually
// about to try, bounded three ways (cheapest first): a capacity pre-count
// (§ autoClaimReadyTasks, zero calls once at cap), this TTL (skip a
// recently-checked task with no call), and this per-sweep cap as a backstop
// for the pathological "first N candidates are all blocked" ordering.
const BLOCKER_RECHECK_TTL_MS = 5 * 60 * 1000;
const MAX_DEPENDENCY_CHECKS_PER_SWEEP = 20;

// Display-refresh pass (issue: dependency badges stuck on "Checking
// dependencies…") — resolveStaleTaskBlockers below. refreshTaskBlockers's
// ONLY poll-path caller used to be autoClaimReadyTasks, which is gated on
// `autoClaimPaused` and only ever looks at `ready` tasks — so a paused
// install, or one whose GitHub-linked tasks are all still `backlog`, left
// every one of them at `dependencyGate() === "unresolved"` forever, with
// nothing ever calling refreshTaskBlockers to move them off it. This pass
// is the fix: it runs unconditionally (still behind pollOnce's own
// `taskMaster.enabled` gate — see pollOnce's own comment on why NOT
// bypassing that one too is deliberate) so blocker state is a read-only
// display concern, not gated behind autonomous-behavior toggles the way
// claiming itself is.
//
// A SECOND, LONGER TTL than BLOCKER_RECHECK_TTL_MS on purpose — that one
// guards a claim *decision* and wants to stay tight; this one only guards a
// *badge*, and a blocker that closes is already pushed near-real-time by
// webhooks.ts's own blocker-close handler regardless of this TTL.
const BLOCKER_DISPLAY_TTL_MS = 30 * 60 * 1000;

// Independent of MAX_DEPENDENCY_CHECKS_PER_SWEEP, not shared with it — same
// reasoning as MAX_READBACK_CHECKS_PER_SWEEP's own independence from its
// sibling budget: sharing one budget would let either kind of churn starve
// the other out of a sweep entirely. Like MAX_DEPENDENCY_CHECKS_PER_SWEEP
// (and unlike MAX_READBACK_CHECKS_PER_SWEEP, which is per-project), this is
// a single global cap for the whole tick — this pass, like
// autoClaimReadyTasks, runs once per tick over a query that isn't
// project-scoped.
const MAX_DISPLAY_DEPENDENCY_CHECKS_PER_SWEEP = 10;

// #701 — fillParentIssueTitles' own cap. Same value as
// MAX_READBACK_CHECKS_PER_SWEEP/MAX_DEPENDENCY_CHECKS_PER_SWEEP,
// deliberately NOT tuned down to any one install's own distinct-parent
// count: this is a one-shot pass that goes permanently quiet once caught
// up (see that function's own doc comment), so there's no steady-state
// cost a tighter cap would be protecting against — and a cap that exactly
// matched a given install's requirement would leave zero slack for a
// transient per-parent failure (which still consumes a slot, see
// MAX_PARENT_TITLE_ATTEMPTS below) without stretching convergence past a
// single sweep.
const MAX_PARENT_TITLE_FETCHES_PER_SWEEP = 20;

// A deleted or private parent 404s forever, and this pass has no TTL to
// rate-limit re-attempts the way the blocker pass's BLOCKER_DISPLAY_TTL_MS
// does — without a give-up point, one permanently-unreachable parent would
// burn a cap slot every single sweep, forever. Per-watcher-instance (see
// parentTitleFetchAttempts below), so a restart retries — correct for the
// "parent was private, now isn't" case.
const MAX_PARENT_TITLE_ATTEMPTS = 3;

// Cap on the attempt-counter Map itself — nothing otherwise bounds how many
// distinct permanently-unreachable parents could accumulate keys. NOT an
// LRU (a `Map.set` on an existing key doesn't reorder JS iteration order):
// eviction below prefers a key that's already given up
// (attempts >= MAX_PARENT_TITLE_ATTEMPTS) over the oldest-inserted one, so
// pressure doesn't preferentially reset exactly the entries this cap and
// the give-up counter exist to keep quiet — a true LRU/FIFO eviction would
// tend to evict whichever parent has been failing longest, which is
// disproportionately likely to be one already at its give-up limit.
const MAX_PARENT_TITLE_ATTEMPT_ENTRIES = 500;

// Phase 6 (6.9/#233) — an ingested issue's body opts a task OUT of
// auto-claim eligibility with a `Manual: true` line, mirroring the
// roadmap's own documented convention. Matched case-insensitively, on its
// own line (not just "contains the substring" — a task whose spec merely
// *mentions* "Manual: true" in prose shouldn't be silently exempted).
const MANUAL_LINE_RE = /^\s*Manual:\s*true\s*$/im;

function isManualOnly(body: string | null): boolean {
  return body !== null && MANUAL_LINE_RE.test(body);
}

/**
 * #490 — the insert-or-update-per-(project,issue) ingest write, lifted out
 * of the poll sweep below so `webhooks.ts`'s webhook-driven ingest can
 * share the exact same logic rather than reimplementing it and risking the
 * two drifting apart. See the poll sweep's own doc comment for the
 * reasoning behind each piece (backlog-vs-ready default, the
 * onConflictDoUpdate target/set split, the `IS NOT` no-op guard).
 */
export function upsertIssueTask(app: FastifyInstance, projectId: number, issue: TaskIssue): void {
  // #490a — checked BEFORE the write so a genuinely new task can be told
  // apart from a re-sighting update (even a real one, where a column
  // actually changed) for the /ws/tasks broadcast below. Widened beyond a
  // bare existence check (originally just `{ id }`) to also carry what the
  // relabel-resurrection check right below needs — one query either way,
  // same (projectId, issueNumber) pair the upsert's own conflict target
  // already indexes on.
  const existingRow = app.db
    .select({
      id: tasks.id,
      status: tasks.status,
      failureReason: tasks.failureReason,
      branchName: tasks.branchName,
      worktreePath: tasks.worktreePath,
    })
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), eq(tasks.issueNumber, issue.number)))
    .get();
  const existed = existingRow !== undefined;

  const initialStatus = isManualOnly(issue.body) ? "backlog" : "ready";

  // #667 — dependencyCount is only present on a listLabeledIssues-sourced
  // TaskIssue (the poll sweep); a webhook-built one (routes/webhooks.ts) has
  // no summary to read and omits it entirely. The `set`/`where` additions
  // below are built in lockstep, and ONLY when it's present — a webhook-
  // driven re-sighting must not reset an already-known count back to
  // unknown, and the `where` no-op guard shouldn't fire on a column that
  // isn't actually part of this write.
  const hasDependencyCount = issue.dependencyCount !== undefined;
  // #701 — same lockstep-only-when-present rule as hasDependencyCount above,
  // but `null` is a meaningful, DISTINCT state from `undefined` here: a
  // poll-sourced `issue.parent === null` means "GitHub confirms no parent"
  // and must actively clear a previously-stored one (a parent can be
  // removed), while `issue.parent === undefined` (a webhook-built TaskIssue,
  // which has no parent_issue_url to read) must leave a stored parent alone.
  const hasParent = issue.parent !== undefined;
  const hasSubIssues = issue.subIssues !== undefined;
  const newParentNumber = issue.parent?.number ?? null;
  const newParentRepo = issue.parent?.repo ?? null;

  const row = app.db
    .insert(tasks)
    .values({
      projectId,
      issueNumber: issue.number,
      title: issue.title,
      body: issue.body,
      htmlUrl: issue.htmlUrl,
      status: initialStatus,
      dependencyCount: issue.dependencyCount ?? null,
      parentIssueNumber: newParentNumber,
      parentIssueRepo: newParentRepo,
      // parentIssueTitle deliberately omitted — defaults to NULL, which is
      // exactly what arms task-watcher.ts's fillParentIssueTitles for a
      // freshly-ingested child.
      subIssueTotal: issue.subIssues?.total ?? null,
      subIssueCompleted: issue.subIssues?.completed ?? null,
    })
    .onConflictDoUpdate({
      target: [tasks.projectId, tasks.issueNumber],
      set: {
        title: issue.title,
        body: issue.body,
        htmlUrl: issue.htmlUrl,
        updatedAt: new Date(),
        ...(hasDependencyCount ? { dependencyCount: issue.dependencyCount } : {}),
        ...(hasParent
          ? {
              parentIssueNumber: newParentNumber,
              parentIssueRepo: newParentRepo,
              // Clear the denormalised title iff the parent identity
              // actually moved — otherwise every re-sighting would wipe a
              // filled cache and fillParentIssueTitles would refetch it
              // forever. Bare (unqualified) column references inside an
              // ON CONFLICT DO UPDATE SET/WHERE refer to the row's CURRENT
              // (pre-update) value in SQLite — i.e. the stored value being
              // compared against, not the incoming one — verified against
              // a real DB in task-watcher.test.ts rather than trusted from
              // docs alone, since a silent misread here fails in either
              // direction (title never clears, or clears every sweep).
              parentIssueTitle: sql`CASE WHEN ${tasks.parentIssueNumber} IS NOT ${newParentNumber}
                                          OR ${tasks.parentIssueRepo} IS NOT ${newParentRepo}
                                     THEN NULL ELSE ${tasks.parentIssueTitle} END`,
            }
          : {}),
        ...(hasSubIssues
          ? {
              subIssueTotal: issue.subIssues?.total,
              subIssueCompleted: issue.subIssues?.completed,
            }
          : {}),
      },
      where: sql`${tasks.title} IS NOT ${issue.title} OR ${tasks.body} IS NOT ${issue.body} OR ${tasks.htmlUrl} IS NOT ${issue.htmlUrl}
        ${hasDependencyCount ? sql`OR ${tasks.dependencyCount} IS NOT ${issue.dependencyCount}` : sql``}
        ${hasParent ? sql`OR ${tasks.parentIssueNumber} IS NOT ${newParentNumber} OR ${tasks.parentIssueRepo} IS NOT ${newParentRepo}` : sql``}
        ${hasSubIssues ? sql`OR ${tasks.subIssueTotal} IS NOT ${issue.subIssues?.total} OR ${tasks.subIssueCompleted} IS NOT ${issue.subIssues?.completed}` : sql``}`,
    })
    .returning({ id: tasks.id })
    .get();

  // #488/#490a — a brand-new task gets a live "ingested" event on the same
  // /ws/tasks channel transitions use, so the Tasks panel shows it within
  // ~1s instead of waiting for the next 60s poll — the same latency gap
  // #488 closed for status changes, now closed for arrivals too. Only
  // fires when `existed` was false: the `where` clause above means `row`
  // can be undefined for a no-op re-sighting anyway, but the `existed`
  // check is what actually distinguishes "new" from "updated with a real
  // change" — both leave `row` populated.
  if (!existed && row) {
    broadcastTaskEvent({ taskId: row.id, projectId, kind: "ingested", ts: Date.now() });
    return;
  }

  // Relabel-resurrection — a task that previously auto-failed because its
  // GitHub issue lost the `mullion-task` label
  // (`syncUnlabeledIssueToLocal`, task-github-sync.ts) self-heals the
  // moment a sighting here confirms the label is present again, closing
  // the loop that otherwise left a re-added label a silent no-op (the
  // upsert above never touches `status` on a re-sighting). A DELIBERATE
  // separate, status-guarded UPDATE — not folded into the upsert's own
  // `set`/`where` above — for two reasons: it keeps the ingest write's
  // `set` clause free of a `status` column entirely (so an ordinary
  // re-sighting can never touch status, matching every other column's
  // documented "durable subset only" rule), and the guarded
  // `.where(...).run(); if (changes === 0) return;` shape is this exact
  // file's own established idiom for "did my specific condition actually
  // still hold at write time" (`syncClosedIssueToLocal`/
  // `syncUnlabeledIssueToLocal`, task-github-sync.ts) — so the `changes`
  // count is the definitive, race-safe signal for whether resurrection
  // actually happened, not an inference from before/after status that
  // could be confounded by an unrelated concurrent write.
  //
  // Scoped narrowly, mirroring `syncUnlabeledIssueToLocal`'s own "leave
  // anything with real work behind it alone" posture:
  //  - the EXACT label-lost failure reason, not FAILURE_REASON_ISSUE_CLOSED
  //    — a closed issue re-gaining the label must NOT reopen it, since
  //    listLabeledIssues (the poll path) never surfaces a closed issue in
  //    the first place and the webhook path guards issue.state separately
  //    (routes/webhooks.ts) — this condition is the second, belt-and-
  //    suspenders line of defense against resurrecting a closed one.
  //  - no branch/worktree — a task that was ever claimed has real work and
  //    its own cleanup story; this must never short-circuit that.
  if (
    existingRow !== undefined &&
    existingRow.status === "failed" &&
    existingRow.failureReason === FAILURE_REASON_LABEL_LOST &&
    existingRow.branchName === null &&
    existingRow.worktreePath === null
  ) {
    const resurrectableStatus = isManualOnly(issue.body) ? "backlog" : "ready";
    const resurrected = app.db
      .update(tasks)
      .set({ status: resurrectableStatus, failureReason: null, completedAt: null })
      .where(
        and(
          eq(tasks.id, existingRow.id),
          eq(tasks.status, "failed" satisfies TaskStatus),
          eq(tasks.failureReason, FAILURE_REASON_LABEL_LOST),
          isNull(tasks.branchName),
          isNull(tasks.worktreePath),
        ),
      )
      .run();
    if (resurrected.changes > 0) {
      recordTaskTransition(app, {
        taskId: existingRow.id,
        projectId,
        from: "failed",
        to: resurrectableStatus,
        via: "github-sync-relabeled",
        context: { issueNumber: issue.number },
      });
    }
  }
}

// Stagger initial fetches so N projects don't all hit GitHub at once — same
// shape as github-pr-poller.ts's own STARTUP_STAGGER_MS.
const STARTUP_STAGGER_MS = 2_000;

/**
 * Background poller for the task watcher (Phase 2.5's thin slice, issue
 * #214; hardened in Phase 6's 6.9/#233 and 6.4/#217). Discovers open,
 * `MULLION_TASK_LABEL`-labeled issues on every connected project's repo —
 * local or remote-hosted (#484) — and records them as tasks —
 * insert-or-**update** per (projectId, issueNumber): a first sighting
 * inserts a new row (see `initialStatusFor` for the backlog-vs-ready
 * default), a repeat sighting updates only the durable subset
 * (title/body/htmlUrl) an issue is authoritative for, per the roadmap's
 * reconciliation rule — `boardOrder` and every runtime column are never
 * touched by this sync, so a task the user has already dragged, claimed, or
 * advanced is never reset by the next poll. `status` is untouched too EXCEPT
 * for one narrow, self-inflicted case this sync itself created: a task it
 * auto-failed for losing the tracking label springs back to ready/backlog
 * the moment a re-sighting confirms the label is back — see
 * `upsertIssueTask`'s own `canResurrect` doc comment. The unique index on
 * `tasks` drives the conflict target, not a last-seen cursor.
 *
 * #484 — resolves each project's repo via `resolveRepoRef(app, {cwd,
 * hostId})` (host-aware: a local call reads `.git/config` directly, a
 * remote one proxies to `/internal/github-repo`) rather than the raw
 * `parseGitRemote(cwd)` this used to call directly — that was this sweep's
 * whole reason for being local-hosted-projects-only, now resolved the same
 * way task-github-sync.ts's writes already were.
 *
 * Mirrors github-pr-poller.ts's shape closely (re-entrancy guard, staggered
 * initial sweep, `.unref()`'d timers, per-row errors logged and skipped so
 * one bad repo can't abort the sweep) — deliberately, since this is the same
 * "poll every connected project's GitHub repo on an interval" problem.
 */
export function startTaskWatcher(app: FastifyInstance): () => void {
  let interval: ReturnType<typeof setInterval> | null = null;
  let sweepTimer: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  // #701 — fillParentIssueTitles' give-up counter, keyed by `repo#number`.
  // Lives at this scope (one per startTaskWatcher instance, i.e. per
  // process) rather than per-tick, so it actually bounds attempts across
  // sweeps — see MAX_PARENT_TITLE_ATTEMPTS' own comment.
  const parentTitleFetchAttempts = new Map<string, number>();

  // #484 — every connected project, not just local-hosted ones; the
  // `!row.hostId` normalization (a pre-#26 row predating the NOT NULL
  // default on this column) now matters beyond defense in depth, since
  // syncProjectTasks threads hostId through to resolveRepoRef, which needs
  // a real host id string, never a falsy one.
  function pollableProjectRows() {
    return app.db
      .select({ id: projects.id, cwd: projects.cwd, hostId: projects.hostId })
      .from(projects)
      .all()
      .map((row) => ({ ...row, hostId: row.hostId || LOCAL_HOST_ID }));
  }

  async function syncProjectTasks(
    projectId: number,
    cwd: string,
    hostId: string,
    label: string,
    // #667 — populated here with this sweep's own freshly-resolved
    // repoRef/token so autoClaimReadyTasks's lazy dependency checks (called
    // once, after every project's syncProjectTasks has run for this same
    // tick — see pollOnce below) can reuse them instead of re-resolving. A
    // fresh Map per pollOnce tick, not a module/closure-level one: reusing
    // a prior tick's token across ticks would risk a silently-stale
    // credential for a project whose resolution happens to fail on a later
    // tick, for zero benefit (resolveGitHubToken already caches).
    githubContext: Map<number, { owner: string; repo: string; token: string }>,
  ): Promise<void> {
    const repoRef = await resolveRepoRef(app, { cwd, hostId });
    if (!repoRef) {
      // #484 — for a remote-hosted project, `null` here is now ambiguous:
      // "not a GitHub repo" (the same durable case a local project's null
      // means) vs. "couldn't reach this project's host" (resolveRepoRef's
      // own catch-and-return-null). Logged at debug so a dead agent host
      // doesn't silently look identical to a project that was never on
      // GitHub — matching this sweep's own read-back-cap logging posture
      // elsewhere in this file.
      if (hostId !== LOCAL_HOST_ID) {
        app.log.debug(
          { projectId, hostId },
          "[task-watcher] could not resolve a GitHub repo for this remote-hosted project (not a GitHub repo, or its host is unreachable) — skipping",
        );
      }
      return;
    }

    // #489 remaining scope — resolved per-project, AFTER repoRef, the same
    // reorder task-github-sync.ts/task-promote.ts already use: an App
    // installation token is scoped to a single repo, so there's no longer
    // one token to resolve for the whole sweep up front. Falls back to the
    // shared PAT/OAuth token when no App covers this repo (or no App is
    // configured at all) — this is what makes Task Master's own ingest
    // consistently App-scoped instead of writes-only, closing the gap an
    // install configuring an App would otherwise still hit on every read.
    const token = await resolveGitHubToken(app, repoRef);
    if (!token) {
      app.log.debug(
        { projectId, owner: repoRef.owner, repo: repoRef.repo },
        "[task-watcher] no GitHub token available for this project, skipping",
      );
      return;
    }
    githubContext.set(projectId, { owner: repoRef.owner, repo: repoRef.repo, token });

    try {
      const issues = await listLabeledIssues(token, repoRef.owner, repoRef.repo, label);
      // Phase 6 (6.9/#233) — a first sighting of an issue is inserted
      // "ready" (auto-claim eligible) unless its body opts out via
      // `Manual: true`, in which case "backlog" — see upsertIssueTask's own
      // doc comment. A repeat sighting never touches status.
      for (const issue of issues) {
        upsertIssueTask(app, projectId, issue);
      }

      // Read-back (6.4/#217, widened by #490a) — a previously-tracked,
      // still-non-terminal task whose issue no longer appears in this
      // sweep's open+labeled set has either been closed or had the label
      // removed on GitHub. Two disjoint candidate lists below (a task's
      // status is single-valued, so a row can only ever land in one),
      // each with its OWN cap rather than sharing one: widening the old
      // "reviewing only" set to also include backlog/ready for the unlabel
      // check would otherwise let a busy board's backlog/ready churn starve
      // "reviewing" tasks (or vice versa) out of every sweep once either
      // set alone exceeded the shared cap — see MAX_READBACK_CHECKS_PER_SWEEP's
      // own doc comment for why a cap exists at all.
      //
      // Filtered BEFORE the cap below (independent review, PR #474) — not
      // just before the network call. A task whose status can't possibly
      // be acted on for either check (claimed/in_progress: not
      // canTransition(status,"done"), and not backlog/ready either) is
      // excluded up front rather than costing a GitHub request purely to
      // produce a log line — the same "leave it alone, don't even check"
      // posture the pre-#490a code already had for closed-while-claimed.
      const openIssueNumbers = new Set(issues.map((i) => i.number));
      const trackedNonTerminal = app.db
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.projectId, projectId),
            isNotNull(tasks.issueNumber),
            notInArray(tasks.status, ["done", "failed"]),
          ),
        )
        .all();
      const disappearedForClose = trackedNonTerminal.filter(
        (t) =>
          !openIssueNumbers.has(t.issueNumber!) && canTransition(t.status as TaskStatus, "done"),
      );
      const disappearedForUnlabel = trackedNonTerminal.filter(
        (t) =>
          !openIssueNumbers.has(t.issueNumber!) && (t.status === "backlog" || t.status === "ready"),
      );
      if (disappearedForClose.length > MAX_READBACK_CHECKS_PER_SWEEP) {
        app.log.warn(
          { projectId, total: disappearedForClose.length, checking: MAX_READBACK_CHECKS_PER_SWEEP },
          "[task-watcher] more issues dropped out of the labeled set than this sweep checks for close-sync — remainder deferred to a later sweep",
        );
      }
      if (disappearedForUnlabel.length > MAX_READBACK_CHECKS_PER_SWEEP) {
        app.log.warn(
          {
            projectId,
            total: disappearedForUnlabel.length,
            checking: MAX_READBACK_CHECKS_PER_SWEEP,
          },
          "[task-watcher] more issues dropped out of the labeled set than this sweep checks for unlabel-sync — remainder deferred to a later sweep",
        );
      }
      const projectRef = { cwd, hostId };
      for (const task of disappearedForClose.slice(0, MAX_READBACK_CHECKS_PER_SWEEP)) {
        await syncClosedIssueToLocal(app, task, projectRef);
      }
      // #490a — confirm before acting: "dropped out of the open+labeled
      // set" alone is ambiguous (closed, transferred, deleted, the label
      // renamed, MULLION_TASK_LABEL reconfigured, or this sweep's own
      // listLabeledIssues call hitting its 100-item page cap — see
      // docs/github-integration.md's Current limitations). A single fresh
      // GET settles it — and settles BOTH ways a backlog/ready candidate
      // can turn out to genuinely no longer be trackable (Hermes review,
      // PR #510): confirmed `closed`, or confirmed `open` with the task
      // label genuinely absent. A backlog/ready task's issue closing
      // without ever having the label removed (closed while still
      // labeled, or closed after some other label churn) is NOT covered by
      // `disappearedForClose` above — that list is gated on
      // canTransition(status,"done"), true only for `reviewing` — so
      // without this, a `ready` task whose issue is confirmed closed would
      // never transition out of `ready` at all: re-probed every sweep
      // forever (permanently occupying one of this cap's slots), AND still
      // sitting in `ready`, where `autoClaimReadyTasks()` below would
      // happily spawn a real agent to work a task whose issue is already
      // closed. `syncUnlabeledIssueToLocal`'s own decision (fail
      // backlog/ready, leave anything with real work alone) is exactly
      // right for "no longer relevant" regardless of which of the two
      // reasons triggered it.
      for (const task of disappearedForUnlabel.slice(0, MAX_READBACK_CHECKS_PER_SWEEP)) {
        try {
          const { state, labels } = await getIssueState(
            token,
            repoRef.owner,
            repoRef.repo,
            task.issueNumber!,
          );
          if (state === "closed") {
            // Closed is closed regardless of the label — record the true
            // reason (previously this shared the label-lost string with the
            // branch below, which was misleading AND made a closed task
            // indistinguishable from a label-lost one for upsertIssueTask's
            // relabel-resurrection check).
            await syncUnlabeledIssueToLocal(app, task, projectRef, FAILURE_REASON_ISSUE_CLOSED);
          } else if (state === "open" && !labels.includes(label)) {
            await syncUnlabeledIssueToLocal(app, task, projectRef, FAILURE_REASON_LABEL_LOST);
          }
        } catch (err) {
          app.log.warn(
            { taskId: task.id, issueNumber: task.issueNumber, err },
            "[task-watcher] unlabel read-back check failed",
          );
        }
      }
    } catch (err) {
      if (err instanceof GitHubApiError) {
        app.log.warn(
          { owner: repoRef.owner, repo: repoRef.repo, statusCode: err.statusCode },
          "[task-watcher] GitHub API error",
        );
      } else {
        app.log.error(
          { err, owner: repoRef.owner, repo: repoRef.repo },
          "[task-watcher] unexpected error",
        );
      }
    }
  }

  // Phase 6 (6.2/#215) — auto-claim: every task discovered as "ready" (the
  // watcher's own ingest already excludes `Manual: true` issues from this
  // set by inserting them as "backlog" instead — see syncProjectTasks
  // above) gets claimed autonomously, in `boardOrder`/`id` order via
  // task-claim.ts's shared orchestration (`auto: true`, so an agent with no
  // seed-delivery channel is refused rather than silently spawned with no
  // instructions).
  //
  // #667 — a candidate whose dependencyGate() isn't "clear" is skipped
  // rather than claimed; see task-dependencies.ts for the full gate table
  // and this file's own MAX_DEPENDENCY_CHECKS_PER_SWEEP/
  // BLOCKER_RECHECK_TTL_MS for why the check is lazy (resolved only for a
  // candidate this loop is actually about to try) rather than eager (during
  // ingest, for every ready task with dependencies — which doesn't survive
  // this feature's own motivating scenario, see those constants' comment).
  //
  // Capacity pre-count (#667) — a call-avoidance guard, not a correctness
  // check: `enqueueTask` never cap-checks (queueing is unconditional, the
  // whole point of the claim/dispatch split — see task-claim.ts), so
  // there's no "cap" outcome left for this loop to react to after the
  // fact. Auto-claim still needs to pace ITSELF, though — without this,
  // one sweep would drain the entire `ready` backlog into "claimed" the
  // instant capacity opens even slightly, turning the board's Ready column
  // into dead weight and making `ready`'s own boardOrder-preserving queue
  // pointless (see task-claim.ts's own doc comment on why manual claim and
  // auto-claim queue in different places). So this counts BOTH `claimed`
  // and `in_progress` as "occupied" — deliberately not the same set
  // CONCURRENCY_CAPPED_STATUSES exports now (that constant is
  // `in_progress`-only, the real dispatch-time cap) — this is pure pacing:
  // don't queue more than there's genuine room for, given what's already
  // either running or already waiting in line.
  //
  // Gated on the runtime pause (settings.taskMaster.autoClaimPaused), the
  // roadmap's stated kill-switch requirement — distinct from the "enabled"
  // toggle above (which also stops auto-claim, but via a heavier "Task
  // Master off entirely" switch): pause is scoped to only auto-claim, so a
  // human can still manually claim/approve/reject while paused. Both are
  // now settings-backed and take effect on the next sweep with no restart
  // (see task-config.ts). Read fresh every sweep, not cached.
  async function autoClaimReadyTasks(
    githubContext: Map<number, { owner: string; repo: string; token: string }>,
  ): Promise<Set<number>> {
    // Task ids this pass itself called refreshTaskBlockers on this tick,
    // regardless of outcome — handed back to resolveStaleTaskBlockers so it
    // doesn't immediately re-check (and double the GitHub call for) a row
    // this pass just checked. Needed specifically for the shortfall case:
    // a shortfall is deliberately never stamped to blockedByCheckedAt by
    // either pass (see refreshTaskBlockers' own doc comment), so without
    // this set the SQL-level TTL filter alone wouldn't catch it — the row
    // would still read as "never checked" and get re-fetched a second time
    // in the very same sweep.
    const refreshedThisSweep = new Set<number>();

    if (getStoredSettings(app.db).taskMaster.autoClaimPaused) {
      app.log.debug("[task-watcher] auto-claim is paused, skipping");
      return refreshedThisSweep;
    }

    const maxConcurrent = resolveTaskMasterConfig(app).maxConcurrent;
    const occupied = app.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(inArray(tasks.status, ["claimed", "in_progress"]))
      .all().length;
    let remaining = maxConcurrent - occupied;
    if (remaining <= 0) {
      app.log.debug(
        { occupied, maxConcurrent },
        "[task-watcher] at capacity, skipping auto-claim sweep entirely",
      );
      return refreshedThisSweep;
    }

    const ready = app.db
      .select({
        id: tasks.id,
        projectId: tasks.projectId,
        issueNumber: tasks.issueNumber,
        dependencyCount: tasks.dependencyCount,
        blockedBy: tasks.blockedBy,
        blockedByCheckedAt: tasks.blockedByCheckedAt,
      })
      .from(tasks)
      .where(eq(tasks.status, "ready"))
      // The missing ORDER BY the issue was filed about — boardOrder is the
      // board's own local render/ordering tier (routes/tasks.ts's own
      // GET /api/tasks uses the same order), id as a stable tiebreak.
      .orderBy(tasks.boardOrder, tasks.id)
      .all();

    let dependencyChecksThisSweep = 0;
    let cappedOut = false;

    for (const row of ready) {
      if (remaining <= 0) break;

      let gateRow: DependencyGateRow = row;
      let gate = dependencyGate(gateRow);

      if (gate !== "clear") {
        const isStale =
          row.blockedByCheckedAt === null ||
          Date.now() - row.blockedByCheckedAt.getTime() >= BLOCKER_RECHECK_TTL_MS;
        const ctx = githubContext.get(row.projectId);

        if (isStale && ctx && row.issueNumber !== null) {
          if (dependencyChecksThisSweep >= MAX_DEPENDENCY_CHECKS_PER_SWEEP) {
            cappedOut = true;
          } else {
            dependencyChecksThisSweep++;
            refreshedThisSweep.add(row.id);
            await refreshTaskBlockers(app, {
              taskId: row.id,
              projectId: row.projectId,
              owner: ctx.owner,
              repo: ctx.repo,
              issueNumber: row.issueNumber,
              dependencyCount: row.dependencyCount,
              token: ctx.token,
            });
            const [fresh] = app.db
              .select({
                issueNumber: tasks.issueNumber,
                dependencyCount: tasks.dependencyCount,
                blockedBy: tasks.blockedBy,
              })
              .from(tasks)
              .where(eq(tasks.id, row.id))
              .all();
            if (fresh) {
              gateRow = fresh;
              gate = dependencyGate(gateRow);
            }
          }
        }
      }

      if (gate !== "clear") {
        app.log.debug(
          { taskId: row.id, gate, blockedBy: gateRow.blockedBy },
          "[task-watcher] auto-claim skipped — dependency gate not clear",
        );
        continue;
      }

      try {
        // enqueueTask never cap-checks (see this loop's own pre-count
        // comment above) — its failure reasons are all genuine problems
        // with THIS candidate (not-found/not-ready/no-seed-channel), never
        // a capacity signal, so every failure here is warn-worthy and none
        // of them should stop the sweep the way "cap" used to.
        const outcome = await enqueueTask(app, row.id, { auto: true });
        if (outcome.ok) {
          remaining--;
        } else {
          app.log.warn(
            { taskId: row.id, reason: outcome.reason },
            "[task-watcher] auto-claim did not succeed",
          );
        }
      } catch (err) {
        app.log.error({ err, taskId: row.id }, "[task-watcher] auto-claim threw unexpectedly");
      }
    }

    if (cappedOut) {
      app.log.warn(
        { checked: MAX_DEPENDENCY_CHECKS_PER_SWEEP },
        "[task-watcher] more ready tasks needed a dependency check than this sweep's cap allows — remainder deferred to a later sweep",
      );
    }

    return refreshedThisSweep;
  }

  // Decoupled from auto-claim (see MAX_DISPLAY_DEPENDENCY_CHECKS_PER_SWEEP's
  // own comment for why) — resolves blockers for the sake of the board's
  // badge, independent of autoClaimReadyTasks' own claim-gate check. Any
  // status a task can sit in pre-`done`/`failed` is a candidate, not just
  // `ready`: a manually-claimed task never goes through dependencyGate at
  // all (claiming bypasses the gate — see docs/tasks.md), so it can be
  // sitting in `claimed`/`in_progress`/`reviewing` with a never-resolved
  // dependency state and the board has no other path to ever check it.
  async function resolveStaleTaskBlockers(
    githubContext: Map<number, { owner: string; repo: string; token: string }>,
    // Ids autoClaimReadyTasks already called refreshTaskBlockers on this
    // same tick — see that Set's own doc comment. Skipped here even though
    // some of them (a shortfall) won't show up as fresh in the SQL TTL
    // filter, to avoid a second GitHub call for the same task in the same
    // sweep.
    alreadyRefreshedThisSweep: Set<number>,
  ): Promise<void> {
    const cutoff = new Date(Date.now() - BLOCKER_DISPLAY_TTL_MS);

    const candidates = app.db
      .select({
        id: tasks.id,
        projectId: tasks.projectId,
        issueNumber: tasks.issueNumber,
        dependencyCount: tasks.dependencyCount,
      })
      .from(tasks)
      .where(
        and(
          notInArray(tasks.status, ["done", "failed"]),
          isNotNull(tasks.issueNumber),
          // Only rows a check could actually change — dependencyGate
          // short-circuits `dependencyCount === 0` to "clear" without ever
          // reading blockedBy (task-dependencies.ts), so those rows cost
          // nothing and must not be selected here at all: if they were only
          // skipped inside the loop below instead, they'd still occupy
          // queue positions ahead of the per-sweep cap, and since they also
          // have blockedByCheckedAt IS NULL they'd sort to the very front —
          // crowding out rows that genuinely need a call on a large board.
          or(isNull(tasks.dependencyCount), gt(tasks.dependencyCount, 0)),
          or(isNull(tasks.blockedByCheckedAt), lt(tasks.blockedByCheckedAt, cutoff)),
        ),
      )
      // Never-checked rows first (NULL sorts first via IS NOT NULL ASC),
      // then oldest-checked — so a fresh/paused install's backlog of
      // never-resolved tasks converges within a couple of sweeps instead of
      // thrashing against already-resolved-but-stale rows.
      .orderBy(sql`${tasks.blockedByCheckedAt} IS NOT NULL`, tasks.blockedByCheckedAt, tasks.id)
      .all();

    let checks = 0;
    let cappedOut = false;

    for (const row of candidates) {
      if (alreadyRefreshedThisSweep.has(row.id)) continue;
      if (checks >= MAX_DISPLAY_DEPENDENCY_CHECKS_PER_SWEEP) {
        cappedOut = true;
        continue;
      }
      const ctx = githubContext.get(row.projectId);
      if (!ctx) {
        // No repoRef/token resolved for this project this tick (ingest
        // couldn't reach it, or it has no token configured) — nothing to
        // check against; try again next sweep, same posture as ingest's own
        // per-project skip.
        continue;
      }

      checks++;
      await refreshTaskBlockers(app, {
        taskId: row.id,
        projectId: row.projectId,
        owner: ctx.owner,
        repo: ctx.repo,
        issueNumber: row.issueNumber!,
        dependencyCount: row.dependencyCount,
        token: ctx.token,
        // See refreshTaskBlockers' own doc comment on this param — a
        // display-only refresh must not let a permanently-failing or
        // permanently-shortfalling row hammer this pass on every tick
        // forever at the expense of every other candidate.
        stampOnFailure: true,
      });
    }

    if (cappedOut) {
      app.log.debug(
        { checked: MAX_DISPLAY_DEPENDENCY_CHECKS_PER_SWEEP },
        "[task-watcher] more tasks needed a display dependency refresh than this sweep's cap allows — remainder deferred to a later sweep",
      );
    }
  }

  // #701 — a ONE-SHOT CACHE-FILL, not a TTL-guarded refresh like
  // resolveStaleTaskBlockers above. Deliberately a different shape — say so
  // explicitly, since a reader who just read that pass will expect a TTL
  // here too: an issue's title does not go stale in a way that matters to a
  // display chip, so there is no TTL and no periodic re-check. The
  // candidate query is simply `parentIssueTitle IS NULL`, which converges
  // to empty and then costs one cheap SELECT per sweep forever, doing
  // nothing further. upsertIssueTask is what re-arms this pass, by nulling
  // a stored title only when the parent identity itself changes.
  async function fillParentIssueTitles(
    githubContext: Map<number, { owner: string; repo: string; token: string }>,
  ): Promise<void> {
    const candidates = app.db
      .select({
        id: tasks.id,
        projectId: tasks.projectId,
        parentIssueNumber: tasks.parentIssueNumber,
        parentIssueRepo: tasks.parentIssueRepo,
      })
      .from(tasks)
      .where(
        and(
          // Hermes review — deliberate, but worth spelling out since it's
          // a real (if narrow) gap: a child that reaches done/failed
          // before this pass ever reaches it keeps a bare `#N` chip
          // forever, since it drops out of candidacy the moment it goes
          // terminal and there's no re-arm on reopen. Accepted rather than
          // widening this to every status: a terminal task's own board
          // relevance is already winding down, and re-checking it forever
          // would cost a permanent trickle of GitHub calls for a cosmetic
          // detail on a task nobody is actively looking at anymore.
          notInArray(tasks.status, ["done", "failed"]),
          isNotNull(tasks.parentIssueNumber),
          isNotNull(tasks.parentIssueRepo),
          isNull(tasks.parentIssueTitle),
        ),
      )
      .orderBy(tasks.id)
      .all();

    if (candidates.length === 0) return;

    // Dedup by distinct parent BEFORE fetching — this is what makes the
    // pass converge in one sweep rather than one call per CHILD (e.g. 32
    // children of 10 parents is 10 calls deduped, comfortably under the
    // cap, vs. 32 calls capped and spread across several ticks otherwise).
    interface ParentGroup {
      parentIssueRepo: string;
      parentIssueNumber: number;
      rows: { id: number; projectId: number }[];
    }
    const byParent = new Map<string, ParentGroup>();
    for (const row of candidates) {
      const key = `${row.parentIssueRepo}#${row.parentIssueNumber}`;
      let group = byParent.get(key);
      if (!group) {
        group = {
          parentIssueRepo: row.parentIssueRepo!,
          parentIssueNumber: row.parentIssueNumber!,
          rows: [],
        };
        byParent.set(key, group);
      }
      group.rows.push({ id: row.id, projectId: row.projectId });
    }

    let fetches = 0;
    let cappedOut = false;

    for (const [key, group] of byParent) {
      // Already gave up on this parent after repeated failures — see the
      // catch branch below. Not re-attempted until a process restart.
      if ((parentTitleFetchAttempts.get(key) ?? 0) >= MAX_PARENT_TITLE_ATTEMPTS) continue;
      if (fetches >= MAX_PARENT_TITLE_FETCHES_PER_SWEEP) {
        cappedOut = true;
        continue;
      }
      // The CHILD's project token is used to fetch the PARENT, which can be
      // in a different repo — cross-repo sub-issues are first-class in
      // GitHub's model, same posture task-dependencies.ts's blocker fetch
      // already takes for cross-repo blockers. `group.rows` can legitimately
      // span more than one Mullion project (two projects registered against
      // the same repo, or a genuine cross-repo shared parent) — deduped by
      // token (not just the first project found), and every distinct token
      // is tried in turn below before counting a failure. Hermes review:
      // the give-up key is shared across every project in the group, so
      // stopping at the first-found token would let one under-scoped
      // project's token (403/404 on this parent) starve the whole group —
      // including sibling projects whose OWN token could see it fine —
      // into eventually giving up.
      const distinctCtxs = [
        ...new Map(
          group.rows
            .map((r) => githubContext.get(r.projectId))
            .filter((c): c is { owner: string; repo: string; token: string } => c !== undefined)
            .map((c) => [c.token, c] as const),
        ).values(),
      ];
      if (distinctCtxs.length === 0) continue;

      const separatorIndex = group.parentIssueRepo.indexOf("/");
      if (separatorIndex === -1) continue; // malformed — shouldn't happen, defensive only
      const parentOwner = group.parentIssueRepo.slice(0, separatorIndex);
      const parentRepo = group.parentIssueRepo.slice(separatorIndex + 1);

      let title: string | undefined;
      let lastErr: unknown;
      // Distinguishes "every distinct token in this group genuinely
      // failed" (count it against the give-up budget) from "ran out of
      // this sweep's own cap partway through the retry sequence" (defer,
      // don't count) — the latter must not silently masquerade as the
      // former, or a group with several tokens could exhaust its give-up
      // budget purely on cap pressure rather than real failures.
      let exhaustedAllTokens = true;
      for (const ctx of distinctCtxs) {
        if (fetches >= MAX_PARENT_TITLE_FETCHES_PER_SWEEP) {
          cappedOut = true;
          exhaustedAllTokens = false;
          break;
        }
        fetches++;
        try {
          title = await getIssueTitle(ctx.token, parentOwner, parentRepo, group.parentIssueNumber);
          break;
        } catch (err) {
          lastErr = err;
        }
      }

      if (title !== undefined) {
        app.db
          .update(tasks)
          .set({ parentIssueTitle: title })
          .where(
            and(
              eq(tasks.parentIssueRepo, group.parentIssueRepo),
              eq(tasks.parentIssueNumber, group.parentIssueNumber),
              // Re-check, don't just trust the earlier SELECT — a
              // concurrent re-parenting between the SELECT above and this
              // UPDATE must not clobber a title that arrived (or was
              // invalidated again) in between.
              isNull(tasks.parentIssueTitle),
            ),
          )
          .run();
        parentTitleFetchAttempts.delete(key);
        for (const row of group.rows) {
          broadcastTaskEvent({
            taskId: row.id,
            projectId: row.projectId,
            kind: "hierarchy",
            ts: Date.now(),
          });
        }
      } else if (exhaustedAllTokens) {
        const attempts = (parentTitleFetchAttempts.get(key) ?? 0) + 1;
        if (
          !parentTitleFetchAttempts.has(key) &&
          parentTitleFetchAttempts.size >= MAX_PARENT_TITLE_ATTEMPT_ENTRIES
        ) {
          // Evict a key that's already given up before falling back to the
          // oldest-inserted one — see MAX_PARENT_TITLE_ATTEMPT_ENTRIES' own
          // comment for why plain insertion-order eviction is the wrong
          // default here.
          let victim: string | undefined;
          for (const [k, v] of parentTitleFetchAttempts) {
            if (v >= MAX_PARENT_TITLE_ATTEMPTS) {
              victim = k;
              break;
            }
          }
          victim ??= parentTitleFetchAttempts.keys().next().value;
          if (victim !== undefined) parentTitleFetchAttempts.delete(victim);
        }
        parentTitleFetchAttempts.set(key, attempts);
        if (attempts >= MAX_PARENT_TITLE_ATTEMPTS) {
          app.log.warn(
            { err: lastErr, parent: key, attempts },
            "[task-watcher] giving up on this parent's title after repeated failures — will retry on restart",
          );
        } else {
          app.log.debug(
            { err: lastErr, parent: key, attempts },
            "[task-watcher] parent title fetch failed, will retry next sweep",
          );
        }
      }
    }

    if (cappedOut) {
      app.log.debug(
        { checked: MAX_PARENT_TITLE_FETCHES_PER_SWEEP },
        "[task-watcher] more parents needed a title fetch than this sweep's cap allows — remainder deferred to a later sweep",
      );
    }
  }

  async function pollOnce(): Promise<void> {
    if (running) return;
    running = true;
    try {
      // Settings UI follow-up — Task Master's enabled state is now
      // runtime-toggleable (env default, overridable via
      // settings.taskMaster.enabled; see task-config.ts). Checked first,
      // before pollableProjectRows() and before any per-project token
      // resolution (#489 remaining scope — token resolution moved inside
      // syncProjectTasks, per project), so a disabled install does exactly
      // one settings SELECT per tick and nothing else — no GitHub calls,
      // no task queries, no auto-claim attempts.
      if (!resolveTaskMasterConfig(app).enabled) {
        app.log.debug("[task-watcher] Task Master is disabled, skipping sweep");
        return;
      }
      // #759 — deliberately NOT an entry-level "skip this whole tick"
      // check here, unlike task-reconciler.ts's three GitHub-only sweeps.
      // This tick's own GitHub calls (syncProjectTasks/
      // resolveStaleTaskBlockers/fillParentIssueTitles) already fail fast
      // at the transport layer regardless (githubApiFetch/githubRequest,
      // github-fetch.ts — the primary defense), but autoClaimReadyTasks and
      // dispatchQueuedTasks below are independent of GitHub connectivity
      // entirely (see autoClaimReadyTasks's own doc comment) — gating the
      // whole tick on the GitHub budget would silently stop local-only
      // auto-claim from working while GitHub is rate-limited, which is
      // exactly the kind of GitHub-availability coupling this codebase's
      // roadmap decision (local-board-works-regardless-of-GitHub) rejects.
      const label = app.config.MULLION_TASK_LABEL;
      const rows = pollableProjectRows();
      // #667 — one Map per tick, populated by each project's own
      // syncProjectTasks call below and consumed by autoClaimReadyTasks
      // right after — see syncProjectTasks's own param doc for why this
      // isn't hoisted to a longer-lived scope.
      const githubContext = new Map<number, { owner: string; repo: string; token: string }>();
      for (const row of rows) {
        await syncProjectTasks(row.id, row.cwd, row.hostId, label, githubContext);
      }
      // Independent of whether a GitHub token is configured (Hermes/
      // independent review posture carried into 6.2): a locally-created
      // task can reach "ready" with no GitHub connection at all, and the
      // roadmap's local-board-works-regardless-of-GitHub decision means
      // auto-claim shouldn't silently stop working just because ingest
      // has nothing to do this sweep.
      const refreshedByClaimPath = await autoClaimReadyTasks(githubContext);
      // Periodic dispatch backstop (task-claim queueing, rate-limit-storm
      // fix) — task-dispatch.ts's opportunistic hook (off every
      // recordTaskTransition) handles the common case in near-real-time;
      // this tick is what guarantees a queued task is never stuck forever
      // if that hook's trigger was ever missed (e.g. a process restart
      // right after a task was enqueued but before its own transition's
      // listeners ran).
      await dispatchQueuedTasks(app);
      // Deliberately decoupled from autoClaimReadyTasks — see
      // resolveStaleTaskBlockers' own doc comment and
      // MAX_DISPLAY_DEPENDENCY_CHECKS_PER_SWEEP's for why this runs
      // regardless of autoClaimPaused (unlike autoClaimReadyTasks itself)
      // while still sharing this sweep's own taskMaster.enabled gate above
      // and reusing the githubContext already resolved by the ingest loop.
      // refreshedByClaimPath is passed through so a row the claim path just
      // checked this same tick isn't immediately checked again here.
      await resolveStaleTaskBlockers(githubContext, refreshedByClaimPath);
      // #701 — also reuses this tick's githubContext. No Set handshake
      // needed the way resolveStaleTaskBlockers has one for the claim path:
      // fillParentIssueTitles' own candidate query (parentIssueTitle IS
      // NULL) can't overlap with anything the blocker passes above just
      // did, since those only ever touch dependencyCount/blockedBy.
      await fillParentIssueTitles(githubContext);
    } catch (err) {
      app.log.error({ err }, "[task-watcher] poll cycle failed");
    } finally {
      running = false;
    }
  }

  const pollIntervalMs = app.config.MULLION_TASK_POLL_INTERVAL * 1000;
  const rows = pollableProjectRows();

  // Settings UI follow-up — a boot-time snapshot, not the only enabled
  // check (pollOnce's own per-tick check above is what actually matters
  // for correctness). This one exists purely to avoid scheduling the
  // staggered per-project initial-fetch dance below when Task Master is
  // off at startup: with the plugin now always registering (see
  // plugins/task-watcher.ts), skipping this means a disabled install goes
  // straight to one cheap interval that no-ops every tick, instead of a
  // burst of per-project GitHub-ingest timers that would each immediately
  // no-op anyway. If the user flips the setting on later, the very next
  // pollOnce() tick (up to pollIntervalMs away) picks it up — the same
  // latency the pre-existing autoClaimPaused toggle already accepts, and
  // unavoidable without re-deriving this function's whole timer setup
  // reactively.
  if (rows.length === 0 || !resolveTaskMasterConfig(app).enabled) {
    interval = setInterval(pollOnce, pollIntervalMs);
    interval.unref();
    return () => {
      if (interval) clearInterval(interval);
    };
  }

  const initialTimers: ReturnType<typeof setTimeout>[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const t = setTimeout(async () => {
      try {
        // Same resolved-enabled gate as pollOnce (Settings UI follow-up) —
        // this staggered initial fetch is a separate code path from
        // pollOnce's own gate and would otherwise ingest from GitHub on
        // startup even with Task Master disabled, now that the plugin
        // always registers.
        if (!resolveTaskMasterConfig(app).enabled) return;
        // Throwaway per-call Map — autoClaimReadyTasks doesn't run on this
        // staggered initial-fetch path, so there's nothing to hand context
        // to; the real pollOnce tick that follows builds its own.
        await syncProjectTasks(
          row.id,
          row.cwd,
          row.hostId,
          app.config.MULLION_TASK_LABEL,
          new Map(),
        );
      } catch (err) {
        app.log.warn({ err, projectId: row.id }, "[task-watcher] initial fetch failed");
      }
    }, i * STARTUP_STAGGER_MS);
    t.unref();
    initialTimers.push(t);
  }

  const longestDelay = (rows.length - 1) * STARTUP_STAGGER_MS;
  const margin = Math.max(pollIntervalMs * 2, 10_000);
  sweepTimer = setTimeout(() => {
    pollOnce();
    interval = setInterval(pollOnce, pollIntervalMs);
    interval.unref();
  }, longestDelay + margin);
  sweepTimer.unref();

  return () => {
    for (const t of initialTimers) clearTimeout(t);
    if (sweepTimer) clearTimeout(sweepTimer);
    if (interval) clearInterval(interval);
  };
}
