import type { FastifyInstance, FastifyReply } from "fastify";
import path from "node:path";
import { eq } from "drizzle-orm";
import { projects, sessions } from "../db/schema.js";
import type { DockControl } from "../shared/types.js";
import {
  deletePreviewWorktree,
  dockPreviewWorktreePath,
  findPreviewWorktreeSessionId,
  previewWorktreePathWithin as worktreePathWithin,
} from "./git-worktree.js";
import { clearStalePreviewCheckout } from "./checkout-removal.js";
import { listActiveSessionsWithProject } from "./project-records.js";
import {
  allocateHostPreviewPort,
  ensureHostBranch,
  resolveHostDockControls,
  type HostGitResult,
} from "./host-git.js";
import {
  bindBranchPreview,
  findBranchPreview,
  isPortPreviewBranch,
  listUpstreamPorts,
  upsertBranchPreview,
  type PreviewSummary,
} from "./preview-registry.js";
import { resolveBackend } from "./session-backend.js";
import { createSessionRecord } from "./session-lifecycle.js";
import { resolveSessionHostId } from "./session-live-info.js";
import { getStoredSettings } from "./settings.js";

/*
 * Branch-scoped previews (issues #2016/#2018).
 *
 * A project's checkout preview proxies to its configured devServerUrl. A
 * branch preview instead runs the project's preview dock control — as a
 * `kind: "dock"` session in a `dock-preview-*` worktree of the branch, with
 * `PORT` set to a port allocated here — and binds the (project, branch)
 * `previews` row to that session and port, which the proxy then targets.
 *
 * Reuse is decided from the DB, not from git-worktree.ts's in-memory
 * `previewWorktrees` map: that map is lost on a restart, while the session's
 * scope and its worktree directory both survive one. So the row's bound
 * session is checked against the host's live state (the session-model
 * invariant: the DB row records intent, liveness lives on the host).
 *
 * A branch preview runs on the project's own host (#3428): its checkout is
 * where the branch is fetched, the worktree is cut and the dev server binds
 * its port, so the session is pinned there rather than placed. For a
 * remote project each step that touches the checkout or picks a port runs on
 * its agent (`host-git.ts`: `/internal/git-ensure-branch`,
 * `/internal/worktree-clear-stale`, `/internal/preview-port`), while what only
 * the primary knows stays here: which sessions occupy a worktree, and which
 * ports are bound or reserved on that host. The preview proxy already reaches
 * the bound port through the session's host (`preview-upstream.ts`).
 */

export type BranchPreviewErrorCode =
  | "unknown_project"
  | "no_preview_control"
  | "unknown_branch"
  | "invalid_branch"
  | "worktree_busy"
  | "start_failed"
  // #3428 — the project's host runs an agent build without the branch-preview
  // routes: updating it fixes this, retrying does not.
  | "host_unsupported"
  // #3428 — the project's host answered but rejected the request (e.g. the
  // project's path is outside its PROJECTS_ROOTS): a configuration problem.
  | "host_refused"
  // #3428 — the project's host could not be reached (or was busy, or lost the
  // connection mid-request): retryable.
  | "host_unavailable";

type BranchPreviewStatus = 400 | 404 | 409 | 502 | 503;

const STATUS: Record<BranchPreviewErrorCode, BranchPreviewStatus> = {
  unknown_project: 404,
  no_preview_control: 409,
  unknown_branch: 404,
  invalid_branch: 400,
  worktree_busy: 409,
  start_failed: 502,
  host_unsupported: 409,
  host_refused: 409,
  host_unavailable: 503,
};

export class BranchPreviewError extends Error {
  readonly statusCode: BranchPreviewStatus;
  constructor(
    readonly code: BranchPreviewErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BranchPreviewError";
    this.statusCode = STATUS[code];
  }
}

/** Sends a branch-preview refusal with its machine-readable `code`, so the
 * frontend can tell "configure a preview control" apart from "start failed". */
export function sendBranchPreviewError(reply: FastifyReply, err: BranchPreviewError) {
  return reply
    .code(err.statusCode)
    .send({ statusCode: err.statusCode, code: err.code, message: err.message });
}

/**
 * The control a branch preview runs: the one flagged `preview`, else the
 * project's only control, else none. Configured controls only (dock.json,
 * global and per-repo) — a docker-discovered control follows its compose
 * file's ports, not `PORT`, so it can't serve an allocated port.
 */
export function pickPreviewControl(controls: readonly DockControl[]): DockControl | null {
  const flagged = controls.filter((c) => c.preview === true);
  if (flagged.length > 0) return flagged[0];
  return controls.length === 1 ? controls[0] : null;
}

