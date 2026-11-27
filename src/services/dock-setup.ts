// Issue #3588 — a dock control session (a Dock start, a branch preview, a
// control started on another host) waits for the project's setup recipe
// before its command runs, on the host it runs on.
//
// Agent sessions keep #2245's fire-and-forget recipe (`startSetupRecipe`): an
// agent can start reading code while `npm ci` runs. A dev server cannot — it
// exits on the first missing module, and a branch preview's worktree is
// cleaned up with it, so nothing is left to say why. So createSessionRecord
// calls `prepareDockCheckout` for a `kind: "dock"` launch BEFORE the session
// row exists or anything is spawned: a failed or timed-out recipe fails the
// start with the log's tail as its reason, and no command runs.
//
// When it runs:
//  - a worktree just cut for the session (a branch preview, a Dock start on a
//    branch): always, like #2245 — the tree starts with no dependencies;
//  - the project's checkout on ANOTHER host (Dock "Run on: <host>"): only when
//    the fingerprint of its lockfiles differs from the last successful run
//    there (`setup_stamps`), so an unchanged checkout is not reinstalled on
//    every start;
//  - the project's own checkout on its own host: never. That is the user's
//    working tree; an install there could pull `node_modules` out from under
//    whatever else runs in it.

import { createHash } from "node:crypto";
import { unlinkSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { sessions, setupStamps, type projects } from "../db/schema.js";
import { readHostFiles } from "./host-files.js";
import { viaRemote } from "./host-git.js";
import { LOCAL_HOST_ID } from "./host-registry.js";
import {
  DEFAULT_SETUP_TIMEOUT_MS,
  readLocalSetupLog,
  runSetupOnHost,
  setupLogPath,
  type SetupRunResult,
} from "./setup-recipe.js";
import { stripTerminalEscapes } from "./terminal-text.js";
import type { DockSetupRun } from "../shared/types.js";

export type { DockSetupRun };

type ProjectRow = typeof projects.$inferSelect;

/** Lockfiles whose presence says "this tree needs an install" and whose
 * content says whether an install already done is still current. Checked at
 * the top of the session's directory only. */
export const LOCKFILES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "uv.lock",
  "poetry.lock",
  "Pipfile.lock",
  "Cargo.lock",
  "Gemfile.lock",
  "composer.lock",
  "go.sum",
] as const;

/** How many lines of the recipe log a failed start reports. */
export const SETUP_FAILURE_TAIL_LINES = 20;
/** A busy directory (another run in flight there) is re-asked this often. */
const BUSY_RETRY_MS = 2000;

export type DockSetupRunner = (
  app: FastifyInstance,
  hostId: string,
  opts: { cwd: string; recipe: string; logKey: string },
) => Promise<SetupRunResult>;

let runner: DockSetupRunner = runSetupOnHost;
let busyRetryMs = BUSY_RETRY_MS;

/** Test-only: swap the recipe runner (a fake that is slow, fails, or
 * succeeds), or restore the real one with no argument. */
export function setDockSetupRunnerForTests(fn?: DockSetupRunner, retryMs?: number): void {
  runner = fn ?? runSetupOnHost;
  busyRetryMs = retryMs ?? BUSY_RETRY_MS;
}

const installing = new Map<number, DockSetupRun>();
let nextRunId = 1;

export const DOCK_CONTROL_INSTALLING =
  "This control is already starting: its dependencies are being installed.";

/** Whether a start of `dockControlId` is waiting for its recipe right now. */
export function controlInstalling(projectId: number, dockControlId: string): boolean {
  return [...installing.values()].some(
    (r) => r.projectId === projectId && r.dockControlId === dockControlId,
  );
}

/** The dock starts of `projectId` waiting for their setup recipe right now. */
export function listDockSetups(projectId: number): DockSetupRun[] {
  return [...installing.values()].filter((r) => r.projectId === projectId);
}

// The log key is `dock-<projectId><slot>`: a slot is the lowest one free in
// the project while its run is in flight, so the logs on a host are bounded by
// how many dock installs ever ran at once, not by how many starts there were.
const slotsInUse = new Map<number, Set<number>>();
const MAX_SLOTS = 1000;

function takeSlot(projectId: number): number | null {
  let used = slotsInUse.get(projectId);
  if (!used) slotsInUse.set(projectId, (used = new Set()));
  for (let slot = 0; slot < MAX_SLOTS; slot++) {
    if (!used.has(slot)) {
      used.add(slot);
      return slot;
    }
  }
  return null;
}

function releaseSlot(projectId: number, slot: number): void {
  const used = slotsInUse.get(projectId);
  used?.delete(slot);
  if (used && used.size === 0) slotsInUse.delete(projectId);
}

/** `dock-<projectId><3-digit slot>`: a filename stem of digits, as
 * `setupLogPath` (and `/internal/run-setup`'s schema) require. */
export function dockSetupLogKey(projectId: number, slot: number): string {
  return `dock-${projectId}${String(slot).padStart(3, "0")}`;
}

export type Fingerprint = { ok: true; lockfiles: string[]; hash: string } | { ok: false };

