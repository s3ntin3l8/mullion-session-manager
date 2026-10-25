import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { GIT_NO_AUTO_GC, gitEnv } from "./git-env.js";
import type { CloneHealth } from "../shared/types.js";

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

/** What a read-only inspection found. The shape is shared with the frontend
 * (src/shared/types.ts), so it lives there and is re-exported from here. */
export type { CloneHealth };

/** What a repair did. */
export interface RepairOutcome extends CloneHealth {
  /** Where the moved-aside files went. */
  quarantine: string | null;
  /** The shas that were quarantined. */
  quarantined: string[];
  /** The shas that read fine again (they were only shadowed). */
  recovered: string[];
  /** The shas that are genuinely gone — never committed, not on the remote. */
  unrecovered: string[];
  /** Whether the remote refs were restored. */
  refsRestored: boolean;
  /** The worktrees whose index was rebuilt. */
  indexesRebuilt: string[];
  /** The worktrees whose index was left alone, and why. */
  indexesSkipped: string[];
  /** True when the clone is consistent again. */
  whole: boolean;
}

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
function runGit(args: string[], opts: { input?: string } = {}): Promise<GitOutcome> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    // The whole argv, for the messages: args[0] is usually "-C", which would
    // make a diagnostic read "git -C timed out".
    const what = args.join(" ");

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
      stderr += `fatal: git ${what} timed out after ${GIT_TIMEOUT_MS}ms\n`;
      // SIGKILL if it ignores SIGTERM: `child.killed` only says the signal
      // was sent, not that the process died.
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, KILL_ESCALATION_MS);
      killTimer.unref?.();
    }, GIT_TIMEOUT_MS);
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
async function git(args: string[], opts: { input?: string } = {}): Promise<string> {
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
async function gitRaw(args: string[], opts: { input?: string } = {}): Promise<string | null> {
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

/** git fsck's error lines, without the `dangling …` noise that is normal. */
async function fsckErrors(cwd: string): Promise<string[]> {
  let output: string;
  try {
    output = await git(["-C", cwd, "fsck", "--connectivity-only", "--no-progress"]);
  } catch (err) {
    // fsck exits non-zero when it finds problems — that is the interesting case.
    const e = err as { stdout?: string; stderr?: string };
    output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  return output
    .split("\n")
    .filter((line) => /^(error|fatal|missing|invalid sha1 pointer)/i.test(line.trim()))
    .map((line) => line.trim());
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
async function rebuildIndex(
  cwd: string,
  worktreePath: string,
  force: boolean,
  log: DoctorLog,
): Promise<{ rebuilt: boolean; reason?: string; skippedPaths?: string[] }> {
  const stagedRaw = await gitRaw(["-C", worktreePath, "diff", "--cached", "--name-only", "-z"]);
  const dirtyRaw = await gitRaw(["-C", worktreePath, "diff", "--name-only", "-z"]);
  const stagedPaths = stagedRaw === null ? [] : nulSplit(stagedRaw);

  if (stagedRaw === null || dirtyRaw === null) {
    log(`  ${worktreePath}: could not read the index — rebuilding without a check`);
  } else {
    const dirty = new Set(nulSplit(dirtyRaw));
    // Staged AND changed again in the working tree: the staged content is
    // not in the working tree, so re-staging would discard it.
    const lost = stagedPaths.filter((p) => dirty.has(p));
    if (lost.length > 0 && !force) {
      log(
        `  ${worktreePath}: SKIPPED — these paths are staged and have changed again in the` +
          ` working tree, so re-staging them would discard what you staged:`,
      );
      for (const p of lost) log(`    ${p}`);
      log("    --force overrides");
      return { rebuilt: false, reason: "staged content would be lost", skippedPaths: lost };
    }
  }

  try {
    await git(["-C", worktreePath, "read-tree", "HEAD"]);
    if (stagedPaths.length > 0) {
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
        { input: stagedPaths.map((p) => `${p}\0`).join("") },
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
export async function inspectGitClone(cwd: string): Promise<CloneHealth> {
  const common = await commonDir(cwd);
  if (!common) {
    return {
      gitDir: null,
      zeroByteObjects: [],
      otherZeroByteFiles: [],
      fsckErrors: [],
      healthy: false,
    };
  }
  const objectsDir = path.join(common, "objects");
  const zeroByte = findZeroByteFiles(objectsDir);
  const zeroByteObjects = zeroByte.filter(isLooseObjectPath);
  const otherZeroByteFiles = zeroByte.filter((rel) => !isLooseObjectPath(rel));
  const fsck = await fsckErrors(cwd);
  return {
    gitDir: common,
    zeroByteObjects,
    otherZeroByteFiles,
    fsckErrors: fsck,
    healthy: zeroByteObjects.length === 0 && otherZeroByteFiles.length === 0 && fsck.length === 0,
  };
}

/**
 * The repair half — quarantines the zero-byte objects, restores the refs and
 * rebuilds the affected worktree indexes.
 *
 * Only the CLI calls this: it moves files and rewrites indexes in someone's
 * repository, which belongs behind a deliberate, operator-run confirmation.
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
    const result = await rebuildIndex(cwd, worktreePath, force, log);
    if (result.rebuilt) indexesRebuilt.push(worktreePath);
    else indexesSkipped.push(`${worktreePath}: ${result.reason ?? "skipped"}`);
  }

  // Step 5 — the verdict. `git fsck` is the authority on whether the clone is
  // whole, and it has to run LAST: it sees the restored refs, the rebuilt
  // indexes and the objects that came back with the fetch.
  const remaining = await fsckErrors(cwd);
  if (remaining.length > 0) {
    log(`  ${remaining.length} fsck error(s) remain:`);
    for (const line of remaining) log(`    ${line}`);
  }

  return {
    gitDir: common,
    zeroByteObjects: loose,
    otherZeroByteFiles: zeroByte.filter((rel) => !isLooseObjectPath(rel)),
    fsckErrors: remaining,
    healthy: remaining.length === 0,
    quarantine,
    quarantined,
    recovered: quarantined.filter((sha) => !unrecovered.includes(sha)),
    unrecovered,
    refsRestored,
    indexesRebuilt,
    indexesSkipped,
    whole: remaining.length === 0,
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
  log(`git fsck errors: ${fsck.length}`);
  for (const line of fsck) log(`  ${line}`);

  const damaged = loose.length > 0 || fsck.length > 0;
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
