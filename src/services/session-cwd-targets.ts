import type { FastifyInstance } from "fastify";
import { inArray } from "drizzle-orm";
import { projects, sessions } from "../db/schema.js";
import { resolveTrustedSessionContext } from "./execution-context.js";
import { LOCAL_HOST_ID } from "./host-registry.js";
import { isWithinAnyWorktree, listWorktrees, type GitWorktreeInfo } from "./git-refs.js";
import { isGitRepo } from "./git-status.js";

export interface SessionCwdTarget {
  sessionId: number;
  hostId: string;
  cwd: string;
  /** The session's context is durably invalid (e.g. its project has no
   * checkout on its host): callers report `null`, not "absent". */
  invalid?: true;
}

/**
 * Effective cwd per session (`liveCwd ?? row.cwd ?? project.cwd`) joined to
 * its project's `hostId` — the shared "which host, which path" resolution
 * used by the batch git-status and git-diff-stats session endpoints in
 * src/routes/projects.ts (issue #202). This is the plan's deliberate deviation from a
 * `session.worktreePath` column: `sessions.cwd` is already passed verbatim
 * as the spawn cwd with no confinement to the project root (see
 * sessions.ts's getOrCreate), so a worktree session's cwd can already point
 * anywhere — no schema change needed to derive it.
 *
 * `liveCwd` (issue: sidebar worktree display) is this process's own in-memory
 * PtyManager state — the shell's OSC-7-announced cwd, which reflects a
 * manual `cd` after launch that `sessions.cwd` (written once, at creation)
 * never does. Only merged for a LOCAL session: `app.pty` here only tracks
 * sessions this process itself spawned/attached (same caveat as projects.ts's
 * detectedDevServerPort) — a remote session's live cwd lives in that
 * agent's own PtyManager instead, out of reach from here. (The plain session
 * list's `Session.liveCwd` field, unlike this function, IS remote-aware —
 * see services/session-live-info.ts's withLiveInfo, which goes through resolveBackend(hostId)
 * .liveStatus() and therefore reaches the owning host's own PtyManager
 * regardless of which host that is. Extending that same reach to this
 * function's batch git-status/diff-stats resolution would need a new
 * remote-side endpoint; deferred as a known gap for remote-hosted worktree
 * sessions rather than silently assumed to already work.)
 *
 * A `liveCwd` is a self-reported value (a hook message, or an OSC-7 PTY
 * announcement), not one this process already validated — `isGitRepo`'s
 * absolute-path + no-".."-segment + `.git`-exists guard must pass before
 * it's trusted as a `git -C` target, same as every other cwd this file
 * hands to git. A `liveCwd` that fails that check (stale, mid-typo, a shell
 * integration bug) just falls back to the DB cwd, same "nothing to show"
 * posture as this function's other gaps.
 *
 * Issue: worktree/branch detection — passing `isGitRepo` alone isn't
 * enough: an agent piggybacking its cwd on every hook event (see
 * forwarder-core.mjs's mapClaudeCodeEvent) can wander into ANY repo it
 * happens to visit, not just this project's own worktrees — observed live
 * as a session's `liveCwd` landing in `~/.claude/projects/...` (that
 * particular case was harmless only because it's not itself a git repo).
 * Adopting a foreign repo's cwd here would resolve and display THAT repo's
 * branch under this project. So `liveCwd` is only trusted when it resolves
 * to this project's own repository — at or below one of `listWorktrees`'
 * paths for `project.cwd` (which always includes the main checkout itself,
 * per that function's own `isMain` doc comment) — falling back to the DB
 * cwd otherwise, same posture as the `isGitRepo` check above.
 *
 * A session id with no matching row (already deleted, or a stale/racing
 * client) or whose project has since been deleted is simply omitted from
 * the result — same "nothing to show" posture as every other best-effort
 * lookup in this file, not an error. A session whose context is durably
 * invalid (e.g. its project has no checkout on its host) is emitted with
 * `invalid: true` instead, so callers report `null` rather than keep a
 * stale value; a transient failure (host unavailable) is omitted.
 */
export async function resolveSessionCwdTargets(
  app: FastifyInstance,
  sessionIds: number[],
): Promise<SessionCwdTarget[]> {
  if (sessionIds.length === 0) return [];
  const sessionRows = app.db.select().from(sessions).where(inArray(sessions.id, sessionIds)).all();
  const projectRows = new Map(
    app.db
      .select()
      .from(projects)
      .where(inArray(projects.id, [...new Set(sessionRows.map((r) => r.projectId))]))
      .all()
      .map((p) => [p.id, p]),
  );
  if (sessionRows.length === 0) return [];

  const targets: SessionCwdTarget[] = [];
  // Cached per project, not per session: sessions sharing a project also
  // share its worktree list, and `listWorktrees` spawns a real `git`
  // process — no reason to pay for that once per session in the same batch.
  // Stores the full GitWorktreeInfo (with branch names) so the liveBranch
  // fallback below can match worktree by branch name.
  const worktreesByProject = new Map<string, GitWorktreeInfo[]>();
  const ensureWorktreeInfos = async (checkoutRoot: string) => {
    let infos = worktreesByProject.get(checkoutRoot);
    if (infos === undefined) {
      infos = (await listWorktrees(checkoutRoot)) ?? [];
      worktreesByProject.set(checkoutRoot, infos);
    }
    return infos;
  };
  for (const row of sessionRows) {
    // A deleted project resolves to null. The session's own (host, cwd), or nothing: never the project's host in
    // its place (services/execution-context.ts).
    const project = projectRows.get(row.projectId);
    if (!project) continue;
    const got = await resolveTrustedSessionContext(app, project, row);
    if (!got.ok) {
      // Durable (no checkout on the host) is null; transient is omitted.
      if (got.error.code === "invalid_context") {
        targets.push({ sessionId: row.id, hostId: "", cwd: "", invalid: true });
      }
      continue;
    }
    const ctx = got.context;
    let cwd = ctx.cwd;
    if (ctx.hostId === LOCAL_HOST_ID) {
      const ptySession = app.pty.get(String(row.id));
      const liveCwd = ptySession?.liveCwd;
      const liveBranch = ptySession?.liveBranch;

      // Phase 1: liveCwd check (existing behavior) — the shell's OSC-7 or
      // hook-reported cwd, only trusted when it's within one of this
      // project's own worktree paths (see the function's doc comment).
      let resolved = false;
      if (liveCwd && isGitRepo(liveCwd)) {
        const worktreeInfos = await ensureWorktreeInfos(ctx.checkoutRoot);
        if (
          isWithinAnyWorktree(
            liveCwd,
            worktreeInfos.map((w) => w.path),
          )
        ) {
          cwd = liveCwd;
          resolved = true;
        }
      }

      // Phase 2: liveBranch fallback (issue: sidebar worktree detection) —
      // opencode's vcs.branch.updated / worktree.ready events report the
      // correct branch name but never carry the worktree path (see
      // Sidebar.tsx's comment on this gap). When liveCwd didn't resolve,
      // check if liveBranch matches a non-main worktree's branch — if so,
      // use that worktree's path as the effective cwd so the per-session
      // git status resolves against the worktree's actual filesystem.
      if (!resolved && liveBranch) {
        const worktreeInfos = await ensureWorktreeInfos(ctx.checkoutRoot);
        const matched = worktreeInfos.find((w) => w.branch === liveBranch && !w.isMain);
        if (matched) cwd = matched.path;
      }
    }
    targets.push({ sessionId: row.id, hostId: ctx.hostId, cwd });
  }
  return targets;
}
