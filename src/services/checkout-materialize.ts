import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { projects } from "../db/schema.js";
import { MAX_HOST_CWDS } from "../shared/constants.js";
import { parseHostCwdsMeta, serializeHostCwdsMeta } from "./host-cwds-meta.js";
import { cloneHostCheckout } from "./host-git.js";
import { getHostRow, LOCAL_HOST_ID } from "./host-registry.js";
import { parseHostCwds, serializeHostCwds } from "./placement.js";
import { cloneNameFromRemote, cloneUrlFromRemote, warmProjectOriginUrl } from "./project-origin.js";
import { startSetupAfterClone } from "./setup-recipe.js";

// Lazy checkout materialization: clone a git project onto a host the first time
// something is placed there. A clone can take minutes, so it is a background
// job — never held inside an HTTP request or a Task Master claim tick. The job
// map is in memory (a restart forgets a running clone; the next placement just
// starts it again, and the clone endpoint reuses a finished checkout).
//
// After a successful clone, `runJob` starts the per-project setup recipe (#2245).

export type MaterializeState = "cloning" | "done" | "failed";

export interface MaterializeJob {
  projectId: number;
  hostId: string;
  state: MaterializeState;
  /** Set once `done`: the path now in `hostCwds`. */
  cwd?: string;
  /** Set once `failed`. */
  reason?: string;
  detail?: string;
  startedAt: number;
  finishedAt?: number;
}

/** How long a finished job stays readable (a polling launcher, a task tick). */
const FINISHED_TTL_MS = 10 * 60_000;
const MAX_JOBS = 500;

const jobs = new Map<string, MaterializeJob>();

function jobKey(projectId: number, hostId: string): string {
  return `${projectId}\0${hostId}`;
}

function prune(now: number): void {
  for (const [key, job] of jobs) {
    if (job.finishedAt !== undefined && now - job.finishedAt >= FINISHED_TTL_MS) jobs.delete(key);
  }
  while (jobs.size > MAX_JOBS) {
    const oldest = jobs.keys().next().value;
    if (oldest === undefined) break;
    jobs.delete(oldest);
  }
}

export function getMaterializeJob(projectId: number, hostId: string): MaterializeJob | undefined {
  prune(Date.now());
  return jobs.get(jobKey(projectId, hostId));
}

/** Drops a FAILED job and returns it, so a failure is reported to one caller once. */
export function takeFailedMaterialize(projectId: number, hostId: string): MaterializeJob | null {
  const job = jobs.get(jobKey(projectId, hostId));
  if (job?.state !== "failed") return null;
  jobs.delete(jobKey(projectId, hostId));
  return job;
}

export function clearMaterializeJobsForTests(): void {
  jobs.clear();
}

type WriteResult = { ok: true; cwd: string } | { ok: false; detail: string };

/**
 * Records the clone in `hostCwds` and `hostCwdsMeta.managed`, in one
 * transaction that RE-READS the row (same write style as `attachHostCheckout`):
 * a path the operator mapped while the clone ran wins and is never replaced.
 */
function recordManagedCheckout(
  app: FastifyInstance,
  projectId: number,
  hostId: string,
  cwd: string,
): WriteResult {
  return app.db.transaction((tx) => {
    const [row] = tx.select().from(projects).where(eq(projects.id, projectId)).all();
    if (!row) return { ok: false, detail: "the project no longer exists" } as const;
    const map = parseHostCwds(row.hostCwds);
    const meta = parseHostCwdsMeta(row.hostCwdsMeta);
    if (Object.hasOwn(map, hostId)) return { ok: true, cwd: map[hostId] } as const;
    if (Object.keys(map).length >= MAX_HOST_CWDS) {
      return { ok: false, detail: `a project can map at most ${MAX_HOST_CWDS} hosts` } as const;
    }
    // `hostId` is a registered host id; set through a Map so it can never be
    // a computed key on the prototype chain.
    const entries = new Map(Object.entries(map));
    entries.set(hostId, cwd);
    tx.update(projects)
      .set({
        hostCwds: serializeHostCwds(Object.fromEntries(entries)),
        hostCwdsMeta: serializeHostCwdsMeta({
          auto: meta.auto.filter((h) => h !== hostId),
          // A clone Mullion was asked to make is an explicit choice: it lifts a decline.
          declined: meta.declined.filter((h) => h !== hostId),
          managed: [...new Set([...meta.managed, hostId])],
        }),
      })
      .where(eq(projects.id, projectId))
      .run();
    return { ok: true, cwd } as const;
  });
}