/**
 * Whether the session bound to a preview still serves it. A killed or exited
 * row is dead whatever the host says; otherwise the host's scope liveness
 * decides. `unknown` (the host could not tell) counts as alive: spawning a
 * second dev server for the branch next to one that may well still be running
 * is the worse mistake, and the next request re-checks.
 */
async function isServing(app: FastifyInstance, sessionId: number): Promise<boolean> {
  const [row] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
  if (!row || row.status !== "active") return false;
  const id = String(row.id);
  try {
    const liveness = await resolveBackend(app, resolveSessionHostId(app, row)).liveness([id]);
    return liveness[id] !== "dead";
  } catch (err) {
    app.log.warn({ err, sessionId }, "branch preview: liveness check failed");
    return true;
  }
}

export { allocatePreviewPort } from "./preview-port.js";

const INVALID_WORKTREE_MESSAGE = "That branch name can't name a preview worktree";

/**
 * The branch's `dock-preview-*` worktree path, held to
 * `<projectCwd>/.mullion-worktrees` (git-worktree.ts's guard, which the
 * owning agent runs again for a remote checkout). Throws `invalid_branch`
 * for anything else.
 */
export function previewWorktreePathWithin(projectCwd: string, candidate: string): string {
  const resolved = worktreePathWithin(projectCwd, candidate);
  if (resolved === null) throw new BranchPreviewError("invalid_branch", INVALID_WORKTREE_MESSAGE);
  return resolved;
}

/** A host-side step that could not run, as the refusal a caller surfaces: an
 * agent build without the route is `host_unsupported` (its detail carries the
 * update hint); anything else, including a mutation whose outcome is unknown,
 * is `host_unavailable` — never retried here, the next request re-runs it. */
function hostFailure(
  result: Exclude<HostGitResult<unknown>, { ok: true }>,
  what: string,
): BranchPreviewError {
  // The agent answered but rejected the request (a 4xx other than a missing
  // route — e.g. the project's cwd outside its PROJECTS_ROOTS): retrying
  // won't help, so it is not reported as an unavailable host.
  const rejected =
    result.reason === "unreachable" &&
    result.status !== undefined &&
    result.status >= 400 &&
    result.status < 500;
  const code: BranchPreviewErrorCode =
    result.reason === "unsupported"
      ? "host_unsupported"
      : rejected
        ? "host_refused"
        : "host_unavailable";
  return new BranchPreviewError(code, `Could not ${what} on the project's host: ${result.detail}`);
}

/**
 * Whether `sessionCwd` (as its host recorded it: absolute, `~` expanded) is
 * the `name` dock-preview worktree of the checkout at `projectCwd`. A remote
 * project's cwd may be stored as `~/…`, which only its host can expand, so a
 * `~` path matches by its home-relative tail; a cwd this cannot place at all
 * matches, so a live session in it refuses rather than loses its worktree.
 */
function isPreviewWorktreeOf(sessionCwd: string, projectCwd: string, name: string): boolean {
  // A Windows host's paths (drive-letter, UNC and device paths) by win32
  // rules, case-insensitively; everything else as POSIX.
  const windows = WINDOWS_PATH.test(projectCwd) || WINDOWS_PATH.test(sessionCwd);
  const p = windows ? path.win32 : path.posix;
  const fold = (s: string) => (windows ? s.toLowerCase() : s);
  if (fold(p.basename(sessionCwd)) !== fold(name)) return false;
  const root = p.dirname(sessionCwd);
  if (p.basename(root) !== ".mullion-worktrees") return false;
  const checkout = fold(p.dirname(root));
  if (WINDOWS_PATH.test(projectCwd) || (!windows && p.isAbsolute(projectCwd))) {
    return fold(p.resolve(projectCwd)) === checkout;
  }
  // `~/rest` matches a checkout ending in `/rest`. Anything else — `~` alone
  // (the home directory, which only the host knows) or a cwd this cannot
  // place — matches below, so a live session refuses rather than loses its
  // worktree.
  if (projectCwd.startsWith("~/") || projectCwd.startsWith("~\\")) {
    const tail = fold(p.normalize(projectCwd.slice(2))).replace(/[\\/]+$/, "");
    if (tail === "" || tail === ".") return true;
    return checkout === tail || checkout.endsWith(p.sep + tail);
  }
  return true;
}

// A drive-letter path, or one starting with `\\` (UNC, and `\\?\` device paths).
const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/**
 * Makes way for the branch's `dock-preview-*` worktree. If a live session
 * still runs in it — a dock monitor started on the same branch from the dock
 * — it is that session's, and starting a second dev server in it is refused.
 * Otherwise anything on disk there is what a dead preview session left
 * behind: `git worktree add` would refuse the existing path, so it is removed
 * on the checkout's host and recut fresh from the branch's current tip. The
 * occupancy check comes first and always runs, because only the owning host
 * can see whether the directory exists.
 */
