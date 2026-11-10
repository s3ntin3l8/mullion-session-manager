import type { FastifyInstance, FastifyReply } from "fastify";
import path from "node:path";
import { expandHome } from "../services/project-config.js";
import { effectiveProjectsRoots } from "../services/agent-projects-roots.js";
import { realpathExistingPrefix } from "../services/safe-path.js";

/**
 * Constrain a request-supplied cwd to this agent's own PROJECTS_ROOTS before
 * it reaches a filesystem read — the sole trust anchor a DB-less agent has,
 * and the same scope /internal/discover already surfaces. Returns the
 * resolved absolute path when `cwd` is one of (or a descendant of) a
 * configured root, else null. Without this, /internal/actions and
 * /internal/dock would read whatever `.crs/actions.json`/`.crs/dock.json`/
 * `package.json`/`.vscode/tasks.json` happens to exist at ANY path the
 * caller names — flagged by CodeQL as uncontrolled data in a path
 * expression (and, downstream, a log-injection sink in project-config.ts's
 * warn() calls) once these routes started passing a raw request query
 * param into project-config.ts's file reads.
 *
 * The containment check below compares REAL (symlink-resolved) paths, not
 * the lexical ones (issue #604) — a symlink planted inside a root (e.g. an
 * authenticated caller who already has filesystem access to a project
 * creating `<root>/escape -> /etc`, then naming `cwd=<root>/escape`) used to
 * pass the old lexical `startsWith` check and hand every downstream sink a
 * path that silently escaped the root the moment it followed that symlink.
 * The function still RETURNS the lexical `resolved` value on success, not
 * the real one — every existing call site expects (and several persist)
 * that exact value, and legitimate uses (a `PROJECTS_ROOTS` entry that's
 * itself a symlink to a bind mount, a project containing an intentional
 * symlink to shared assets) are unaffected either way, since ordinary fs
 * calls follow symlinks transparently regardless of which form of the path
 * they're given. This only closes the CHECK's blind spot, not what gets
 * returned.
 *
 * Deliberately NOT applied to /internal/sessions or /internal/ws/attach
 * (session spawn/attach) below: a session's cwd is the whole point of the
 * feature and, like the primary's own unrestricted POST /api/projects cwd,
 * isn't scoped to PROJECTS_ROOTS today — spawning a program is already
 * fully gated by the shared token, the same trust boundary a roots check
 * here wouldn't add anything to. This is a deliberate, narrower scope than
 * "every cwd-accepting route," not an oversight.
 */
export function resolveWithinRoots(app: FastifyInstance, cwd: string): string | null {
  const resolved = path.resolve(expandHome(cwd));
  let realResolved: string;
  let roots: string[];
  try {
    realResolved = realpathExistingPrefix(resolved);
    // Issue #1951 follow-up — the roots in force: the saved override the
    // primary set from Settings → Hosts, else this host's own env value.
    roots = effectiveProjectsRoots(app).map((root) => realpathExistingPrefix(path.resolve(root)));
  } catch {
    // A non-ENOENT failure mid-walk (EACCES, ELOOP on a symlink cycle, ...)
    // means realpathExistingPrefix couldn't reliably determine the real
    // location of `cwd` or a configured root — fail closed the same as
    // "outside every root" (every call site already treats null as a clean
    // 400) rather than letting the exception surface as an uncaught 500 at
    // whatever sink calls in here (Hermes review, PR #612).
    return null;
  }
  const withinRoots = roots.some(
    (root) => realResolved === root || realResolved.startsWith(root + path.sep),
  );
  return withinRoots ? resolved : null;
}

// CodeQL (js/path-injection) reports the sinks in services/host-files.ts and
// services/project-files.ts as "new" on the PR that split internal.ts into
// per-domain registrars. They are not new: the same request.body -> service
// flows existed in internal.ts and were guarded by these same helpers. The
// split only moved the taint *sources* into internal-*.ts, so CodeQL
// re-anchored the alerts. No sink or guard changed; every handler still runs
// requireWithinRoots/requireAllWithinRoots before any filesystem or git side
// effect. Resolution: dismiss as false positives in GHAS (same as the
// js/path-injection alerts on services/git-refs.ts); a source-level
// suppression would not dismiss them, as this repo's codeql.yml has no SARIF
// post-processing step.
/**
 * The call-site half of resolveWithinRoots: resolves `value` and, on
 * failure, sends the standard 400 ("<field> must be within this agent's
 * PROJECTS_ROOTS") and returns null — replacing the identical
 * `const resolvedX = resolveWithinRoots(...); if (!resolvedX) return
 * reply.badRequest(...);` block this file used to repeat at every one of
 * its ~37 call sites. The idiom at each call site becomes:
 * `const resolvedX = requireWithinRoots(app, reply, x, "x"); if (resolvedX
 * === null) return;` — the same early-return-after-sending-a-reply shape
 * already used elsewhere in this file (e.g. the mullionSignatureSecret
 * check above). `field` is required, not defaulted — every one of this
 * file's ~37 call sites passes it explicitly (Hermes review, PR #626), so a
 * default would only ever mask a call site that forgot to name its own
 * field, not save anyone real typing.
 */
export function requireWithinRoots(
  app: FastifyInstance,
  reply: FastifyReply,
  value: string,
  field: string,
): string | null {
  const resolved = resolveWithinRoots(app, value);
  if (!resolved) {
    reply.badRequest(`${field} must be within this agent's PROJECTS_ROOTS`);
    return null;
  }
  return resolved;
}

/**
 * requireWithinRoots for an array of paths — used by
 * /internal/git-worktree/prune's orphanPaths loop. Stops at the FIRST
 * entry outside PROJECTS_ROOTS, same as the loop it replaces: the rest of
 * `values` is never resolved once one entry fails.
 */
export function requireAllWithinRoots(
  app: FastifyInstance,
  reply: FastifyReply,
  values: string[],
  field: string,
): string[] | null {
  const resolved: string[] = [];
  for (const value of values) {
    const resolvedValue = resolveWithinRoots(app, value);
    if (!resolvedValue) {
      reply.badRequest(`${field} entry must be within this agent's PROJECTS_ROOTS: ${value}`);
      return null;
    }
    resolved.push(resolvedValue);
  }
  return resolved;
}
