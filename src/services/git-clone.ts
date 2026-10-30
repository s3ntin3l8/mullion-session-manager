// Mullion-owned checkout: clone a repo into the host's FIRST effective
// PROJECTS_ROOTS entry as `<root>/<name>`. There is deliberately no separate
// checkout root — the roots validator refuses anything overlapping Mullion's
// own data, and a root outside PROJECTS_ROOTS would be unreachable by the
// git/file routes and origin detection. Whether a checkout is Mullion-managed
// is recorded in `hostCwdsMeta.managed`, not in the path.
//
// Auth mirrors git-push.ts: the read token rides `-c http.extraHeader=...` on
// argv for this one invocation, never in the remote URL, so it is never
// written to `.git/config`; git-run.ts's redact() strips it from all output.
// Managed clones are https-only (an ssh remote only works where the user's
// keys are registered with the forge).
import { existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { effectiveProjectsRoots } from "./agent-projects-roots.js";
import { isCloneBusy, markCloneBusy, releaseClone } from "./git-clone-busy.js";
import { normalizeGitRemote, readOriginUrl } from "./git-remote.js";
import { GIT_CLONE_TIMEOUT_MS, runGitCommand } from "./git-run.js";
import { LOCAL_HOST_ID } from "./host-registry.js";
import { realpathExistingPrefix } from "./safe-path.js";

const GIT_QUERY_TIMEOUT_MS = 10_000;
/** `<name>`, `<name>-2`, … — a bound so a pathological directory can't spin forever. */
const MAX_NAME_ATTEMPTS = 50;

export type CloneFailureReason = "auth" | "no-roots" | "unreachable" | "failed";

export type CloneResult =
  | { ok: true; cwd: string; defaultBranch: string | null; reused: boolean }
  | { ok: false; reason: CloneFailureReason; detail: string };

const AUTH_FAILURE =
  /authentication failed|could not read (?:username|password)|terminal prompts disabled|invalid username or password|requested URL returned error: 40[13]|repository not found|permission denied/i;
const UNREACHABLE_FAILURE =
  /could not resolve host|failed to connect|connection (?:refused|timed out|reset)|timed out|network is unreachable|unable to access|early eof/i;

function classifyFailure(detail: string): CloneFailureReason {
  if (AUTH_FAILURE.test(detail)) return "auth";
  if (UNREACHABLE_FAILURE.test(detail)) return "unreachable";
  return "failed";
}

async function currentBranch(cwd: string): Promise<string | null> {
  const r = await runGitCommand(
    cwd,
    ["symbolic-ref", "--short", "HEAD"],
    null,
    "",
    "",
    GIT_QUERY_TIMEOUT_MS,
  );
  const branch = r.ok ? r.stdout.trim() : "";
  return branch === "" ? null : branch;
}

type Occupant = "free" | "reuse" | "taken";

/** What is at `target`: nothing (or an empty dir) to clone into, the same repo, or something else. */
function inspectTarget(target: string, wantedOrigin: string | null): Occupant {
  let stat;
  try {
    stat = lstatSync(target);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "free" : "taken";
  }
  if (!stat.isDirectory()) return "taken";
  if (existsSync(path.join(target, ".git"))) {
    const origin = readOriginUrl(target);
    const normalized = origin === null ? null : normalizeGitRemote(origin);
    return wantedOrigin !== null && normalized === wantedOrigin ? "reuse" : "taken";
  }
  try {
    return readdirSync(target).length === 0 ? "free" : "taken";
  } catch {
    return "taken";
  }
}

/** Clones `url` into `<first effective projects root>/<name>` on THIS host. Never throws. */
export async function cloneCheckout(
  app: FastifyInstance,
  opts: { url: string; name: string; token?: string },
): Promise<CloneResult> {
  const { url, name, token } = opts;
  const root = effectiveProjectsRoots(app)[0];
  if (!root) {
    return {
      ok: false,
      reason: "no-roots",
      detail: "this host has no PROJECTS_ROOTS to clone into",
    };
  }
  if (!/^https:\/\//i.test(url)) {
    return { ok: false, reason: "failed", detail: "only https:// clone URLs are supported" };
  }
  const wantedOrigin = normalizeGitRemote(url);
  const encodedCredential = token ? Buffer.from(`x-access-token:${token}`).toString("base64") : "";
  const headerValue = token ? `AUTHORIZATION: basic ${encodedCredential}` : null;

  let resolvedRoot: string;
  try {
    resolvedRoot = path.resolve(root);
    mkdirSync(resolvedRoot, { recursive: true });
  } catch (err) {
    return {
      ok: false,
      reason: "failed",
      detail: `cannot create ${root}: ${(err as Error).message}`,
    };
  }

  let realRoot: string;
  try {
    realRoot = realpathExistingPrefix(resolvedRoot);
  } catch {
    return { ok: false, reason: "failed", detail: "the projects root could not be resolved" };
  }

  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt++) {
    const target = path.join(resolvedRoot, attempt === 1 ? name : `${name}-${attempt}`);
    // The name is one validated segment, but a pre-planted symlink at the
    // target could still point out of the roots — check the real location.
    let realTarget: string;
    try {
      realTarget = realpathExistingPrefix(target);
    } catch {
      return { ok: false, reason: "failed", detail: "the clone target could not be resolved" };
    }
    if (!realTarget.startsWith(realRoot + path.sep)) {
      return {
        ok: false,
        reason: "failed",
        detail: "the clone target is outside this agent's PROJECTS_ROOTS",
      };
    }

    const occupant = inspectTarget(target, wantedOrigin);
    if (occupant === "taken") continue;
    if (occupant === "reuse") {
      return { ok: true, cwd: target, defaultBranch: await currentBranch(target), reused: true };
    }
    if (isCloneBusy(LOCAL_HOST_ID, target)) {
      return {
        ok: false,
        reason: "failed",
        detail: "a clone into this directory is already running",
      };
    }

    markCloneBusy(LOCAL_HOST_ID, target);
    try {
      const result = await runGitCommand(
        resolvedRoot,
        ["clone", "--", url, target],
        headerValue,
        token ?? "",
        encodedCredential,
        GIT_CLONE_TIMEOUT_MS,
      );
      if (!result.ok) {
        return { ok: false, reason: classifyFailure(result.detail), detail: result.detail };
      }
      return { ok: true, cwd: target, defaultBranch: await currentBranch(target), reused: false };
    } finally {
      releaseClone(LOCAL_HOST_ID, target);
    }
  }
  return {
    ok: false,
    reason: "failed",
    detail: `no free directory name for "${name}" under ${resolvedRoot}`,
  };
}
