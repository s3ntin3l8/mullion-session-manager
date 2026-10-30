import type { FastifyInstance } from "fastify";
import { and, eq, inArray, isNull, like, sql } from "drizzle-orm";
import { MAX_HOST_CWDS } from "../shared/constants.js";
import {
  browserCookies,
  devices,
  previews,
  projectPreviewTargets,
  projectTooling,
  projectUrls,
  projects,
  sessionBrowsers,
  sessions,
  tasks,
  webhookRegistrations,
} from "../db/schema.js";
import { parseHostCwds, serializeHostCwds } from "./placement.js";
import { parseHostCwdsMeta, serializeHostCwdsMeta } from "./host-cwds-meta.js";
import { buildOriginIndex } from "./repo-identity.js";
import { notifyOperator } from "./push-delivery.js";
import { broadcastTaskEvent } from "./task-events.js";

// Issue #2232 — merge a duplicate project into its same-repo survivor. The
// duplicate's rows are re-pointed at the survivor in ONE synchronous
// transaction (better-sqlite3: nothing awaited inside), then the duplicate row
// is deleted. Running sessions move too: a session is identified by its host
// and dtach socket, and the survivor gains the duplicate's path in `hostCwds`,
// so cwd resolution keeps working.
//
// The shared GitHub webhook is deliberately NOT unregistered: the survivor is
// on the same repo and relies on it (compare DELETE /api/projects/:id, #2251).
// The duplicate's registration row is just dropped.

type ProjectRow = typeof projects.$inferSelect;

export type MergeRefusalCode =
  | "NOT_FOUND"
  | "SAME_PROJECT"
  | "SAME_HOST"
  | "HOST_PATH_CONFLICT"
  | "HOST_CWDS_LIMIT"
  | "STACK_IDENTITY_CONFLICT"
  | "LIVE_TASK_CONFLICT";

export interface MergeRefusal {
  code: MergeRefusalCode;
  message: string;
}

/** What a merge would move, for the confirm dialog and the result. */
export interface MergeCounts {
  tasks: number;
  liveTasks: number;
  sessions: number;
  runningSessions: number;
  previews: number;
}

export interface DuplicateMember {
  id: number;
  name: string;
  hostId: string;
  cwd: string;
  createdAt: string;
}

export interface DuplicateEntry extends DuplicateMember {
  counts: MergeCounts;
  /** Why merging this project into the survivor would be refused right now. */
  refusal: MergeRefusal | null;
}

export interface DuplicateGroup {
  /** The group's shared origin key (the same key the create gate uses). */
  origin: string;
  survivor: DuplicateMember;
  duplicates: DuplicateEntry[];
}

/** Task statuses that mean a worker is (or was just) on the task. */
const LIVE_TASK_STATUSES = ["claimed", "in_progress", "reviewing"];

/** Not-yet-started statuses: an archived copy in one of these must leave the queue (a ready one would auto-claim). */
const QUEUED_TASK_STATUSES = ["ready", "backlog"];

/** Settings copied from the duplicate only where the survivor's value is null.
 * `allowCrossProjectSpawn` is deliberately not here: it widens what a session may do,
 * so it is never inherited silently.
 * `placement` is not here: it is NOT NULL, so the survivor's always wins. */
const FILLABLE_SETTINGS = [
  "autoApprove",
  "mergeOnApprove",
  "defaultAgent",
  "defaultReviewAgent",
  "maxAutoReturnRounds",
  "conventionalCommitTitles",
  "autoTagRelease",
  "injectAgentGuide",
  "injectProjectBriefing",
  "injectWorkflowConventions",
  "devServerUrl",
  "autoFetch",
  // Issue #2241 — the placement steering flags; null = unset on the survivor.
  "placementConstraints",
] as const satisfies readonly (keyof ProjectRow)[];

function byAge(a: ProjectRow, b: ProjectRow): number {
  return a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id;
}

