import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { GIT_NO_AUTO_GC, gitEnv } from "./git-env.js";
import type { CloneHealth, RepairOutcome, RepairPlan } from "../shared/types.js";

/**
 * Reports — and, with `apply`, repairs — git object damage in a clone.
 *
 * Issue #1836 — a background `git gc` in a clone that several agents push to
 * concurrently can delete a loose object that a concurrent write is creating.
 * The repack sequence is pack-then-unlink: an object written *after* the pack
 * was built but *before* the unlink is removed without being in the pack.
 *
 * The symptom is a zero-byte file where a loose object should be. Git then
 * reports the object as *missing* rather than corrupt, so the error points at
 * the wrong thing: "fatal: invalid sha1 pointer" or a commit that cannot
 * complete, naming an object that a concurrent write had just created.
 *
 * The repair moves every zero-byte loose object out of the way (never deletes
 * it), restores the refs from the remote, and rebuilds the affected worktree
 * indexes. The procedure was validated by hand on a damaged clone; this module
 * is that procedure, automated.
 *
 * It lives in src/ (not scripts/) so the app can offer the READ-ONLY half as a
 * project action; scripts/git-doctor.mjs is a thin CLI over it.
 *
 * Every git call here is ASYNCHRONOUS, and that is not a style choice: the
 * read-only half runs inside the app's request handler, and `git fsck` on a
 * large clone is not quick. A blocking call would stall the whole server —
 * every session's terminal, every other route — for as long as the check
 * takes. (The same reason src/services/git-status.ts spawns rather than
 * execFileSyncs.)
 */

/** How long a single git call may run before it is abandoned. */
const GIT_TIMEOUT_MS = 30_000;

/** How long a timed-out git process gets to die on SIGTERM before SIGKILL. */
const KILL_ESCALATION_MS = 2_000;

/** How the caller wants progress reported. */
export type DoctorLog = (line: string) => void;

/** The shapes are shared with the frontend (src/shared/types.ts), so they
 * live there and are re-exported from here. */
export type { CloneHealth, RepairOutcome, RepairPlan };

/** What one git invocation produced. */
interface GitOutcome {
  /** The exit code, or null when the process was killed before it finished. */
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs git and resolves with what it produced.
 *
 * A non-zero exit is NOT a rejection: for `git fsck` a non-zero exit is the
 * interesting case, and the caller decides what it means. It rejects only
 * when git could not be started at all.
 *
 * A call that outruns GIT_TIMEOUT_MS is killed and reported with a `fatal:`
 * line on stderr, so a check that could not finish says so rather than
 * reporting an empty (and therefore "healthy") result.
 */
function runGit(
  args: string[],
  opts: { input?: string; timeoutMs?: number } = {},
): Promise<GitOutcome> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    // The whole argv, for the messages: args[0] is usually "-C", which would
    // make a diagnostic read "git -C timed out".
    const what = args.join(" ");
    const budgetMs = opts.timeoutMs ?? GIT_TIMEOUT_MS;

    const child = spawn("git", [...GIT_NO_AUTO_GC, ...args], {
      stdio: opts.input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
      env: gitEnv(),
    });

    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    };
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    };
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);

    const clearKillTimer = () => {
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      clearKillTimer();
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
    };

    const finish = (outcome: GitOutcome) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      stderr += `fatal: git ${what} timed out after ${budgetMs}ms\n`;
      // SIGKILL if it ignores SIGTERM: `child.killed` only says the signal
      // was sent, not that the process died.
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, KILL_ESCALATION_MS);
      killTimer.unref?.();
    }, budgetMs);
    timer.unref?.();

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });

    child.on("close", (code) => {
      finish({ code, stdout, stderr });
    });

    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