async function clearStaleWorktree(
  app: FastifyInstance,
  projectId: number,
  hostId: string,
  projectCwd: string,
  candidate: string,
): Promise<void> {
  // The directory's name: held to `.mullion-worktrees` here, and resolved
  // (and guarded again) against the checkout on its own host, whose absolute
  // path only that host may know.
  const name = path.basename(candidate);
  if (worktreePathWithin("/checkout", name) === null) {
    throw new BranchPreviewError("invalid_branch", INVALID_WORKTREE_MESSAGE);
  }
  // Every active session on this host whose cwd is that worktree, whatever
  // project row it was started from: two rows on one checkout share it
  // (the checkout-scoped guard of the git routes, not a projectId lookup).
  const occupants = listActiveSessionsWithProject(app.db).filter((row) => {
    const owner = row.hostId ?? row.projectHostId;
    return owner === hostId && row.cwd !== null && isPreviewWorktreeOf(row.cwd, projectCwd, name);
  });
  for (const { id } of occupants) {
    if (await isServing(app, id)) {
      throw new BranchPreviewError(
        "worktree_busy",
        `session ${id} is already running in this branch's preview worktree`,
      );
    }
  }
  const cleared = await clearStalePreviewCheckout(app, {
    projectId,
    hostId,
    worktreePath: name,
    parentCwd: projectCwd,
  });
  if (!cleared.ok) throw hostFailure(cleared, "clear the branch's preview worktree");
  switch (cleared.value.outcome) {
    case "absent":
    case "removed": {
      // Untrack a dead session's entry for it, before the new session is cut
      // there: the reconciler (or the sync tick's pending-removal retry)
      // would otherwise remove this same path again, from under it.
      const tracked = findPreviewWorktreeSessionId(cleared.value.worktreePath);
      if (tracked !== undefined) deletePreviewWorktree(tracked);
      return;
    }
    case "invalid-path":
      throw new BranchPreviewError("invalid_branch", INVALID_WORKTREE_MESSAGE);
    case "not-removed":
      throw new BranchPreviewError(
        "worktree_busy",
        "a stale preview worktree for this branch could not be removed",
      );
  }
}

/** `ensureHostBranch`, with a host that could not be asked as a refusal: a
 * host failure must not read as "no such branch". */
async function ensureBranch(
  app: FastifyInstance,
  hostId: string,
  cwd: string,
  branch: string,
  opts: { fastForward?: boolean } = {},
): Promise<boolean> {
  const result = await ensureHostBranch(app, hostId, cwd, branch, opts);
  if (!result.ok) throw hostFailure(result, `prepare branch ${branch}`);
  return result.value;
}

// Ports handed out to a create that hasn't bound its row yet, per host: the
// same port number on two hosts is not a conflict.
const reservedPorts = new Map<string, Set<number>>();

// Concurrent requests for the same (project, branch) share one create: the
// row upsert alone would keep the table consistent, but both callers would
// still each allocate a port and spawn a dev server.
const inflight = new Map<string, Promise<PreviewSummary>>();

/**
 * The (project, branch) preview, started if nothing serves it. Idempotent per
 * (project, branch): a live bound session is returned as is. `fastForward`
 * (a PR's head branch) also fast-forwards an existing local branch from
 * origin. Throws BranchPreviewError for every refusal a caller should surface.
 */
export function getOrCreateBranchPreview(
  app: FastifyInstance,
  projectId: number,
  branch: string,
  opts: { fastForward?: boolean } = {},
): Promise<PreviewSummary> {
  const key = `${projectId}\0${branch}`;
  const pending = inflight.get(key);
  if (pending) return pending;
  const created = createBranchPreview(app, projectId, branch, opts).finally(() =>
    inflight.delete(key),
  );
  inflight.set(key, created);
  return created;
}

