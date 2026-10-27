import type { FastifyInstance, FastifyReply } from "fastify";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { and, eq, ne } from "drizzle-orm";
import { projects, sessions } from "../db/schema.js";
import type { DockControl } from "../shared/types.js";
import { LOCAL_HOST_ID } from "./host-registry.js";
import {
  deletePreviewWorktree,
  dockPreviewWorktreePath,
  ensureLocalBranch,
  findPreviewWorktreeSessionId,
  removeWorktree,
} from "./git-worktree.js";
import {
  bindBranchPreview,
  findBranchPreview,
  listUpstreamPorts,
  upsertBranchPreview,
  type PreviewSummary,
} from "./preview-registry.js";
import { resolveProjectDock } from "./project-config.js";
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
 * Local-host projects only. A remote host would need its own port allocator
 * (and the proxy to reach the bound port through the owning agent); until
 * then a remote project gets a 409 `remote_unsupported`.
 */

export type BranchPreviewErrorCode =
  | "unknown_project"
  | "remote_unsupported"
  | "no_preview_control"
  | "unknown_branch"
  | "invalid_branch"
  | "worktree_busy"
  | "start_failed";

const STATUS: Record<BranchPreviewErrorCode, 400 | 404 | 409 | 502> = {
  unknown_project: 404,
  remote_unsupported: 409,
  no_preview_control: 409,
  unknown_branch: 404,
  invalid_branch: 400,
  worktree_busy: 409,
  start_failed: 502,
};

export class BranchPreviewError extends Error {
  readonly statusCode: 400 | 404 | 409 | 502;
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

/** A free loopback port no other branch preview holds. The OS picks it
 * (listen on 0), so it is free at the time of asking; the dev server binds it
 * moments later. */
export async function allocatePreviewPort(taken: ReadonlySet<number>): Promise<number> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const chosen = typeof address === "object" && address ? address.port : 0;
        server.close(() => resolve(chosen));
      });
    });
    if (port > 0 && !taken.has(port)) return port;
  }
  throw new Error("no free port for a branch preview");
}

/**
 * The branch's `dock-preview-*` worktree path, resolved and held to
 * `<projectCwd>/.mullion-worktrees`. The name is derived from the request's
 * branch: `dockPreviewWorktreePath` sanitizes it, but the path is checked
 * again here, before any filesystem or git call touches it, so a name that
 * slipped past the sanitizer can never reach outside the worktree root.
 */
export function previewWorktreePathWithin(projectCwd: string, candidate: string): string {
  const base = path.resolve(projectCwd, ".mullion-worktrees");
  const resolved = path.resolve(base, candidate);
  const relative = path.relative(base, resolved);
  if (
    !relative ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    !resolved.startsWith(base + path.sep)
  ) {
    throw new BranchPreviewError(
      "invalid_branch",
      "That branch name can't name a preview worktree",
    );
  }
  return resolved;
}

/**
 * A `dock-preview-*` directory for the branch already exists. If a live
 * session still runs in it — a dock monitor started on the same branch from
 * the dock — it is that session's, and starting a second dev server in it is
 * refused. Otherwise it is what a dead preview session left behind:
 * `git worktree add` would refuse the existing path, so it is removed first
 * and recut fresh from the branch's current tip.
 */
async function clearStaleWorktree(
  app: FastifyInstance,
  projectId: number,
  projectCwd: string,
  candidate: string,
): Promise<void> {
  const worktreePath = previewWorktreePathWithin(projectCwd, candidate);
  if (!fs.existsSync(worktreePath)) return;
  const occupants = app.db
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        eq(sessions.projectId, projectId),
        eq(sessions.cwd, worktreePath),
        ne(sessions.status, "killed"),
      ),
    )
    .all();
  for (const { id } of occupants) {
    if (await isServing(app, id)) {
      throw new BranchPreviewError(
        "worktree_busy",
        `session ${id} is already running in this branch's preview worktree`,
      );
    }
  }
  // Untrack the dead session's worktree first: its entry would otherwise
  // have the reconciler (or the sync tick's pending-removal retry) remove
  // this same path again — from under the new session about to be cut there.
  const tracked = findPreviewWorktreeSessionId(worktreePath);
  if (tracked !== undefined) deletePreviewWorktree(tracked);
  if (!(await removeWorktree(worktreePath, projectCwd))) {
    throw new BranchPreviewError(
      "worktree_busy",
      "a stale preview worktree for this branch could not be removed",
    );
  }
}

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
  if (project.hostId !== LOCAL_HOST_ID) {
    throw new BranchPreviewError(
      "remote_unsupported",
      "Branch previews are not available yet for a project on a remote host",
    );
  }

  // A PR's head branch is brought up to origin first (best effort), so a
  // stale local copy doesn't serve old code — a live preview with
  // worktreeRefresh then follows it too.
  if (opts.fastForward) await ensureLocalBranch(project.cwd, branch, { fastForward: true });

  const existing = findBranchPreview(app, projectId, branch);
  if (existing?.sessionId != null && (await isServing(app, existing.sessionId))) return existing;

  const control = pickPreviewControl(resolveProjectDock(project.cwd, app.config.CRS_CONFIG_DIR));
  if (!control) {
    throw new BranchPreviewError(
      "no_preview_control",
      "Mark one dock control as serving branch previews (or keep a single control)",
    );
  }

  if (!(await ensureLocalBranch(project.cwd, branch))) {
    throw new BranchPreviewError("unknown_branch", `No branch ${branch} here or on origin`);
  }
  await clearStaleWorktree(
    app,
    projectId,
    project.cwd,
    dockPreviewWorktreePath(project.cwd, branch),
  );

  const port = await allocatePreviewPort(listUpstreamPorts(app));
  const result = await createSessionRecord(app, {
    projectId,
    command: control.command,
    kind: "dock",
    name: control.title,
    worktree: { branch },
    worktreeRefresh:
      control.worktreeRefresh ?? getStoredSettings(app.db).dock.defaultWorktreeRefresh ?? false,
    env: { ...control.env, PORT: String(port) },
  });
  if (!result.ok) {
    throw new BranchPreviewError(
      "start_failed",
      `Could not start the preview session (${result.reason})`,
    );
  }

  const row = upsertBranchPreview(app, projectId, branch);
  return bindBranchPreview(app, row.slug, { sessionId: result.row.id, upstreamPort: port }) ?? row;
}