/** Runs git, returning trimmed stdout. Throws when git exits non-zero. */
async function git(
  args: string[],
  opts: { input?: string; timeoutMs?: number } = {},
): Promise<string> {
  const result = await runGit(args, opts);
  if (result.code !== 0) {
    const err = new Error(`git ${args.join(" ")} exited with ${result.code}`) as Error & {
      stdout?: string;
      stderr?: string;
    };
    err.stdout = result.stdout;
    err.stderr = result.stderr;
    throw err;
  }
  return result.stdout.trim();
}

/** Runs git, returning its raw stdout (no trimming — for NUL-separated output). */
async function gitRaw(
  args: string[],
  opts: { input?: string; timeoutMs?: number } = {},
): Promise<string | null> {
  try {
    const result = await runGit(args, opts);
    return result.code === 0 ? result.stdout : null;
  } catch {
    return null;
  }
}

/** Runs git, returning trimmed stdout, or null when git exits non-zero. */
async function gitTry(args: string[]): Promise<string | null> {
  const raw = await gitRaw(args);
  return raw === null ? null : raw.trim();
}

/** Splits NUL-separated git output into paths. */
function nulSplit(raw: string): string[] {
  return raw.split("\0").filter(Boolean);
}

/** The shared git dir — the one every worktree of this clone reads. */
async function commonDir(cwd: string): Promise<string | null> {
  const raw = await gitTry(["-C", cwd, "rev-parse", "--git-common-dir"]);
  if (!raw) return null;
  return path.resolve(cwd, raw);
}

/**
 * Zero-byte regular files under `root`, as paths relative to it.
 *
 * A loose object lives at `<2 hex>/<38 hex>`; a zero-byte file there is the
 * #1836 damage. A zero-byte file elsewhere under `objects/` (a pack, an idx) is
 * a different and riskier kind of damage — reported, but never quarantined
 * automatically.
 *
 * CodeQL's js/path-injection flags the two fs calls below: `dir` and `abs`
 * derive from the clone's objects directory, which derives from the cwd the
 * caller asked about. It is a false positive here, for three reasons:
 *
 *   - the walk cannot leave its root. `entry.name` is a single path component
 *     as readdir returns it — never a separator — so `path.join` of a root
 *     with one stays inside the root;
 *   - symlinks are not followed. `withFileTypes` reports a symlink as neither
 *     a file nor a directory, so a symlinked directory is never descended
 *     into and a symlinked file is never reported;
 *   - the root is not attacker-chosen. It is `<git dir>/objects`, and the git
 *     dir comes from `git rev-parse --git-common-dir`, which fails outside a
 *     real checkout — so the walk is confined to a git dir that git itself
 *     created. On the internal route the cwd is additionally confined to
 *     PROJECTS_ROOTS by requireWithinRoots.
 *
 * Same dismissal posture as src/services/project-dir.ts and
 * src/services/dock-config.ts: acknowledged and dismissed as a false
 * positive via the Security tab, not suppressed in-line (this repo's
 * codeql.yml has no step that turns a SARIF suppression annotation into an
 * actual alert dismissal).
 */
function findZeroByteFiles(root: string, maxDepth = 3): string[] {
  const found: string[] = [];
  const walk = (dir: string, prefix: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = prefix ? path.join(prefix, entry.name) : entry.name;
      if (entry.isDirectory()) {
        walk(abs, rel, depth + 1);
      } else if (entry.isFile()) {
        try {
          if (fs.statSync(abs).size === 0) found.push(rel);
        } catch {
          // Raced with something else removing it — not our problem.
        }
      }
    }
  };
  walk(root, "", 1);
  return found;
}

/**
 * A loose-object path is `<2 hex>/<38 hex>` — that is the sha, split in two.
 *
 * The two segments are compared separately rather than the joined string, so
 * the check works whichever separator `path.join` produced.
 */
export function isLooseObjectPath(rel: string): boolean {
  const parts = rel.split(/[/\\]/);
  return parts.length === 2 && /^[0-9a-f]{2}$/.test(parts[0]) && /^[0-9a-f]{38}$/.test(parts[1]);
}

