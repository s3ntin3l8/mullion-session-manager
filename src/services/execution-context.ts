// The one place that answers "where does this session's work live?" — a
// (host, cwd) pair plus the path flavour of that host. Project-files and the
// session-scoped git targets used to each compute their own (and disagreed:
// the project's host for a session placed elsewhere, posix path rules for a
// Windows agent, remote sibling worktrees always refused). A session context
// never falls back to the project or default host when it cannot be resolved:
// acting on the wrong machine's files is worse than a refusal.
import path from "node:path";
import { realpathSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { projects, sessions } from "../db/schema.js";
import { LOCAL_HOST_ID, getHostRow } from "./host-registry.js";
import { parseHostCwds, projectCwdOnHost } from "./placement.js";
import { resolveSessionHostId } from "./session-live-info.js";
import { isSiblingWorktreeCwd } from "./session-lifecycle.js";
import { getRemoteHostClient, HostRequestError } from "./remote-host-client.js";

export type ExecutionContextRef =
  { projectId: number; sessionId: number } | { projectId: number; projectDefault: true };

export type ExecutionContextErrorCode = "invalid_context" | "host_unavailable" | "unsupported";

export interface ExecutionContextError {
  code: ExecutionContextErrorCode;
  message: string;
}

export interface ExecutionContext {
  projectId: number;
  hostId: string;
  /** The owning host's path flavour (`hosts.platform`; local = this process). */
  platform: "win32" | "posix";
  /** Absolute directory on `hostId` the request operates in. */
  cwd: string;
  /** The project's checkout on `hostId`, or `cwd` itself for a sibling worktree. */
  checkoutRoot: string;
  source: "session" | "project-default";
}

export type ExecutionContextResult =
  { ok: true; context: ExecutionContext } | { ok: false; error: ExecutionContextError };

const fail = (code: ExecutionContextErrorCode, message: string): ExecutionContextResult => ({
  ok: false,
  error: { code, message },
});

function pathFlavour(platform: string | null): "win32" | "posix" {
  return platform === "win32" ? "win32" : "posix";
}

function isWithin(p: typeof path.posix, root: string, candidate: string): boolean {
  const rel = p.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !p.isAbsolute(rel));
}

/** Symlink-aware containment on the primary's own filesystem. `null` = the
 * directory is gone or unresolvable; anything else (EACCES, ...) throws. */
function localContained(root: string, cwd: string): boolean | null {
  try {
    const real = realpathSync(cwd);
    const realRoot = realpathSync(root);
    return isWithin(path, realRoot, real);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") return null;
    throw err;
  }
}

export interface ExecutionContextOptions {
  /** Take a session's cwd as recorded, skipping the containment check. For a
   * read-only caller that validates the directory itself (git status targets
   * run `isGitRepo` and an absolute-path guard); host, platform and
   * cross-project checks still apply. Never use it to serve file contents. */
  trustSessionCwd?: boolean;
}

export async function resolveExecutionContext(
  app: FastifyInstance,
  ref: ExecutionContextRef,
  opts: ExecutionContextOptions = {},
): Promise<ExecutionContextResult> {
  const [project] = app.db.select().from(projects).where(eq(projects.id, ref.projectId)).all();
  if (!project) return fail("invalid_context", "Project not found");

  let session: typeof sessions.$inferSelect | undefined;
  let hostId = project.hostId;
  if ("sessionId" in ref) {
    [session] = app.db.select().from(sessions).where(eq(sessions.id, ref.sessionId)).all();
    if (!session || session.projectId !== project.id) {
      return fail("invalid_context", "Session not found in this project");
    }
    hostId = resolveSessionHostId(app, session);
  }

  const host = getHostRow(app, hostId);
  if (!host || (hostId !== LOCAL_HOST_ID && !host.baseUrl)) {
    return fail("host_unavailable", `Host ${hostId} is not available`);
  }
  const flavour =
    hostId === LOCAL_HOST_ID ? pathFlavour(process.platform) : pathFlavour(host.platform);
  const p = flavour === "win32" ? path.win32 : path.posix;

  const root = projectCwdOnHost(project, hostId, parseHostCwds(project.hostCwds));
  if (root === null) {
    return fail("invalid_context", `The project has no checkout on host ${hostId}`);
  }
  if (!session) {
    return {
      ok: true,
      context: {
        projectId: project.id,
        hostId,
        platform: flavour,
        cwd: root,
        checkoutRoot: root,
        source: "project-default",
      },
    };
  }

  const base = { projectId: project.id, hostId, platform: flavour, source: "session" } as const;
  if (!session.cwd) {
    return { ok: true, context: { ...base, cwd: root, checkoutRoot: root } };
  }
  if (opts.trustSessionCwd) {
    return { ok: true, context: { ...base, cwd: session.cwd, checkoutRoot: root } };
  }
  if (!p.isAbsolute(session.cwd)) {
    return fail("invalid_context", "The session's directory is not an absolute path");
  }
  const sessionCwd = p.resolve(session.cwd);
  const projectRoot = p.resolve(root);
  const inside: ExecutionContextResult = {
    ok: true,
    context: { ...base, cwd: sessionCwd, checkoutRoot: root },
  };
  const outsideMsg = "The session's directory is outside the project or no longer exists";

  if (hostId === LOCAL_HOST_ID) {
    try {
      if (isWithin(p, projectRoot, sessionCwd)) {
        return localContained(projectRoot, sessionCwd)
          ? inside
          : fail("invalid_context", outsideMsg);
      }
      if (await isSiblingWorktreeCwd({ cwd: root, hostId: LOCAL_HOST_ID }, sessionCwd)) {
        return { ok: true, context: { ...base, cwd: sessionCwd, checkoutRoot: sessionCwd } };
      }
      return fail("invalid_context", outsideMsg);
    } catch (err) {
      app.log.warn({ err, projectId: project.id }, "couldn't verify the session's directory");
      return fail("host_unavailable", "Couldn't verify the session's directory");
    }
  }

  // Remote: the agent re-checks every path against its PROJECTS_ROOTS, so a
  // lexically-contained cwd is accepted as is; one outside the checkout must be
  // a registered worktree of it, which only the agent can list.
  if (isWithin(p, projectRoot, sessionCwd)) return inside;
  try {
    const listed = await getRemoteHostClient(app, hostId).resolveGitBranches(root);
    const found = listed?.worktrees.some((wt) => p.resolve(wt.path) === sessionCwd);
    return found
      ? { ok: true, context: { ...base, cwd: sessionCwd, checkoutRoot: sessionCwd } }
      : fail("invalid_context", outsideMsg);
  } catch (err) {
    if (err instanceof HostRequestError && err.statusCode === 404) {
      return fail("unsupported", `Host ${hostId}'s Mullion is too old to list worktrees`);
    }
    app.log.warn({ err, hostId }, "couldn't list the remote host's worktrees");
    return fail("host_unavailable", `Host ${hostId} is unreachable`);
  }
}

export function executionContextErrorStatus(code: ExecutionContextErrorCode): 400 | 501 | 503 {
  return code === "invalid_context" ? 400 : code === "unsupported" ? 501 : 503;
}

/** A session's recorded (host, cwd) for a read-only, self-validating caller
 * (`trustSessionCwd`), or `null` when it can't be resolved. */
export async function resolveTrustedSessionContext(
  app: FastifyInstance,
  projectId: number,
  sessionId: number,
): Promise<ExecutionContext | null> {
  const got = await resolveExecutionContext(
    app,
    { projectId, sessionId },
    { trustSessionCwd: true },
  );
  return got.ok ? got.context : null;
}
