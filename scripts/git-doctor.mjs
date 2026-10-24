#!/usr/bin/env node
// Reports — and, with --apply, repairs — git object damage in this clone.
//
// Issue #1836 — a background `git gc` in a clone that several agents push to
// concurrently can delete a loose object that a concurrent write is creating.
// The repack sequence is pack-then-unlink: an object written *after* the pack
// was built but *before* the unlink is removed without being in the pack.
//
// The symptom is a zero-byte file where a loose object should be. Git then
// reports the object as *missing* rather than corrupt, so the error points at
// the wrong thing: "fatal: invalid sha1 pointer" or a commit that cannot
// complete, naming an object that a concurrent write had just created.
//
// The repair moves every zero-byte loose object out of the way (never
// deletes it), restores the refs from the remote, and rebuilds the affected
// worktree indexes. The procedure was validated by hand on a damaged clone;
// this script is that procedure, automated.
//
// Usage:
//   node scripts/git-doctor.mjs              # report only — never mutates
//   node scripts/git-doctor.mjs --apply      # repair
//   node scripts/git-doctor.mjs --apply --force   # repair, even with staged work
//
// Exit codes: 0 = healthy (or repaired), 1 = damage found (report mode) or the
// repair failed.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { gitEnv } from "./git-env.mjs";

const APPLY = process.argv.includes("--apply");
const FORCE = process.argv.includes("--force");

/** Runs git, returning trimmed stdout. Throws when git exits non-zero. */
function git(args, opts = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    env: gitEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  }).trim();
}

/** Runs git, returning its raw stdout (no trimming — for NUL-separated output). */
function gitRaw(args, opts = {}) {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      env: gitEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      ...opts,
    });
  } catch {
    return null;
  }
}

/** Runs git, returning trimmed stdout, or null when git exits non-zero. */
function gitTry(args, opts = {}) {
  const raw = gitRaw(args, opts);
  return raw === null ? null : raw.trim();
}

/** Splits NUL-separated git output into paths. */
function nulSplit(raw) {
  return raw.split("\0").filter(Boolean);
}

/** The shared git dir — the one every worktree of this clone reads. */
function commonDir() {
  const raw = gitTry(["rev-parse", "--git-common-dir"]);
  if (!raw) return null;
  return path.resolve(raw);
}

/**
 * Zero-byte regular files under `root`, as paths relative to it.
 *
 * A loose object lives at `<2 hex>/<38 hex>`; a zero-byte file there is the
 * #1836 damage. A zero-byte file elsewhere under `objects/` (a pack, an idx) is
 * a different and riskier kind of damage — reported, but never quarantined
 * automatically.
 */
