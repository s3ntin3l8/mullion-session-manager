import type { FastifyInstance } from "fastify";
import { and, eq, isNotNull, notInArray, sql } from "drizzle-orm";
import { projects, tasks } from "../db/schema.js";
import { parseGitRemote } from "./git-remote.js";
import { resolveGitHubToken } from "./github-integration.js";
import { GitHubApiError, listLabeledIssues, type TaskIssue } from "./github.js";
import { getIssueState } from "./github-write.js";
import { LOCAL_HOST_ID } from "./host-registry.js";
import { getStoredSettings } from "./settings.js";
import { resolveTaskMasterConfig } from "./task-config.js";
import { claimTask } from "./task-claim.js";
import { syncClosedIssueToLocal, syncUnlabeledIssueToLocal } from "./task-github-sync.js";
import { canTransition, type TaskStatus } from "./task-state.js";
import { broadcastTaskEvent } from "./task-events.js";

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
  // actually changed) for the /ws/tasks broadcast below. Cheap: the same
  // (projectId, issueNumber) pair the upsert's own conflict target already
  // indexes on.
  const existed =
    app.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), eq(tasks.issueNumber, issue.number)))
      .get() !== undefined;

  const initialStatus = isManualOnly(issue.body) ? "backlog" : "ready";
  const row = app.db
    .insert(tasks)
    .values({
      projectId,
      issueNumber: issue.number,
      title: issue.title,
      body: issue.body,
      htmlUrl: issue.htmlUrl,
      status: initialStatus,
    })
    .onConflictDoUpdate({
      target: [tasks.projectId, tasks.issueNumber],
      set: {
        title: issue.title,
        body: issue.body,
        htmlUrl: issue.htmlUrl,
        updatedAt: new Date(),
      },
      where: sql`${tasks.title} IS NOT ${issue.title} OR ${tasks.body} IS NOT ${issue.body} OR ${tasks.htmlUrl} IS NOT ${issue.htmlUrl}`,
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
  }
}

// Stagger initial fetches so N projects don't all hit GitHub at once — same
// shape as github-pr-poller.ts's own STARTUP_STAGGER_MS.
const STARTUP_STAGGER_MS = 2_000;

