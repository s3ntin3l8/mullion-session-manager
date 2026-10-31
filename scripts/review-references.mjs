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
// says to run this. It works the same for a CLI review inside the worker's
// worktree and for an external reviewer (Hermes) in its own clone of the PR
// head, since both have the repo's files.
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
  const out = execFileSync(
    "git",
    [...GIT_NO_AUTO_GC, "diff", "--name-only", "-z", `${base}...${head}`],
    { cwd: root, encoding: "utf8", env: gitEnv(), stdio: ["ignore", "pipe", "pipe"] },
  );
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

function main() {
  const root = process.env.REVIEW_REFERENCES_ROOT ?? defaultRoot;
  const opts = parseArgs(process.argv.slice(2));
  const index = loadIndex(root);
  const files = opts.stdin
    ? readFileSync(0, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
    : gitChangedFiles(root, opts.base ?? defaultBase(root), opts.head);
  const matches = matchReferences(index, files);
  process.stdout.write(
    opts.json ? JSON.stringify(matches, null, 2) + "\n" : formatReferences(matches),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`review-references: ${err instanceof Error ? err.message : err}\n`);
    process.exit(2);
  }
}