/** The sha a loose object path names. */
export function shaOfLoosePath(rel: string): string {
  return rel.split(/[/\\]/).join("");
}

/** The marker runGit puts on stderr when a git call outruns its budget. */
const TIMEOUT_MARKER = /timed out after \d+ms/;

/** What `git fsck` found — and whether it finished at all. */
interface FsckResult {
  /** The error lines, without the `dangling …` noise that is normal. */
  errors: string[];
  /**
   * True when fsck was abandoned at its timeout.
   *
   * A check that could not finish is NOT a finding. "We could not tell" and
   * "we found damage" are different answers, and telling a user their clone
   * is damaged — and offering to repair it — when the check simply ran out
   * of time is the wrong answer in the worst possible direction.
   */
  timedOut: boolean;
}

/** git fsck's error lines, without the `dangling …` noise that is normal. */
async function fsckErrors(cwd: string, timeoutMs?: number): Promise<FsckResult> {
  let output: string;
  try {
    output = await git(["-C", cwd, "fsck", "--connectivity-only", "--no-progress"], {
      timeoutMs,
    });
  } catch (err) {
    // fsck exits non-zero when it finds problems — that is the interesting case.
    const e = err as { stdout?: string; stderr?: string };
    output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const timedOut = lines.some((line) => TIMEOUT_MARKER.test(line));
  const errors = lines
    // The timeout line is not a finding about the clone — it is the reason
    // there is no verdict. It is reported as `timedOut` instead.
    .filter((line) => !TIMEOUT_MARKER.test(line))
    .filter((line) => /^(error|fatal|missing|invalid sha1 pointer)/i.test(line));
  return { errors, timedOut };
}

/** Can git still read this object? */
async function probe(
  cwd: string,
  sha: string,
): Promise<{ ok: true; type: string } | { ok: false; detail: string }> {
  try {
    return { ok: true, type: await git(["-C", cwd, "cat-file", "-t", sha]) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    const detail = `${e.stderr ?? ""}${e.stdout ?? ""}`.trim().split("\n")[0] ?? "";
    return { ok: false, detail: detail || "unknown error" };
  }
}

/** The worktrees of this clone, as absolute paths. */
async function worktrees(cwd: string): Promise<string[]> {
  const porcelain = await gitTry(["-C", cwd, "worktree", "list", "--porcelain"]);
  if (!porcelain) return [];
  return porcelain
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => path.resolve(cwd, line.slice("worktree ".length).trim()));
}

/**
 * Rebuild one worktree's index.
 *
 * The index is rebuilt from HEAD — which drops the stale cache-tree that names
 * the broken object — and then exactly the paths that were staged are
 * re-staged from the working tree:
 *
 * - `git add -A` with an EXPLICIT pathspec limits the operation to those
 *   paths, so an unrelated untracked file is never adopted;
 * - a path that is staged AND has been changed again in the working tree
 *   holds content the working tree does not have. Re-staging it from the
 *   working tree would discard that content, so the rebuild refuses.
 */
/**
 * The staged paths that are ALSO changed in the working tree.
 *
 * Re-staging those from the working tree would discard the staged content, so
 * the rebuild refuses them. `readable: false` means the index could not be
 * read at all — the rebuild then proceeds without the check (and says so).
 *
 * ONE helper, called by BOTH the plan and the repair: what the user is shown
 * before confirming is then the same decision the repair makes.
 */
async function lostStagedPaths(
  worktreePath: string,
): Promise<{ staged: string[]; lost: string[]; readable: boolean }> {
  const stagedRaw = await gitRaw(["-C", worktreePath, "diff", "--cached", "--name-only", "-z"]);
  const dirtyRaw = await gitRaw(["-C", worktreePath, "diff", "--name-only", "-z"]);
  const staged = stagedRaw === null ? [] : nulSplit(stagedRaw);
  if (stagedRaw === null || dirtyRaw === null) {
    return { staged, lost: [], readable: false };
  }
  const dirty = new Set(nulSplit(dirtyRaw));
  return { staged, lost: staged.filter((p) => dirty.has(p)), readable: true };
}

/**
 * Rebuild one worktree's index.
 *
 * The index is rebuilt from HEAD — which drops the stale cache-tree that names
 * the broken object — and then exactly the paths that were staged are
 * re-staged from the working tree:
 *
 * - `git add -A` with an EXPLICIT pathspec limits the operation to those
 *   paths, so an unrelated untracked file is never adopted;
 * - a path that is staged AND has been changed again in the working tree
 *   holds content the working tree does not have. Re-staging it from the
 *   working tree would discard that content, so the rebuild refuses.
 */
async function rebuildIndex(
  worktreePath: string,
  force: boolean,
  log: DoctorLog,
): Promise<{ rebuilt: boolean; reason?: string; skippedPaths?: string[] }> {
  const { staged, lost, readable } = await lostStagedPaths(worktreePath);

  if (!readable) {
    log(`  ${worktreePath}: could not read the index — rebuilding without a check`);
  } else if (lost.length > 0 && !force) {
    log(
      `  ${worktreePath}: SKIPPED — these paths are staged and have changed again in the` +
        ` working tree, so re-staging them would discard what you staged:`,
    );
    for (const p of lost) log(`    ${p}`);
    log("    --force overrides");
    return { rebuilt: false, reason: "staged content would be lost", skippedPaths: lost };
  }

  try {
    await git(["-C", worktreePath, "read-tree", "HEAD"]);
    if (staged.length > 0) {
      // An explicit pathspec: only the paths that were staged are touched,
      // and `git add -A` with a pathspec stages a deletion too. The pathspec
      // has to come in on stdin, so this call's stdin is a pipe — the
      // default `stdio` here ignores it, and an EMPTY pathspec would mean
      // "everything".
      //
      // `--literal-pathspecs` matters: without it the paths are GLOBS, and a
      // staged file literally named `*.md` (or `:(top)x`) would widen the
      // re-stage to every file it matches — the leak the pathspec was added
      // to close.
      await git(
        [
          "-C",
          worktreePath,
          "--literal-pathspecs",
          "add",
          "-A",
          "--pathspec-from-file=-",
          "--pathspec-file-nul",
        ],
        { input: staged.map((p) => `${p}\0`).join("") },
      );
    }
    log(`  ${worktreePath}: index rebuilt`);
    return { rebuilt: true };
  } catch (err) {
    log(`  ${worktreePath}: index rebuild failed — ${(err as Error).message}`);
    return { rebuilt: false, reason: "index rebuild failed" };
  }
}

/**
 * The READ-ONLY half: what is wrong with this clone, if anything.
 *
 * Never mutates anything — the app offers this as a project action, and it
 * has to be safe to run against a repository the user is working in.
 */
export async function inspectGitClone(
  cwd: string,
  opts: { fsckTimeoutMs?: number } = {},
): Promise<CloneHealth> {
  const common = await commonDir(cwd);
  if (!common) {
    return {
      gitDir: null,
      zeroByteObjects: [],
      otherZeroByteFiles: [],
      fsckErrors: [],
      healthy: false,
      timedOut: false,
    };
  }
  const objectsDir = path.join(common, "objects");
  const zeroByte = findZeroByteFiles(objectsDir);
  const zeroByteObjects = zeroByte.filter(isLooseObjectPath);
  const otherZeroByteFiles = zeroByte.filter((rel) => !isLooseObjectPath(rel));
  const fsck = await fsckErrors(cwd, opts.fsckTimeoutMs);
  return {
    gitDir: common,
    zeroByteObjects,
    otherZeroByteFiles,
    fsckErrors: fsck.errors,
    healthy:
      zeroByteObjects.length === 0 &&
      otherZeroByteFiles.length === 0 &&
      fsck.errors.length === 0 &&
      !fsck.timedOut,
    timedOut: fsck.timedOut,
  };
}

/**
 * What the repair WOULD do — computed from reads only.
 *
 * The app shows this before it asks for the confirmation, because the repair
 * moves files inside `.git/objects` and rewrites worktree indexes: whoever is
 * about to trigger that is entitled to see what it will do first. Nothing
 * here touches the clone — no quarantine directory is created, nothing is
 * renamed, nothing is fetched.
 *
 * The decisions are the SAME ones `repairGitClone` makes — both call
 * `lostStagedPaths` — so the plan and the repair cannot disagree.
 */
export async function planRepair(cwd: string): Promise<RepairPlan> {
  const common = await commonDir(cwd);
  if (!common) {
    return {
      gitDir: null,
      quarantine: [],
      willFetch: false,
      indexesToRebuild: [],
      indexesToSkip: [],
      actionable: false,
    };
  }
  const objectsDir = path.join(common, "objects");
  const zeroByte = findZeroByteFiles(objectsDir);
  const loose = zeroByte.filter(isLooseObjectPath);

  // A clone with no origin has no remote refs to restore, so there is
  // nothing for the fetch to do.
  const willFetch = (await gitTry(["-C", cwd, "remote", "get-url", "origin"])) !== null;

  const indexesToRebuild: string[] = [];
  const indexesToSkip: { path: string; paths: string[] }[] = [];
  for (const worktreePath of await worktrees(cwd)) {
    const { lost, readable } = await lostStagedPaths(worktreePath);
    if (readable && lost.length > 0) {
      indexesToSkip.push({ path: worktreePath, paths: lost });
    } else {
      indexesToRebuild.push(worktreePath);
    }
  }

  return {
    gitDir: common,
    quarantine: loose.map(shaOfLoosePath),
    willFetch,
    indexesToRebuild,
    indexesToSkip,
    actionable: loose.length > 0,
  };
}

/**
 * The repair half — quarantines the zero-byte objects, restores the refs and
 * rebuilds the affected worktree indexes.
 *
 * The CLI calls this, and so does the app — but the app only ever calls it
 * behind a confirmed action, because it moves files and rewrites indexes in
 * someone's repository.
 */
export async function repairGitClone(
  cwd: string,
  opts: { force?: boolean; log?: DoctorLog } = {},
): Promise<RepairOutcome> {
  const log = opts.log ?? (() => {});
  const force = opts.force === true;
  const common = await commonDir(cwd);
  if (!common) {
    return {
      gitDir: null,
      zeroByteObjects: [],
      otherZeroByteFiles: [],
      fsckErrors: [],
      healthy: false,
      timedOut: false,
      quarantine: null,
      quarantined: [],
      recovered: [],
      unrecovered: [],
      refsRestored: false,
      indexesRebuilt: [],
      indexesSkipped: [],
      whole: false,
    };
  }
  const objectsDir = path.join(common, "objects");
  const zeroByte = findZeroByteFiles(objectsDir);
  const loose = zeroByte.filter(isLooseObjectPath);

  // Step 1 — quarantine. MOVE, never delete: the quarantine is the recovery
  // point, and it lives inside the git dir so the rename is atomic and
  // same-filesystem. It is deliberately outside `objects/`, so git does not
  // see the moved file.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const quarantine = path.join(common, `gc-quarantine-${stamp}`);
  const quarantined: string[] = [];
  for (const rel of loose) {
    // `loose` holds only paths that passed `isLooseObjectPath()` — two hex
    // segments — and a readdir entry name can never contain a separator, so
    // neither join below can leave the directory it is rooted at. The object
    // is MOVED into the quarantine (never deleted), and the quarantine lives
    // inside the same git dir.
    const from = path.join(objectsDir, rel);
    const to = path.join(quarantine, rel);
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      quarantined.push(shaOfLoosePath(rel));
    } catch (err) {
      log(`  could not quarantine ${rel} — ${(err as Error).message}`);
    }
  }
  log(`  quarantined ${quarantined.length} zero-byte object(s) into ${quarantine}`);

  // Step 2 — probe. An object that was only SHADOWED by the empty file (it is
  // in the pack) reads fine now; one that was genuinely deleted still does not.
  // This is informational — the authoritative answer comes after the fetch,
  // which can bring the object back.
  const stillMissing: string[] = [];
  for (const sha of quarantined) {
    const result = await probe(cwd, sha);
    if (result.ok) {
      log(`  ${sha}: readable again (${result.type})`);
    } else {
      stillMissing.push(sha);
      log(`  ${sha}: STILL MISSING — ${result.detail}`);
    }
  }
  if (stillMissing.length > 0) {
    log(
      `  ${stillMissing.length} object(s) are not in the local pack — they must come from the remote.`,
    );
  }

  // Step 3 — restore the refs.
  //
  // Whether the fetch could run is a FACT, not a verdict: whether the clone
  // is whole is fsck's call, and fsck sees the refs the fetch did not
  // restore. If they are broken, fsck says so; if they are fine, they were
  // never broken. A clone with NO origin has no remote refs to restore, so
  // there is nothing for the fetch to do.
  let refsRestored = false;
  if ((await gitTry(["-C", cwd, "remote", "get-url", "origin"])) === null) {
    log("  no 'origin' remote — nothing to restore from");
  } else if ((await gitTry(["-C", cwd, "fetch", "origin", "--prune"])) === null) {
    log("  'git fetch origin --prune' could not run — the refs were not restored");
  } else {
    refsRestored = true;
    log("  refs restored from origin");
  }

  // Step 3b — re-probe. The fetch can bring an object back — one that was
  // gone locally but is reachable from the remote comes with it. So the
  // health verdict has to be taken AFTER the fetch, not before: a clone that
  // the fetch repaired is whole, and must not be reported as broken.
  const unrecovered: string[] = [];
  for (const sha of stillMissing) {
    if (!(await probe(cwd, sha)).ok) unrecovered.push(sha);
  }
  if (stillMissing.length > 0 && unrecovered.length === 0) {
    log(`  all ${stillMissing.length} missing object(s) came back with the fetch`);
  }
  if (unrecovered.length > 0) {
    // NOT a verdict on the clone: an object that was never committed and is
    // not on the remote is simply gone, and nothing references it any more,
    // so fsck has nothing to complain about. The clone can be consistent
    // again and still have lost something — that is its own outcome.
    log(
      `  ${unrecovered.length} object(s) are genuinely gone and must be restored from the remote.`,
    );
  }

  // Step 4 — rebuild the affected worktree indexes.
  log("  rebuilding worktree indexes:");
  const indexesRebuilt: string[] = [];
  const indexesSkipped: string[] = [];
  for (const worktreePath of await worktrees(cwd)) {
    // A rebuild that fails is reported, but it does not by itself condemn the
    // clone: whether anything is actually still broken is settled by the fsck
    // below, which sees the index as it is.
    const result = await rebuildIndex(worktreePath, force, log);
    if (result.rebuilt) indexesRebuilt.push(worktreePath);
    else indexesSkipped.push(`${worktreePath}: ${result.reason ?? "skipped"}`);
  }

  // Step 5 — the verdict. `git fsck` is the authority on whether the clone is
  // whole, and it has to run LAST: it sees the restored refs, the rebuilt
  // indexes and the objects that came back with the fetch.
  const remaining = await fsckErrors(cwd);
  if (remaining.timedOut) {
    log(`  git fsck did not finish (timed out after ${GIT_TIMEOUT_MS}ms) — health is UNKNOWN.`);
  } else if (remaining.errors.length > 0) {
    log(`  ${remaining.errors.length} fsck error(s) remain:`);
    for (const line of remaining.errors) log(`    ${line}`);
  }

  const whole = remaining.errors.length === 0 && !remaining.timedOut;

  return {
    gitDir: common,
    zeroByteObjects: loose,
    otherZeroByteFiles: zeroByte.filter((rel) => !isLooseObjectPath(rel)),
    fsckErrors: remaining.errors,
    healthy: whole,
    timedOut: remaining.timedOut,
    quarantine,
    quarantined,
    recovered: quarantined.filter((sha) => !unrecovered.includes(sha)),
    unrecovered,
    refsRestored,
    indexesRebuilt,
    indexesSkipped,
    whole,
  };
}