/**
 * Background poller for the task watcher (Phase 2.5's thin slice, issue
 * #214; hardened in Phase 6's 6.9/#233 and 6.4/#217). Discovers open,
 * `MULLION_TASK_LABEL`-labeled issues on every connected **local-host**
 * project's repo and records them as tasks — insert-or-**update** per
 * (projectId, issueNumber): a first sighting inserts a new row (see
 * `initialStatusFor` for the backlog-vs-ready default), a repeat sighting
 * updates only the durable subset (title/body/htmlUrl) an issue is
 * authoritative for, per the roadmap's reconciliation rule — `status`,
 * `boardOrder`, and every runtime column are never touched by this sync,
 * so a task the user has already dragged, claimed, or advanced is never
 * reset by the next poll. The unique index on `tasks` drives the conflict
 * target, not a last-seen cursor. Remote-hosted projects are skipped
 * *here* — this GitHub-issue-ingest sweep reads `cwd` via a direct local
 * `parseGitRemote()` call, not through `resolveBackend`, so it can't reach
 * a remote host's repo at all. This is now a narrower, separate limitation
 * than it used to be: 6.8 (#283) lifted the claim-time and worktree-
 * lifecycle restrictions on remote-hosted projects, so a remote project can
 * already have tasks claimed/worked/cleaned-up end-to-end via the local
 * task board (POST /api/tasks, host-agnostic) — it just can't have tasks
 * auto-ingested from labeled GitHub issues yet. That would need this sweep
 * to resolve the repo via `resolveRepoRef(app, {cwd, hostId})` (as
 * task-github-sync.ts already does) instead of the raw `parseGitRemote`
 * call below — a distinct piece of work, not part of 6.8's scope.
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

  function localProjectRows() {
    return app.db
      .select({ id: projects.id, cwd: projects.cwd, hostId: projects.hostId })
      .from(projects)
      .all()
      .filter((row) => row.hostId === LOCAL_HOST_ID || !row.hostId);
  }

  async function syncProjectTasks(projectId: number, cwd: string, label: string): Promise<void> {
    const repoRef = parseGitRemote(cwd);
    if (!repoRef) return;

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
      const projectRef = { cwd, hostId: LOCAL_HOST_ID };
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
          if (state === "closed" || (state === "open" && !labels.includes(label))) {
            await syncUnlabeledIssueToLocal(app, task, projectRef);
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
  // above) gets claimed autonomously, one at a time via task-claim.ts's
  // shared orchestration (`auto: true`, so an agent with no seed-delivery
  // channel is refused rather than silently spawned with no instructions).
  // No local pre-count against the concurrency cap: claimTask's own
  // reservation is already atomic with the cap check, so iterating and
  // letting each call self-limit is simpler and no less correct than
  // duplicating that count here — once the cap is hit, every further call
  // this sweep just gets `{ok:false, reason:"cap"}` and is skipped.
  //
  // Gated on the runtime pause (settings.taskMaster.autoClaimPaused), the
  // roadmap's stated kill-switch requirement — distinct from the "enabled"
  // toggle above (which also stops auto-claim, but via a heavier "Task
  // Master off entirely" switch): pause is scoped to only auto-claim, so a
  // human can still manually claim/approve/reject while paused. Both are
  // now settings-backed and take effect on the next sweep with no restart
  // (see task-config.ts). Read fresh every sweep, not cached.
  async function autoClaimReadyTasks(): Promise<void> {
    if (getStoredSettings(app.db).taskMaster.autoClaimPaused) {
      app.log.debug("[task-watcher] auto-claim is paused, skipping");
      return;
    }
    const ready = app.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.status, "ready"))
      .all();
    for (const row of ready) {
      try {
        const outcome = await claimTask(app, row.id, { auto: true });
        if (!outcome.ok) {
          // "cap" is expected and frequent once the install is at its
          // concurrency limit — debug, not warn, so a healthy install
          // running at capacity doesn't spam warn-level logs every sweep.
          const level = outcome.reason === "cap" ? "debug" : "warn";
          app.log[level](
            { taskId: row.id, reason: outcome.reason },
            "[task-watcher] auto-claim did not succeed",
          );
        }
      } catch (err) {
        app.log.error({ err, taskId: row.id }, "[task-watcher] auto-claim threw unexpectedly");
      }
    }
  }

  async function pollOnce(): Promise<void> {
    if (running) return;
    running = true;
    try {
      // Settings UI follow-up — Task Master's enabled state is now
      // runtime-toggleable (env default, overridable via
      // settings.taskMaster.enabled; see task-config.ts). Checked first,
      // before localProjectRows() and before any per-project token
      // resolution (#489 remaining scope — token resolution moved inside
      // syncProjectTasks, per project), so a disabled install does exactly
      // one settings SELECT per tick and nothing else — no GitHub calls,
      // no task queries, no auto-claim attempts.
      if (!resolveTaskMasterConfig(app).enabled) {
        app.log.debug("[task-watcher] Task Master is disabled, skipping sweep");
        return;
      }
      const label = app.config.MULLION_TASK_LABEL;
      const rows = localProjectRows();
      for (const row of rows) {
        await syncProjectTasks(row.id, row.cwd, label);
      }
      // Independent of whether a GitHub token is configured (Hermes/
      // independent review posture carried into 6.2): a locally-created
      // task can reach "ready" with no GitHub connection at all, and the
      // roadmap's local-board-works-regardless-of-GitHub decision means
      // auto-claim shouldn't silently stop working just because ingest
      // has nothing to do this sweep.
      await autoClaimReadyTasks();
    } catch (err) {
      app.log.error({ err }, "[task-watcher] poll cycle failed");
    } finally {
      running = false;
    }
  }

  const pollIntervalMs = app.config.MULLION_TASK_POLL_INTERVAL * 1000;
  const rows = localProjectRows();

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
        await syncProjectTasks(row.id, row.cwd, app.config.MULLION_TASK_LABEL);
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