function member(p: ProjectRow): DuplicateMember {
  return {
    id: p.id,
    name: p.name,
    hostId: p.hostId,
    cwd: p.cwd,
    createdAt: p.createdAt.toISOString(),
  };
}

function activeStackNames(app: FastifyInstance, projectId: number): string[] {
  return app.db
    .select({ name: sessions.name })
    .from(sessions)
    .where(
      and(
        eq(sessions.projectId, projectId),
        eq(sessions.kind, "dock"),
        eq(sessions.status, "active"),
        like(sessions.name, "docker-stack:%"),
      ),
    )
    .all()
    .map((s) => s.name)
    .filter((n): n is string => n !== null);
}

/** The survivor's map plus the duplicate's own entry and any other host it maps.
 * The survivor's existing entries win and its own host is never mapped. */
function mergedHostCwds(survivor: ProjectRow, duplicate: ProjectRow): Record<string, string> {
  const merged = new Map(Object.entries(parseHostCwds(duplicate.hostCwds)));
  for (const [h, p] of Object.entries(parseHostCwds(survivor.hostCwds))) merged.set(h, p);
  merged.delete(survivor.hostId);
  merged.set(duplicate.hostId, duplicate.cwd);
  return Object.fromEntries(merged);
}

/** An issue number with a live task in BOTH projects, or null. Archiving the
 * survivor's copy would orphan its worker. */
function liveTaskClash(app: FastifyInstance, survivorId: number, duplicateId: number) {
  const live = (id: number) =>
    app.db
      .select({ issueNumber: tasks.issueNumber })
      .from(tasks)
      .where(and(eq(tasks.projectId, id), inArray(tasks.status, LIVE_TASK_STATUSES)))
      .all()
      .map((t) => t.issueNumber)
      .filter((n): n is number => n !== null);
  const mine = new Set(live(survivorId));
  return live(duplicateId).find((n) => mine.has(n)) ?? null;
}

/** Why `duplicate` cannot be merged into `survivor`, or null. Synchronous, so
 * the transaction can repeat it against freshly read rows. */
function checkMergeable(
  app: FastifyInstance,
  survivor: ProjectRow,
  duplicate: ProjectRow,
): MergeRefusal | null {
  if (survivor.id === duplicate.id) {
    return { code: "SAME_PROJECT", message: "A project cannot be merged into itself." };
  }
  if (survivor.hostId === duplicate.hostId) {
    return {
      code: "SAME_HOST",
      message:
        "Both projects live on the same host, so they are two checkouts there rather than one repo on two hosts. Merge is for a project's clone on another host.",
    };
  }
  const map = parseHostCwds(survivor.hostCwds);
  if (Object.hasOwn(map, duplicate.hostId) && map[duplicate.hostId] !== duplicate.cwd) {
    return {
      code: "HOST_PATH_CONFLICT",
      message: `The survivor already maps this host to a different path (${map[duplicate.hostId]}). Edit that mapping first.`,
    };
  }
  if (Object.keys(mergedHostCwds(survivor, duplicate)).length > MAX_HOST_CWDS) {
    return {
      code: "HOST_CWDS_LIMIT",
      message: `The merged project would map more than ${MAX_HOST_CWDS} hosts.`,
    };
  }
  const liveClash = liveTaskClash(app, survivor.id, duplicate.id);
  if (liveClash !== null) {
    return {
      code: "LIVE_TASK_CONFLICT",
      message: `Issue #${liveClash} has a live task in both projects. Finish or give up one first.`,
    };
  }
  const taken = new Set(activeStackNames(app, survivor.id));
  const clash = activeStackNames(app, duplicate.id).filter((n) => taken.has(n));
  if (clash.length > 0) {
    return {
      code: "STACK_IDENTITY_CONFLICT",
      message: `Both projects have an active docker stack session (${clash.join(", ")}). Stop one first.`,
    };
  }
  return null;
}