/**
 * The CLI's whole run: report, then repair if asked.
 *
 * Exit codes — two questions, two answers:
 *
 *   0 — the clone is healthy, or the repair made it whole.
 *   1 — damage was found (report mode), or the clone is still not whole.
 *   2 — the clone is whole again, but some objects could not be recovered:
 *       they were never committed and are not on the remote, so nothing
 *       references them any more and fsck has nothing to complain about.
 */
export async function runGitDoctor(
  cwd: string,
  opts: { apply?: boolean; force?: boolean; log?: DoctorLog } = {},
): Promise<number> {
  const log = opts.log ?? (() => {});
  const common = await commonDir(cwd);
  if (!common) {
    console.error(
      "git-doctor: not inside a git checkout — 'git rev-parse --git-common-dir' failed.",
    );
    return 1;
  }
  const objectsDir = path.join(common, "objects");

  log("git-doctor: do not run this while another agent is committing in this clone.");
  log(`git-doctor: git dir: ${common}`);

  const zeroByte = findZeroByteFiles(objectsDir);
  const loose = zeroByte.filter(isLooseObjectPath);
  const other = zeroByte.filter((rel) => !isLooseObjectPath(rel));
  const fsck = await fsckErrors(cwd);

  log("");
  log(`Zero-byte files under objects/: ${zeroByte.length}`);
  for (const rel of loose) log(`  loose object  ${rel}  (sha ${shaOfLoosePath(rel)})`);
  for (const rel of other) {
    log(`  OTHER         ${rel}  — not a loose object; this is a different kind of damage`);
  }
  log("");
  if (fsck.timedOut) {
    log(`git fsck: did not finish (timed out after ${GIT_TIMEOUT_MS}ms)`);
  } else {
    log(`git fsck errors: ${fsck.errors.length}`);
    for (const line of fsck.errors) log(`  ${line}`);
  }

  // A check that timed out has no verdict. Saying "damage found" (or
  // "healthy") about a clone we did not finish examining would be a guess
  // dressed up as an answer, so the run says UNKNOWN and stops there.
  if (fsck.timedOut && loose.length === 0) {
    log("");
    log("git-doctor: the health check did not finish — this clone's state is UNKNOWN.");
    return 1;
  }

  const damaged = loose.length > 0 || fsck.errors.length > 0;
  if (!damaged) {
    log("");
    log("git-doctor: this clone looks healthy.");
    return 0;
  }

  if (!opts.apply) {
    log("");
    log("git-doctor: damage found. Re-run with --apply to repair it.");
    return 1;
  }

  log("");
  log("git-doctor: repairing.");

  const outcome = await repairGitClone(cwd, { force: opts.force === true, log });

  log("");
  log(
    `git-doctor: done. The quarantined files are in ${outcome.quarantine} — nothing was deleted.`,
  );
  if (!outcome.whole) {
    log("git-doctor: the clone is NOT whole — see the messages above.");
    return 1;
  }
  if (outcome.unrecovered.length > 0) {
    log(
      "git-doctor: the clone is whole again, but some objects could not be recovered —" +
        " see the messages above.",
    );
    return 2;
  }
  log("git-doctor: the clone is whole.");
  return 0;
}