async function createBranchPreview(
  app: FastifyInstance,
  projectId: number,
  branch: string,
  opts: { fastForward?: boolean },
): Promise<PreviewSummary> {
  const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
  if (!project) throw new BranchPreviewError("unknown_project", `Unknown project ${projectId}`);
  // The project's own host (#3428): the checkout, the worktree, the port and
  // the dev server all live there.
  const hostId = project.hostId;

  // A PR's head branch is brought up to origin first (best effort), so a
  // stale local copy doesn't serve old code — a live preview with
  // worktreeRefresh then follows it too.
  if (opts.fastForward) {
    await ensureBranch(app, hostId, project.cwd, branch, { fastForward: true });
  }

  // #3003 — `port:<n>` keys a running service's port preview, never a branch
  // (a colon cannot appear in a ref name): the lookup below must not hand
  // that row back as a branch preview.
  if (isPortPreviewBranch(branch)) {
    throw new BranchPreviewError("unknown_branch", `No branch ${branch} here or on origin`);
  }
  const existing = findBranchPreview(app, projectId, branch);
  if (existing?.sessionId != null && (await isServing(app, existing.sessionId))) return existing;

  // Read from the checkout on the project's host (its agent for a remote one).
  const controls = await resolveHostDockControls(app, hostId, project.cwd);
  if (!controls.ok) throw hostFailure(controls, "read the project's dock controls");
  const control = pickPreviewControl(controls.value);
  if (!control) {
    throw new BranchPreviewError(
      "no_preview_control",
      "Mark one dock control as serving branch previews (or keep a single control)",
    );
  }

  if (!(await ensureBranch(app, hostId, project.cwd, branch))) {
    throw new BranchPreviewError("unknown_branch", `No branch ${branch} here or on origin`);
  }
  await clearStaleWorktree(
    app,
    projectId,
    hostId,
    project.cwd,
    dockPreviewWorktreePath(project.cwd, branch),
  );

  // Held from allocation until the row is bound: concurrent creates for
  // different branches don't share the inflight entry, and would otherwise
  // only see each other's ports once bound.
  // The port is picked on the host the dev server runs on, outside every
  // port already bound or reserved there; the inventory itself is the
  // primary's (the agent's allocator is stateless).
  // The set is never dropped from the map (one per host): deleting it once
  // empty would orphan the reference a concurrent create still holds.
  let held = reservedPorts.get(hostId);
  if (!held) reservedPorts.set(hostId, (held = new Set<number>()));
  const reserved = held;
  // Allocate-and-reserve is serialized per host: two creates asking at once
  // would otherwise each send a `taken` without the other's port (a full
  // round trip apart on an agent) and be handed the same one.
  const port = await serializedPerHost(hostId, async () => {
    const allocated = await allocateHostPreviewPort(
      app,
      hostId,
      new Set([...listUpstreamPorts(app, hostId), ...reserved]),
    );
    if (!allocated.ok) throw hostFailure(allocated, "pick a port for the preview");
    if (allocated.value === null || reserved.has(allocated.value)) {
      throw new BranchPreviewError("start_failed", "No free port for the preview on its host");
    }
    reserved.add(allocated.value);
    return allocated.value;
  });
  try {
    return await startOnPort(app, projectId, hostId, branch, control, port);
  } finally {
    reserved.delete(port);
  }
}

// One allocation in flight per host (see above). Like `reservedPorts`, an
// entry per host, never dropped; a failed allocation does not block the next.
const allocationQueues = new Map<string, Promise<unknown>>();

function serializedPerHost<T>(hostId: string, fn: () => Promise<T>): Promise<T> {
  const previous = allocationQueues.get(hostId) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  allocationQueues.set(
    hostId,
    run.catch(() => undefined),
  );
  return run;
}

async function startOnPort(
  app: FastifyInstance,
  projectId: number,
  hostId: string,
  branch: string,
  control: DockControl,
  port: number,
): Promise<PreviewSummary> {
  const result = await createSessionRecord(app, {
    projectId,
    // Pinned to the host where the port was picked and the branch prepared,
    // bypassing the placement policy: never placed elsewhere (an Auto
    // project), and not refused by eligibility rules (a parked host) that a
    // pinned project's dock session never answered to.
    hostId,
    placementReason: `a branch preview runs on its project's host (${hostId})`,
    command: control.command,
    kind: "dock",
    name: control.title,
    worktree: { branch },
    worktreeRefresh:
      control.worktreeRefresh ?? getStoredSettings(app.db).dock.defaultWorktreeRefresh ?? false,
    env: { ...control.env, PORT: String(port) },
  });
  if (!result.ok && result.reason === "outcome-unknown" && result.sessionId !== undefined) {
    // #2637 — the spawn may have landed and createSessionRecord kept the row:
    // bind the preview to it like the success path, so the dev server isn't
    // left running behind a "failed" answer.
    const row = upsertBranchPreview(app, projectId, branch);
    return (
      bindBranchPreview(app, row.slug, { sessionId: result.sessionId, upstreamPort: port }) ?? row
    );
  }
  if (!result.ok) {
    throw new BranchPreviewError(
      "start_failed",
      `Could not start the preview session (${result.reason}${
        "detail" in result && result.detail ? `: ${result.detail}` : ""
      })`,
    );
  }

  const row = upsertBranchPreview(app, projectId, branch);
  return bindBranchPreview(app, row.slug, { sessionId: result.row.id, upstreamPort: port }) ?? row;
}