function countRows(app: FastifyInstance, projectId: number): MergeCounts {
  const taskRows = app.db
    .select({ status: tasks.status })
    .from(tasks)
    .where(eq(tasks.projectId, projectId))
    .all();
  const sessionRows = app.db
    .select({ status: sessions.status })
    .from(sessions)
    .where(eq(sessions.projectId, projectId))
    .all();
  const previewCount = app.db
    .select({ n: sql<number>`count(*)` })
    .from(previews)
    .where(eq(previews.projectId, projectId))
    .get();
  return {
    tasks: taskRows.length,
    liveTasks: taskRows.filter((t) => LIVE_TASK_STATUSES.includes(t.status)).length,
    sessions: sessionRows.length,
    runningSessions: sessionRows.filter((s) => s.status === "active").length,
    previews: previewCount?.n ?? 0,
  };
}

/**
 * Groups of projects that share one origin (the create gate's key, so the two
 * agree). The survivor of a group is its oldest project. Best-effort like the
 * gate: a project whose origin cannot be read is simply not in any group.
 */
export async function findDuplicateGroups(app: FastifyInstance): Promise<DuplicateGroup[]> {
  const rows = app.db.select().from(projects).all();
  const index = await buildOriginIndex(app, { projects: rows });
  const byOrigin = new Map<string, ProjectRow[]>();
  for (const p of rows) {
    const key = index.get(p.id);
    if (!key) continue;
    byOrigin.set(key, [...(byOrigin.get(key) ?? []), p]);
  }
  const groups: DuplicateGroup[] = [];
  for (const [origin, members] of byOrigin) {
    if (members.length < 2) continue;
    const [survivor, ...rest] = [...members].sort(byAge);
    groups.push({
      origin,
      survivor: member(survivor),
      duplicates: rest.map((d) => ({
        ...member(d),
        counts: countRows(app, d.id),
        refusal: checkMergeable(app, survivor, d),
      })),
    });
  }
  return groups.sort((a, b) => a.survivor.id - b.survivor.id);
}

interface DuplicateCache {
  groups: DuplicateGroup[] | null;
  computedAt: number;
  /** One scan at a time: concurrent misses and forced refreshes share it. */
  inflight: { generation: number; promise: Promise<DuplicateGroup[]> } | null;
  /** Bumped by every invalidation, so a read that started before one is not cached. */
  generation: number;
  /** Origin keys already announced on the bell; in memory only, so a restart may announce again. */
  announced: Set<string>;
  timer: NodeJS.Timeout | null;
}

const duplicateCaches = new WeakMap<FastifyInstance, DuplicateCache>();

function cacheFor(app: FastifyInstance): DuplicateCache {
  let cache = duplicateCaches.get(app);
  if (!cache) {
    cache = {
      groups: null,
      computedAt: 0,
      inflight: null,
      generation: 0,
      announced: new Set(),
      timer: null,
    };
    duplicateCaches.set(app, cache);
  }
  return cache;
}

/** Notifies once per origin key that has not been announced before. */
function announceNewDuplicates(
  app: FastifyInstance,
  cache: DuplicateCache,
  groups: DuplicateGroup[],
) {
  const present = new Set(groups.map((g) => g.origin));
  // A group that merged away may reappear later; that is news again.
  for (const key of cache.announced) if (!present.has(key)) cache.announced.delete(key);
  const fresh = groups.filter((g) => !cache.announced.has(g.origin));
  if (fresh.length === 0) return;
  for (const g of fresh) cache.announced.add(g.origin);
  const projectCount = fresh.reduce((n, g) => n + 1 + g.duplicates.length, 0);
  const body =
    fresh.length === 1
      ? `${projectCount} projects point at the same repository — merge them in Settings → Projects`
      : `${projectCount} projects point at the same ${fresh.length} repositories — merge them in Settings → Projects`;
  void notifyOperator(app, body).catch((err) =>
    app.log.warn({ err }, "project merge: duplicate-projects notification failed"),
  );
}