/** The lockfiles at the top of `cwd` on `hostId` and a hash over their names
 * and content. A read the host could not answer is `ok: false`. */
export async function lockfileFingerprint(
  app: FastifyInstance,
  hostId: string,
  cwd: string,
): Promise<Fingerprint> {
  let read;
  try {
    read = await readHostFiles(app, hostId, cwd, [...LOCKFILES]);
  } catch {
    return { ok: false };
  }
  if (!read.ok) return { ok: false };
  const hash = createHash("sha256");
  const lockfiles: string[] = [];
  for (const name of LOCKFILES) {
    const content = read.value[name];
    if (content === undefined) continue;
    lockfiles.push(name);
    hash.update(`${name}\0${content.length}\0`);
    hash.update(content);
  }
  return { ok: true, lockfiles, hash: hash.digest("hex") };
}

function storedStamp(app: FastifyInstance, projectId: number, hostId: string, cwd: string) {
  const [row] = app.db
    .select()
    .from(setupStamps)
    .where(
      and(
        eq(setupStamps.projectId, projectId),
        eq(setupStamps.hostId, hostId),
        eq(setupStamps.cwd, cwd),
      ),
    )
    .all();
  return row;
}

function recordStamp(
  app: FastifyInstance,
  projectId: number,
  hostId: string,
  cwd: string,
  lockfileHash: string,
): void {
  app.db
    .insert(setupStamps)
    .values({ projectId, hostId, cwd, lockfileHash, ranAt: new Date() })
    .onConflictDoUpdate({
      target: [setupStamps.projectId, setupStamps.hostId, setupStamps.cwd],
      set: { lockfileHash, ranAt: new Date() },
    })
    .run();
}

/** The last `lines` non-blank lines of a recipe log, escapes stripped. */
export function logTail(text: string, lines = SETUP_FAILURE_TAIL_LINES): string {
  const all = stripTerminalEscapes(text)
    .split(/\r?\n/)
    .map((l) => l.trimEnd());
  while (all.length > 0 && all[all.length - 1] === "") all.pop();
  return all.slice(-lines).join("\n");
}

async function readRunLog(
  app: FastifyInstance,
  hostId: string,
  logKey: string,
): Promise<string | null> {
  if (hostId === LOCAL_HOST_ID) {
    return readLocalSetupLog(app.config.SESSIONS_DIR, logKey)?.content ?? null;
  }
  const result = await viaRemote(
    app,
    hostId,
    (client) => client.resolveSetupLog(logKey),
    "setup",
  ).catch(() => null);
  return result?.ok ? result.value.content : null;
}

/** Runs the recipe, waiting out another run already in flight in the same
 * directory (`busy`) instead of starting the command beside a half-finished
 * install. Bounded by the recipe's own timeout. */
async function runWaitingForBusy(
  app: FastifyInstance,
  hostId: string,
  opts: { cwd: string; recipe: string; logKey: string },
  alreadyDone: () => boolean,
): Promise<SetupRunResult> {
  // The wait for another run is bounded by one recipe timeout, and so is this
  // run: a start waits at most twice the timeout (DOCK_START_TIMEOUT_MS).
  const deadline = Date.now() + DEFAULT_SETUP_TIMEOUT_MS;
  let waited = false;
  for (;;) {
    // The run we waited for may have done the job (a stamped checkout).
    if (waited && alreadyDone()) return { outcome: "ok", exitCode: 0, logPath: "" };
    const result = await runner(app, hostId, opts);
    if (result.outcome !== "busy") return result;
    waited = true;
    if (Date.now() >= deadline) {
      return {
        outcome: "timeout",
        exitCode: null,
        logPath: result.logPath,
        detail: "another setup run in this directory did not finish in time",
      };
    }
    await new Promise((r) => setTimeout(r, busyRetryMs));
  }
}

export type DockSetupOutcome =
  { ok: true; hint: "no-recipe" | null } | { ok: false; detail: string };

/**
 * Makes the checkout a dock session is about to run in ready: runs the
 * project's setup recipe there and waits for it when the rules at the top of
 * this file say so. Never throws. `ok: false` carries the reason the start
 * fails with (the outcome and the log's tail); nothing was spawned.
 */