function findZeroByteFiles(root, maxDepth = 3) {
  const found = [];
  const walk = (dir, prefix, depth) => {
    if (depth > maxDepth) return;
    let entries;
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
function isLooseObjectPath(rel) {
  const parts = rel.split(/[/\\]/);
  return parts.length === 2 && /^[0-9a-f]{2}$/.test(parts[0]) && /^[0-9a-f]{38}$/.test(parts[1]);
}

/** The sha a loose object path names. */
function shaOfLoosePath(rel) {
  return rel.split(/[/\\]/).join("");
}

/** git fsck's error lines, without the `dangling …` noise that is normal. */
function fsckErrors() {
  let output;
  try {
    output = execFileSync("git", ["fsck", "--connectivity-only", "--no-progress"], {
      encoding: "utf8",
      env: gitEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    // fsck exits non-zero when it finds problems — that is the interesting case.
    output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
  return output
    .split("\n")
    .filter((line) => /^(error|fatal|missing|invalid sha1 pointer)/i.test(line.trim()))
    .map((line) => line.trim());
}

/** Can git still read this object? */
function probe(sha) {
  try {
    return { ok: true, type: git(["cat-file", "-t", sha]) };
  } catch (err) {
    const detail = `${err.stderr ?? ""}${err.stdout ?? ""}`.trim().split("\n")[0] ?? "";
    return { ok: false, detail: detail || "unknown error" };
  }
}

/** The worktrees of this clone, as absolute paths. */
function worktrees() {
  const porcelain = gitTry(["worktree", "list", "--porcelain"]);
  if (!porcelain) return [];
  return porcelain
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => path.resolve(line.slice("worktree ".length).trim()));
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
function rebuildIndex(worktreePath, force) {
  const stagedRaw = gitRaw(["-C", worktreePath, "diff", "--cached", "--name-only", "-z"]);
  const dirtyRaw = gitRaw(["-C", worktreePath, "diff", "--name-only", "-z"]);

  if (stagedRaw === null || dirtyRaw === null) {
    console.log(`  ${worktreePath}: could not read the index — rebuilding without a check`);
  } else {
    const staged = nulSplit(stagedRaw);
    const dirty = new Set(nulSplit(dirtyRaw));
    // Staged AND changed again in the working tree: the staged content is
    // not in the working tree, so re-staging would discard it.
    const lost = staged.filter((p) => dirty.has(p));
    if (lost.length > 0 && !force) {
      console.log(
        `  ${worktreePath}: SKIPPED — these paths are staged and have changed again in the` +
          ` working tree, so re-staging them would discard what you staged:`,
      );
      for (const p of lost) console.log(`    ${p}`);
      console.log("    --force overrides");
      return false;
    }
  }

  const stagedPaths = stagedRaw === null ? [] : nulSplit(stagedRaw);
  try {
    git(["-C", worktreePath, "read-tree", "HEAD"]);
    if (stagedPaths.length > 0) {
      // An explicit pathspec: only the paths that were staged are touched,
      // and `git add -A` with a pathspec stages a deletion too. The pathspec
      // has to come in on stdin, so this call's stdin is a pipe — the
      // default `stdio` here ignores it, and an EMPTY pathspec would mean
      // "everything".
      git(["-C", worktreePath, "add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], {
        input: stagedPaths.map((p) => `${p}\0`).join(""),
        stdio: ["pipe", "pipe", "pipe"],
      });
    }
    console.log(`  ${worktreePath}: index rebuilt`);
    return true;
  } catch (err) {
    console.log(`  ${worktreePath}: index rebuild failed — ${err.message}`);
    return false;
  }
}

function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(
      "Usage: node scripts/git-doctor.mjs [--apply] [--force]\n\n" +
        "  (no flags)  report damage; never mutates anything\n" +
        "  --apply     repair: quarantine the zero-byte objects, restore the refs,\n" +
        "              rebuild the affected worktree indexes\n" +
        "  --force     rebuild the indexes even when there is staged work",
    );
    return 0;
  }

  const common = commonDir();
  if (!common) {
    console.error(
      "git-doctor: not inside a git checkout — 'git rev-parse --git-common-dir' failed.",
    );
    return 1;
  }
  const objectsDir = path.join(common, "objects");

  console.log("git-doctor: do not run this while another agent is committing in this clone.");
  console.log(`git-doctor: git dir: ${common}`);

  const zeroByte = findZeroByteFiles(objectsDir);
  const loose = zeroByte.filter(isLooseObjectPath);
  const other = zeroByte.filter((rel) => !isLooseObjectPath(rel));
  const fsck = fsckErrors();

  console.log("");
  console.log(`Zero-byte files under objects/: ${zeroByte.length}`);
  for (const rel of loose) console.log(`  loose object  ${rel}  (sha ${shaOfLoosePath(rel)})`);
  for (const rel of other) {
    console.log(`  OTHER         ${rel}  — not a loose object; this is a different kind of damage`);
  }
  console.log("");
  console.log(`git fsck errors: ${fsck.length}`);
  for (const line of fsck) console.log(`  ${line}`);

  const damaged = loose.length > 0 || fsck.length > 0;
  if (!damaged) {
    console.log("");
    console.log("git-doctor: this clone looks healthy.");
    return 0;
  }

  if (!APPLY) {
    console.log("");
    console.log("git-doctor: damage found. Re-run with --apply to repair it.");
    return 1;
  }

  console.log("");
  console.log("git-doctor: repairing.");

  // The repair is only complete if the objects are readable again AND the
  // refs came back. Anything short of that leaves the clone broken, and the
  // exit code has to say so — `make git-doctor APPLY=1` is a health check.
  let repaired = true;

  // Step 1 — quarantine. MOVE, never delete: the quarantine is the recovery
  // point, and it lives inside the git dir so the rename is atomic and
  // same-filesystem. It is deliberately outside `objects/`, so git does not
  // see the moved file.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const quarantine = path.join(common, `gc-quarantine-${stamp}`);
  const moved = [];
  for (const rel of loose) {
    const from = path.join(objectsDir, rel);
    const to = path.join(quarantine, rel);
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      moved.push({ rel, sha: shaOfLoosePath(rel) });
    } catch (err) {
      console.log(`  could not quarantine ${rel} — ${err.message}`);
      repaired = false;
    }
  }
  console.log(`  quarantined ${moved.length} zero-byte object(s) into ${quarantine}`);

  // Step 2 — probe. An object that was only SHADOWED by the empty file (it is
  // in the pack) reads fine now; one that was genuinely deleted still does not,
  // and has to come back from the remote.
  const stillMissing = [];
  for (const { sha } of moved) {
    const result = probe(sha);
    if (result.ok) {
      console.log(`  ${sha}: readable again (${result.type})`);
    } else {
      stillMissing.push(sha);
      console.log(`  ${sha}: STILL MISSING — ${result.detail}`);
    }
  }
  if (stillMissing.length > 0) {
    repaired = false;
    console.log(
      `  ${stillMissing.length} object(s) are genuinely gone and must be restored from the remote.`,
    );
  }

  // Step 3 — restore the refs.
  const fetched = gitTry(["fetch", "origin", "--prune"]);
  if (fetched === null) {
    repaired = false;
    console.log("  'git fetch origin --prune' failed — the refs could not be restored.");
  } else {
    console.log("  refs restored from origin");
  }

  // Step 4 — rebuild the affected worktree indexes.
  console.log("  rebuilding worktree indexes:");
  const paths = worktrees();
  for (const worktreePath of paths) {
    if (!rebuildIndex(worktreePath, FORCE)) repaired = false;
  }

  console.log("");
  console.log(
    `git-doctor: done. The quarantined files are in ${quarantine} — nothing was deleted.`,
  );
  if (!repaired) {
    console.log("git-doctor: the clone is NOT fully repaired — see the messages above.");
    return 1;
  }
  return 0;
}

process.exit(main());