/**
 * A cached answer older than this is recomputed: the scan is best-effort (an
 * offline host's projects have no readable origin and drop out), so a miss
 * made while a host was asleep must not be served forever.
 */
const CACHE_TTL_MS = 5 * 60_000;

/**
 * The duplicate groups, from a cache that create/edit/delete/merge invalidate.
 * Finding them reads every project's origin (one discovery call per remote
 * host), so `refresh` is for an explicit operator check. Concurrent scans of
 * the same cache generation share one read.
 */
export async function getDuplicateGroups(
  app: FastifyInstance,
  opts: { refresh?: boolean } = {},
): Promise<DuplicateGroup[]> {
  const cache = cacheFor(app);
  if (!opts.refresh && cache.groups && Date.now() - cache.computedAt < CACHE_TTL_MS) {
    return cache.groups;
  }
  const generation = cache.generation;
  if (cache.inflight?.generation === generation) return cache.inflight.promise;
  const promise = findDuplicateGroups(app)
    .then((groups) => {
      if (generation === cache.generation) {
        cache.groups = groups;
        cache.computedAt = Date.now();
        announceNewDuplicates(app, cache, groups);
      }
      return groups;
    })
    .finally(() => {
      if (cache.inflight?.promise === promise) cache.inflight = null;
    });
  cache.inflight = { generation, promise };
  return promise;
}

/** Drops the cached result: the next read recomputes. */
function invalidateDuplicateGroups(app: FastifyInstance): void {
  const cache = cacheFor(app);
  cache.generation++;
  cache.groups = null;
}

/** How long a burst of project edits settles before the recompute reads every origin. */
const RECOMPUTE_DELAY_MS = 5_000;

/**
 * Invalidates now and recomputes a little later, without making the caller
 * wait (a failure is only logged). Repeated calls coalesce into one recompute.
 */
export function refreshDuplicateGroupsInBackground(
  app: FastifyInstance,
  delayMs = RECOMPUTE_DELAY_MS,
): void {
  invalidateDuplicateGroups(app);
  const cache = cacheFor(app);
  if (cache.timer) clearTimeout(cache.timer);
  cache.timer = setTimeout(() => {
    cache.timer = null;
    void getDuplicateGroups(app, { refresh: true }).catch((err) =>
      app.log.warn({ err }, "project merge: duplicate-groups recompute failed"),
    );
  }, delayMs);
  cache.timer.unref();
}

/** Drops a pending background recompute (the app is closing). */
export function cancelDuplicateRefresh(app: FastifyInstance): void {
  const cache = cacheFor(app);
  if (cache.timer) clearTimeout(cache.timer);
  cache.timer = null;
}

export type MergeResult =
  { ok: true; counts: MergeCounts; movedTaskIds: number[] } | { ok: false; refusal: MergeRefusal };

/**
 * Merges `duplicateId` into `survivorId`. Refuses (changing nothing) when the
 * move cannot be expressed; otherwise runs one synchronous transaction.
 * Whether the two actually share a repo is the caller's call (the route checks
 * it against `findDuplicateGroups`' key); this function re-points whatever it
 * is told to.
 */