export async function prepareDockCheckout(
  app: FastifyInstance,
  project: Pick<ProjectRow, "id" | "setupRecipe" | "hostId">,
  target: {
    hostId: string;
    cwd: string;
    freshWorktree: boolean;
    dockControlId?: string | null;
    branch?: string | null;
  },
): Promise<DockSetupOutcome> {
  const otherHostCheckout = !target.freshWorktree && target.hostId !== project.hostId;
  if (!target.freshWorktree && !otherHostCheckout) return { ok: true, hint: null };
  const recipe = project.setupRecipe?.trim();
  const fingerprint = await lockfileFingerprint(app, target.hostId, target.cwd);
  if (!recipe) {
    // Nothing is guessed or run: the operator sets a recipe (Edit project).
    const hasLockfile = fingerprint.ok && fingerprint.lockfiles.length > 0;
    return { ok: true, hint: hasLockfile ? "no-recipe" : null };
  }
  // The stamp covers the lockfiles AND the recipe: a changed recipe re-runs.
  const stampHash = fingerprint.ok
    ? createHash("sha256").update(`${fingerprint.hash}\0${recipe}`).digest("hex")
    : null;
  const stamped = () =>
    otherHostCheckout &&
    stampHash !== null &&
    storedStamp(app, project.id, target.hostId, target.cwd)?.lockfileHash === stampHash;
  if (stamped()) return { ok: true, hint: null };
  // One install per control at a time: a second start of a control that is
  // already installing would otherwise run its command twice.
  if (target.dockControlId && controlInstalling(project.id, target.dockControlId)) {
    return { ok: false, detail: DOCK_CONTROL_INSTALLING };
  }

  const slot = takeSlot(project.id);
  if (slot === null) {
    return { ok: false, detail: "Too many dependency installs are running for this project." };
  }
  const logKey = dockSetupLogKey(project.id, slot);
  const runId = nextRunId++;
  installing.set(runId, {
    projectId: project.id,
    hostId: target.hostId,
    dockControlId: target.dockControlId ?? null,
    branch: target.branch ?? null,
    startedAt: Date.now(),
  });
  try {
    let result: SetupRunResult;
    try {
      result = await runWaitingForBusy(
        app,
        target.hostId,
        { cwd: target.cwd, recipe, logKey },
        stamped,
      );
    } catch (err) {
      result = {
        outcome: "failed",
        exitCode: null,
        logPath: "",
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    if (result.outcome === "ok") {
      // Stamped only for a checkout that stays: a fresh worktree is always
      // reinstalled, and its path may be cut again from another commit.
      if (otherHostCheckout && stampHash !== null) {
        recordStamp(app, project.id, target.hostId, target.cwd, stampHash);
      }
      if (target.hostId === LOCAL_HOST_ID) removeLocalLog(app, logKey);
      return { ok: true, hint: null };
    }
    if (target.hostId !== LOCAL_HOST_ID && result.detail === "invalid setup log key") {
      // An agent older than #3588 does not know the `dock-<n>` log key.
      return {
        ok: false,
        detail: `Host ${target.hostId} is too old to install dependencies before a dock start — update it.`,
      };
    }
    const log = await readRunLog(app, target.hostId, logKey);
    const tail = log ? logTail(log) : "";
    const what =
      result.outcome === "timeout"
        ? `timed out${result.detail ? ` (${result.detail})` : ""}`
        : result.exitCode !== null
          ? `failed (exit code ${result.exitCode})`
          : `failed${result.detail ? `: ${result.detail}` : ""}`;
    app.log.warn(
      { projectId: project.id, hostId: target.hostId, outcome: result.outcome },
      "dock start: the setup recipe did not succeed; the command was not run",
    );
    return {
      ok: false,
      detail: `Installing dependencies ${what}; the command was not run.${tail ? `\n${tail}` : ""}`,
    };
  } finally {
    installing.delete(runId);
    releaseSlot(project.id, slot);
  }
}

function removeLocalLog(app: FastifyInstance, logKey: string): void {
  try {
    unlinkSync(setupLogPath(app.config.SESSIONS_DIR, logKey));
  } catch {
    // Nothing there, or already gone.
  }
}

/**
 * createSessionRecord's step: for a `kind: "dock"` launch, `prepareDockCheckout`
 * in the directory the session will run in; any other launch passes through.
 * `waited` tells the caller the recipe question is settled (so the agent
 * sessions' fire-and-forget recipe must not run it again).
 */
export async function prepareDockLaunch(
  app: FastifyInstance,
  project: Pick<ProjectRow, "id" | "setupRecipe" | "hostId">,
  params: {
    kind?: string;
    dockControlId?: string;
    worktree?: { branch?: string };
    previewPort?: number;
  },
  target: { hostId: string; cwd: string; freshWorktree: boolean },
): Promise<
  (DockSetupOutcome & { ok: true; waited: boolean }) | (DockSetupOutcome & { ok: false })
> {
  // A dev server: a dock control's session, or a branch preview's (which
  // carries its port). Docker logs/stack sessions are `kind: "dock"` too, and
  // never wait.
  const devServer = params.dockControlId !== undefined || params.previewPort !== undefined;
  if (params.kind !== "dock" || !devServer) return { ok: true, hint: null, waited: false };
  const outcome = await prepareDockCheckout(app, project, {
    ...target,
    dockControlId: params.dockControlId ?? null,
    branch: params.worktree?.branch ?? null,
  });
  return outcome.ok ? { ...outcome, waited: true } : outcome;
}

/** Records a dock session's setup hint on its just-inserted row. */
export function recordSetupHint<T extends { id: number; setupHint: string | null }>(
  app: FastifyInstance,
  row: T,
  hint: "no-recipe" | null,
): T {
  if (hint === null) return row;
  app.db.update(sessions).set({ setupHint: hint }).where(eq(sessions.id, row.id)).run();
  return { ...row, setupHint: hint };
}