async function runJob(app: FastifyInstance, job: MaterializeJob): Promise<void> {
  const fail = (reason: string, detail: string): void => {
    job.state = "failed";
    job.reason = reason;
    job.detail = detail;
    job.finishedAt = Date.now();
    app.log.warn(
      { projectId: job.projectId, hostId: job.hostId, reason, detail },
      "[checkout-materialize] clone failed",
    );
  };
  try {
    const [project] = app.db.select().from(projects).where(eq(projects.id, job.projectId)).all();
    if (!project) return fail("failed", "the project no longer exists");
    const url = await warmProjectOriginUrl(app, project);
    const cloneUrl = url === null ? null : cloneUrlFromRemote(url);
    const name = url === null ? null : cloneNameFromRemote(url);
    if (cloneUrl === null || name === null) {
      return fail("failed", "the project has no git origin Mullion can clone over https");
    }
    const result = await cloneHostCheckout(app, job.hostId, { url: cloneUrl, name });
    if (!result.ok) {
      return fail(result.reason, `could not reach the host (${result.reason})`);
    }
    if (!result.value.ok) return fail(result.value.reason, result.value.detail);
    const written = recordManagedCheckout(app, job.projectId, job.hostId, result.value.cwd);
    if (!written.ok) return fail("failed", written.detail);
    job.state = "done";
    job.cwd = written.cwd;
    job.finishedAt = Date.now();
    app.log.info(
      { projectId: job.projectId, hostId: job.hostId, cwd: written.cwd },
      "[checkout-materialize] checkout ready",
    );
    // Install dependencies in the fresh checkout; fire-and-forget, never fails the job.
    startSetupAfterClone(app, project, job.hostId, written.cwd);
  } catch (err) {
    fail("failed", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Starts the clone of `projectId` onto `hostId`, or joins the one already
 * running. A host the project already has a path on is `done` at once. Never
 * throws and never waits for the clone: poll `getMaterializeJob`.
 */
export function startMaterialize(
  app: FastifyInstance,
  projectId: number,
  hostId: string,
): MaterializeJob {
  const key = jobKey(projectId, hostId);
  const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
  const now = Date.now();
  const existing = jobs.get(key);
  if (existing?.state === "cloning") return existing;
  if (
    project &&
    (hostId === project.hostId || Object.hasOwn(parseHostCwds(project.hostCwds), hostId))
  ) {
    const cwd = hostId === project.hostId ? project.cwd : parseHostCwds(project.hostCwds)[hostId];
    const done: MaterializeJob = {
      projectId,
      hostId,
      state: "done",
      cwd,
      startedAt: now,
      finishedAt: now,
    };
    jobs.set(key, done);
    return done;
  }
  const job: MaterializeJob = { projectId, hostId, state: "cloning", startedAt: now };
  jobs.set(key, job);
  if (!project) {
    job.state = "failed";
    job.reason = "failed";
    job.detail = "the project no longer exists";
    job.finishedAt = now;
    return job;
  }
  if (hostId !== LOCAL_HOST_ID && !getHostRow(app, hostId)) {
    job.state = "failed";
    job.reason = "failed";
    job.detail = `unknown host ${hostId}`;
    job.finishedAt = now;
    return job;
  }
  void runJob(app, job);
  return job;
}

/** Words for a hold or a refusal that waits on a clone. */
export function describePreparing(hostId: string): string {
  return `preparing checkout on ${hostId}`;
}