export function mergeProjects(
  app: FastifyInstance,
  opts: { survivorId: number; duplicateId: number },
): MergeResult {
  const result = app.db.transaction((tx): MergeResult => {
    const survivor = tx.select().from(projects).where(eq(projects.id, opts.survivorId)).get();
    const duplicate = tx.select().from(projects).where(eq(projects.id, opts.duplicateId)).get();
    if (!survivor || !duplicate) {
      return { ok: false, refusal: { code: "NOT_FOUND", message: "Project not found." } };
    }
    // Re-run against the rows this transaction reads: a mapping or a stack
    // session that landed since the route looked still refuses.
    const refusal = checkMergeable(app, survivor, duplicate);
    if (refusal) return { ok: false, refusal };

    const counts = countRows(app, duplicate.id);
    const from = duplicate.id;
    const to = survivor.id;

    // Settings: fill only what the survivor leaves unset.
    const fill: Partial<
      Pick<
        typeof projects.$inferInsert,
        (typeof FILLABLE_SETTINGS)[number] | "conventionalCommitTitlesResolvedAt"
      >
    > = {};
    for (const key of FILLABLE_SETTINGS) {
      if (survivor[key] === null && duplicate[key] !== null)
        Object.assign(fill, { [key]: duplicate[key] });
    }

    if (fill.conventionalCommitTitles !== undefined) {
      fill.conventionalCommitTitlesResolvedAt = duplicate.conventionalCommitTitlesResolvedAt;
    }

    // hostCwds: the duplicate's host+cwd, written the way attachHostCheckout
    // does (an operator-set entry, any earlier decline for the host cleared).
    const meta = parseHostCwdsMeta(survivor.hostCwdsMeta);
    tx.update(projects)
      .set({
        ...fill,
        hostCwds: serializeHostCwds(mergedHostCwds(survivor, duplicate)),
        hostCwdsMeta: serializeHostCwdsMeta({
          auto: meta.auto.filter((h) => h !== duplicate.hostId),
          declined: meta.declined.filter((h) => h !== duplicate.hostId),
        }),
      })
      .where(eq(projects.id, to))
      .run();

    // Plain re-points (no unique index involving project_id).
    // Rows from before #1722 have no host of their own and inherit the
    // project's: pin them to the duplicate's host before they change project.
    tx.update(sessions)
      .set({ hostId: duplicate.hostId })
      .where(and(eq(sessions.projectId, from), isNull(sessions.hostId)))
      .run();
    tx.update(sessions).set({ projectId: to }).where(eq(sessions.projectId, from)).run();
    tx.update(sessionBrowsers)
      .set({ projectId: to })
      .where(eq(sessionBrowsers.projectId, from))
      .run();
    tx.update(devices).set({ projectId: to }).where(eq(devices.projectId, from)).run();
    tx.update(projectUrls).set({ projectId: to }).where(eq(projectUrls.projectId, from)).run();
    tx.update(projectPreviewTargets)
      .set({ projectId: to })
      .where(eq(projectPreviewTargets.projectId, from))
      .run();

    // previews: unique (project_id, branch) for kind 'project' — the
    // survivor's row wins, the duplicate's conflicting one is dropped.
    const survivorBranches = tx
      .select({ branch: previews.branch })
      .from(previews)
      .where(and(eq(previews.projectId, to), eq(previews.kind, "project")))
      .all()
      .map((r) => r.branch);
    if (survivorBranches.length > 0) {
      tx.delete(previews)
        .where(
          and(
            eq(previews.projectId, from),
            eq(previews.kind, "project"),
            inArray(previews.branch, survivorBranches),
          ),
        )
        .run();
    }
    tx.update(previews).set({ projectId: to }).where(eq(previews.projectId, from)).run();

    // browser_cookies: unique (project_id, label); survivor wins.
    const cookieLabels = tx
      .select({ label: browserCookies.label })
      .from(browserCookies)
      .where(eq(browserCookies.projectId, to))
      .all()
      .map((r) => r.label);
    if (cookieLabels.length > 0) {
      tx.delete(browserCookies)
        .where(and(eq(browserCookies.projectId, from), inArray(browserCookies.label, cookieLabels)))
        .run();
    }
    tx.update(browserCookies)
      .set({ projectId: to })
      .where(eq(browserCookies.projectId, from))
      .run();

    // project_tooling: one row per project; survivor wins, else move.
    const survivorTooling = tx
      .select({ id: projectTooling.id })
      .from(projectTooling)
      .where(eq(projectTooling.projectId, to))
      .get();
    if (survivorTooling) {
      tx.delete(projectTooling).where(eq(projectTooling.projectId, from)).run();
    } else {
      tx.update(projectTooling)
        .set({ projectId: to })
        .where(eq(projectTooling.projectId, from))
        .run();
    }

    // The hook is shared with the survivor, so it is never unregistered. The
    // survivor keeps its own row; with none, the duplicate's moves over so the
    // hook stays tracked.
    const survivorHook = tx
      .select({ id: webhookRegistrations.id })
      .from(webhookRegistrations)
      .where(eq(webhookRegistrations.projectId, to))
      .get();
    if (survivorHook) {
      tx.delete(webhookRegistrations).where(eq(webhookRegistrations.projectId, from)).run();
    } else {
      tx.update(webhookRegistrations)
        .set({ projectId: to })
        .where(eq(webhookRegistrations.projectId, from))
        .run();
    }

    // tasks: unique (project_id, issue_number).
    const movedTaskIds: number[] = [];
    const now = new Date();
    const dupTasks = tx.select().from(tasks).where(eq(tasks.projectId, from)).all();
    for (const t of dupTasks) {
      const live = LIVE_TASK_STATUSES.includes(t.status);
      const clash =
        t.issueNumber === null
          ? undefined
          : tx
              .select()
              .from(tasks)
              .where(and(eq(tasks.projectId, to), eq(tasks.issueNumber, t.issueNumber)))
              .get();
      if (clash && !live) {
        // The survivor already tracks this issue and nothing is running on the
        // duplicate's copy: keep the history, off the board, off the index.
        tx.update(tasks)
          .set({
            projectId: to,
            issueNumber: null,
            archivedAt: t.archivedAt ?? now,
            failureReason: t.failureReason ?? `Merged from project #${from}: superseded.`,
            ...(QUEUED_TASK_STATUSES.includes(t.status) ? { status: "failed" as const } : {}),
          })
          .where(eq(tasks.id, t.id))
          .run();
        movedTaskIds.push(t.id);
        continue;
      }
      if (clash) {
        // A live duplicate replaces the survivor's copy, which is archived with
        // its issue number cleared (NULLs do not collide) so it keeps its history.
        tx.update(tasks)
          .set({
            issueNumber: null,
            archivedAt: clash.archivedAt ?? now,
            failureReason:
              clash.failureReason ?? `Replaced by task #${t.id} when project #${from} was merged.`,
            ...(QUEUED_TASK_STATUSES.includes(clash.status) ? { status: "failed" as const } : {}),
          })
          .where(eq(tasks.id, clash.id))
          .run();
        movedTaskIds.push(clash.id);
      }
      tx.update(tasks).set({ projectId: to }).where(eq(tasks.id, t.id)).run();
      movedTaskIds.push(t.id);
    }

    // Everything that mattered has moved; nothing cascades but leftovers.
    tx.delete(projects).where(eq(projects.id, from)).run();
    return { ok: true, counts, movedTaskIds };
  });

  if (result.ok) {
    // Live local sessions keep their project id in memory: re-key them.
    app.pty.repointProject(opts.duplicateId, opts.survivorId);
    // The browser pool is keyed by project id: close the merged-away project's
    // Chromium (it would keep counting against the pool until a restart). A
    // session bound to it relaunches one under the survivor on next use.
    app.browser.closeForProject(opts.duplicateId).catch((err) => {
      app.log.warn({ err, projectId: opts.duplicateId }, "merge: failed to close project browser");
    });
    // The board refetches on "ingested"; DELETE broadcasts nothing, so the
    // frontend also refreshes the project list itself.
    for (const taskId of result.movedTaskIds) {
      broadcastTaskEvent({ taskId, projectId: opts.survivorId, kind: "ingested", ts: Date.now() });
    }
  }
  return result;
}
