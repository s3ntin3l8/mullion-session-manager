#!/usr/bin/env node
// Prints the review references a diff should be read against.
//
// `.claude/skills/mullion-review-invariants/` carries one short checklist
// (SKILL.md) and a set of per-area reference files under `references/`. A
// reviewer cannot be expected to read all of them for every diff, and a
// reviewer that is asked to "pick the relevant ones" does it differently every
// time. This script makes the pick deterministic: `references.json` maps path
// globs to a reference file, and the references whose globs match the diff's
// changed files are the ones to read.
//
// It lives in the repo (not in the review prompt) on purpose: the Task Master
// review prompt is sent to every target repo and cannot name this repo's
// areas. The prompt points at AGENTS.md and the repo's own skill; the skill
// says to run this. It works for a CLI review inside the worker's worktree and
// for an external reviewer (Hermes) in its own clone of the PR head, since both
// have the repo's files. A shallow clone has no merge base, so the diff falls
// back to two dots (see gitChangedFiles); a clone with no base ref at all can
// pipe `git diff --name-only` into `--files -`.
//
// Usage:
//   node scripts/review-references.mjs                      origin/main...HEAD
//   node scripts/review-references.mjs --base <ref> --head <ref>
//   node scripts/review-references.mjs --files -            changed paths on stdin
//   node scripts/review-references.mjs --json               machine-readable
//
// Exit codes: 0 (including "nothing matches"), 2 for a bad invocation or a
// malformed index — a broken index must be loud, not an empty answer.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GIT_NO_AUTO_GC, gitEnv } from "./git-env.mjs";

// Overridable so a test can point the script at a fixture directory instead of
// the real repo (same posture as REVIEW_PROTOCOL_SYNC_ROOT).
const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const INDEX_PATH = ".claude/skills/mullion-review-invariants/references.json";

/**
 * Reads and validates the index: an array of `{ ref, paths[], summary }`.
 * `ref` is repo-relative so the printed path can be opened as-is.
 */
export function loadIndex(root = defaultRoot) {
  const file = path.join(root, INDEX_PATH);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`cannot read ${INDEX_PATH}: ${err instanceof Error ? err.message : err}`, {
      cause: err,
    });
  }
  if (!Array.isArray(parsed)) throw new Error(`${INDEX_PATH} must be a JSON array`);
  for (const [i, entry] of parsed.entries()) {
    const where = `${INDEX_PATH}[${i}]`;
    if (typeof entry?.ref !== "string" || entry.ref === "")
      throw new Error(`${where}: "ref" missing`);
    if (typeof entry.summary !== "string" || entry.summary === "") {
      throw new Error(`${where}: "summary" missing`);
    }
    if (
      !Array.isArray(entry.paths) ||
      entry.paths.length === 0 ||
      entry.paths.some((p) => typeof p !== "string" || p === "")
    ) {
      throw new Error(`${where}: "paths" must be a non-empty array of globs`);
    }
  }
  return parsed;
}

/**
 * The index entries any of `files` matches, in index order, each with the
 * files that matched it. Pure: no git, no disk.
 */
export function matchReferences(index, files) {
  const result = [];
  for (const entry of index) {
    const matched = files.filter((f) => entry.paths.some((glob) => path.matchesGlob(f, glob)));
    if (matched.length > 0) result.push({ ...entry, matched });
  }
  return result;
}

/** Human-readable listing, or the "nothing matches" line. */
export function formatReferences(matches) {
  if (matches.length === 0) return "No area-specific references match this diff.\n";
  const lines = ["Read these references before judging the diff:", ""];
  for (const m of matches) {
    const shown = m.matched.slice(0, 3).join(", ");
    const more = m.matched.length > 3 ? ` (+${m.matched.length - 3} more)` : "";
    lines.push(`- ${m.ref} — ${m.summary}`, `    matched: ${shown}${more}`);
  }
  return lines.join("\n") + "\n";
}

function gitChangedFiles(root, base, head) {
  const diff = (range) =>
    execFileSync("git", [...GIT_NO_AUTO_GC, "diff", "--name-only", "-z", range], {
      cwd: root,
      encoding: "utf8",
      env: gitEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
  let out;
  try {
    out = diff(`${base}...${head}`);
  } catch (err) {
    // Three dots need a merge base, and a shallow clone (--depth 1 of the base
    // and of the head, the usual way an external reviewer prepares a PR) has
    // none. Two dots compare the trees and need none. That is the same set of
    // files when the base is an ancestor of the head, but a superset when the
    // base has moved on past the merge base (the clone cannot tell), so an
    // unexpected extra reference in a shallow clone is not a spurious match.
    try {
      out = diff(`${base}..${head}`);
    } catch {
      throw err;
    }
  }
  return out.split("\0").filter(Boolean);
}

/** The first of `origin/main`, `origin/master` that resolves, for a default base. */
function defaultBase(root) {
  for (const ref of ["origin/main", "origin/master"]) {
    try {
      execFileSync("git", [...GIT_NO_AUTO_GC, "rev-parse", "--verify", "--quiet", ref], {
        cwd: root,
        env: gitEnv(),
        stdio: "ignore",
      });
      return ref;
    } catch {
      // try the next
    }
  }
  throw new Error("no origin/main or origin/master to diff against — pass --base <ref>");
}

function parseArgs(argv) {
  const opts = { base: undefined, head: "HEAD", stdin: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base" || a === "--head") {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      opts[a.slice(2)] = v;
    } else if (a === "--files") {
      if (argv[++i] !== "-") throw new Error('--files only accepts "-" (paths on stdin)');
      opts.stdin = true;
    } else if (a === "--json") {
      opts.json = true;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return opts;
}

/**
 * The whole CLI, as a function: arguments in, `{ code, stdout, stderr }` out.
 * Split from the entry guard below so the tests can drive it in-process (and so
 * its lines are covered) instead of only through a subprocess.
 *
 * `readStdin` is injected for `--files -`; `root` defaults to this repo.
 */
export function runCli(
  argv,
  { root = defaultRoot, readStdin = () => readFileSync(0, "utf8") } = {},
) {
  try {
    const opts = parseArgs(argv);
    const index = loadIndex(root);
    const files = opts.stdin
      ? readStdin()
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
      : gitChangedFiles(root, opts.base ?? defaultBase(root), opts.head);
    const matches = matchReferences(index, files);
    const stdout = opts.json ? JSON.stringify(matches, null, 2) + "\n" : formatReferences(matches);
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      code: 2,
      stdout: "",
      stderr: `review-references: ${err instanceof Error ? err.message : err}\n`,
    };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = runCli(process.argv.slice(2), {
    root: process.env.REVIEW_REFERENCES_ROOT ?? defaultRoot,
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  // exitCode, not exit(): lets a piped stdout drain before the process ends.
  process.exitCode = result.code;
}
