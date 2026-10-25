#!/usr/bin/env node
// Calculates patch test coverage for modified/added lines against base branch (origin/main).
// Reads coverage/coverage-final.json (backend) and frontend/coverage/coverage-final.json (frontend).
// Enforces minimum threshold (default 75%).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GIT_NO_AUTO_GC, gitEnv } from "./git-env.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function resolveBaseRef(explicitRef) {
  const sanitize = (ref) => {
    if (!ref || typeof ref !== "string") return null;
    const trimmed = ref.trim();
    return /^[a-zA-Z0-9._~^/-]+$/.test(trimmed) ? trimmed : null;
  };

  const validExplicit = sanitize(explicitRef);
  if (validExplicit) return validExplicit;

  const envRef = sanitize(process.env.PATCH_BASE_REF);
  if (envRef) return envRef;

  const candidates = ["origin/main", "main", "HEAD~1"];
  for (const ref of candidates) {
    try {
      execFileSync("git", [...GIT_NO_AUTO_GC, "rev-parse", "--verify", ref], {
        cwd: root,
        stdio: "ignore",
        env: gitEnv(),
      });
      return ref;
    } catch {
      // try next
    }
  }
  return null;
}

/** A coverable source file: src/ or frontend/src/ code, not tests or fixtures. */
export function isSourceFile(file) {
  return (
    (file.startsWith("src/") || file.startsWith("frontend/src/")) &&
    /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file) &&
    !file.includes(".test.") &&
    !file.includes(".spec.") &&
    !file.includes("/fixtures/")
  );
}

export function parseGitDiffHunks(diffText) {
  // Returns Map<filePath, Set<lineNumber>>
  const files = new Map();
  let currentFile = null;

  const lines = diffText.split("\n");
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      currentFile = null;
    } else if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6).trim();
      if (!isSourceFile(currentFile)) {
        currentFile = null;
      } else if (!files.has(currentFile)) {
        files.set(currentFile, new Set());
      }
    } else if (currentFile && line.startsWith("@@ ")) {
      // Format: @@ -oldStart[,oldCount] +newStart[,newCount] @@
      const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (match) {
        const start = parseInt(match[1], 10);
        const count = match[2] !== undefined ? parseInt(match[2], 10) : 1;
        for (let i = 0; i < count; i++) {
          files.get(currentFile).add(start + i);
        }
      }
    }
  }

  return files;
}

/**
 * The files `diffText` deletes (a `--- a/<path>` followed by `+++ /dev/null`).
 * A diff that only deletes files has nothing to cover, which is also exactly
 * what a damaged index looks like (every tracked file staged as deleted), so
 * runPatchCoverageCheck warns instead of reporting a silent 100%.
 */
export function deletedFiles(diffText) {
  const deleted = [];
  let from = null;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("--- a/")) from = line.slice(6).trim();
    else if (line.startsWith("+++ ")) {
      if (from && line.trim() === "+++ /dev/null") deleted.push(from);
      from = null;
    }
  }
  return deleted;
}

export function loadCoverageReports() {
  const coverageData = {};

  const paths = [
    path.join(root, "coverage/coverage-final.json"),
    path.join(root, "frontend/coverage/coverage-final.json"),
  ];

  for (const p of paths) {
    if (existsSync(p)) {
      try {
        const content = JSON.parse(readFileSync(p, "utf8"));
        for (const [key, val] of Object.entries(content)) {
          // Normalize to path relative to root
          const relPath = path.isAbsolute(key) ? path.relative(root, key) : key;
          coverageData[relPath] = val;
        }
      } catch (err) {
        console.warn(`Warning: failed to parse coverage file ${p}:`, err);
      }
    }
  }

  return coverageData;
}

export function evaluatePatchCoverage(modifiedFiles, coverageData) {
  const results = [];
  let totalExecutableLines = 0;
  let totalCoveredLines = 0;

  for (const [relPath, changedLines] of modifiedFiles.entries()) {
    // Find matching entry in coverageData
    let fileCoverage = coverageData[relPath];
    if (!fileCoverage) {
      // Istanbul keys are absolute paths; try normalizing before suffix-matching.
      // Prefer an exact match on the normalized key (strip any leading root prefix)
      // to avoid attributing coverage from src/a/tasks.ts to src/b/tasks.ts when
      // both share the same filename but differ in directory.
      for (const [covPath, val] of Object.entries(coverageData)) {
        const normalizedCov = covPath.replace(/\\/g, "/");
        // Exact match: covPath ends with /<relPath> (absolute path → relative tail)
        if (
          normalizedCov === `${root.replace(/\\/g, "/")}/${relPath}` ||
          normalizedCov.endsWith(`/${relPath}`)
        ) {
          fileCoverage = val;
          break;
        }
      }
    }

    const coveredLines = new Set();
    const uncoveredLines = new Set();

    if (!fileCoverage || !fileCoverage.statementMap) {
      // File modified but has no coverage entry at all.
      // Check for executable lines, skipping imports, types, interfaces, and comments
      const absPath = path.join(root, relPath);
      if (existsSync(absPath)) {
        const fileContent = readFileSync(absPath, "utf8").split("\n");
        for (const lineNo of changedLines) {
          const lineText = fileContent[lineNo - 1];
          if (!lineText) continue;
          const trimmed = lineText.trim();
          if (
            !trimmed ||
            trimmed.startsWith("//") ||
            trimmed.startsWith("/*") ||
            trimmed.startsWith("*") ||
            trimmed.startsWith("import ") ||
            trimmed.startsWith("export type ") ||
            trimmed.startsWith("export interface ") ||
            trimmed.startsWith("type ") ||
            trimmed.startsWith("interface ") ||
            trimmed === "}" ||
            trimmed === "};" ||
            trimmed === "})" ||
            trimmed === "});"
          ) {
            continue;
          }
          uncoveredLines.add(lineNo);
        }
      }
    } else {
      const statementMap = fileCoverage.statementMap;
      const s = fileCoverage.s || {};

      // Map line numbers to statements
      for (const lineNo of changedLines) {
        const statementsOnLine = [];
        for (const [stmtId, stmt] of Object.entries(statementMap)) {
          const startLine = stmt.start.line;
          const endLine = stmt.end.line || startLine;
          if (startLine <= lineNo && lineNo <= endLine) {
            statementsOnLine.push({ id: stmtId, isStart: startLine === lineNo });
          }
        }

        if (statementsOnLine.length === 0) {
          // Not an executable statement line (comment, type, blank, etc.)
          continue;
        }

        // Prefer statements starting on this line if any
        const primary = statementsOnLine.filter((s) => s.isStart);
        const toCheck = primary.length > 0 ? primary : statementsOnLine;

        const isCovered = toCheck.some((item) => (s[item.id] || 0) > 0);
        if (isCovered) {
          coveredLines.add(lineNo);
        } else {
          uncoveredLines.add(lineNo);
        }
      }
    }

    const executableCount = coveredLines.size + uncoveredLines.size;
    totalExecutableLines += executableCount;
    totalCoveredLines += coveredLines.size;

    results.push({
      file: relPath,
      totalExecutable: executableCount,
      covered: coveredLines.size,
      uncovered: uncoveredLines.size,
      uncoveredLines: [...uncoveredLines].sort((a, b) => a - b),
      coveragePercent: executableCount > 0 ? (coveredLines.size / executableCount) * 100 : 100,
    });
  }

  const overallPercent =
    totalExecutableLines > 0 ? (totalCoveredLines / totalExecutableLines) * 100 : 100;

  return {
    results,
    totalExecutableLines,
    totalCoveredLines,
    overallPercent,
  };
}

export function runPatchCoverageCheck(options = {}) {
  const threshold = options.threshold ?? 75.0;
  const baseRef = resolveBaseRef(options.baseRef);

  // Get git diff
  let diffText = options.diffText;
  // Every source path at the diff base: lets a damaged index (all of them
  // staged as deleted) fail loudly instead of passing as an empty patch.
  let baseSourceFiles = options.baseSourceFiles ?? [];
  if (diffText === undefined) {
    if (!baseRef) {
      console.error(
        "ERROR: Could not resolve a base ref (origin/main, main, HEAD~1) to compute patch diff against.",
      );
      return { ok: false, overallPercent: 0, error: "no-base-ref" };
    }
    // Use the merge-base (common ancestor of baseRef and HEAD) rather than
    // baseRef's tip, so the diff correctly reflects only what diverged from
    // the branch point — not extra commits on main that advanced after the
    // branch was cut. git diff origin/main..HEAD and a pre-rebase run would
    // both over-count if baseRef has advanced past the fork point.
    let diffBase = baseRef; // fallback: diff against baseRef tip if merge-base fails
    try {
      try {
        diffBase = execFileSync("git", [...GIT_NO_AUTO_GC, "merge-base", baseRef, "HEAD"], {
          cwd: root,
          encoding: "utf8",
          env: gitEnv(),
        }).trim();
      } catch {
        // merge-base can fail (e.g. when baseRef IS HEAD, or — the common
        // Task Master worktree case — a shallow clone with no common
        // ancestor in its history). diffBase falls back to baseRef's tip,
        // which over-counts if baseRef has advanced past the fork point;
        // surfaced loudly rather than silently, since a shallow clone makes
        // this the norm, not the exception, for automated worktrees.
        console.warn(
          `WARNING: could not compute merge-base with ${baseRef} (shallow clone?) — ` +
            `falling back to diffing against ${baseRef}'s tip, which over-counts patch size ` +
            "if it has advanced past this branch's fork point.",
        );
      }
      // Only the paths parseDiff keeps: a whole-repo diff (a large docs or
      // lockfile change, or a damaged index that stages every file as
      // deleted) used to overflow the buffer with ENOBUFS.
      diffText = execFileSync(
        "git",
        [...GIT_NO_AUTO_GC, "diff", "-U0", diffBase, "--", "src", "frontend/src"],
        {
          cwd: root,
          encoding: "utf8",
          env: gitEnv(),
          maxBuffer: 256 * 1024 * 1024,
        },
      );
    } catch (err) {
      console.error(`ERROR: Failed to diff against ${baseRef}:`, err.message);
      return { ok: false, overallPercent: 0, error: "diff-failed" };
    }
    // Its own try: a failure here is a skipped sanity check, not a diff failure.
    try {
      baseSourceFiles = execFileSync(
        "git",
        ["ls-tree", "-r", "-z", "--name-only", diffBase, "--", "src", "frontend/src"],
        { cwd: root, encoding: "utf8", env: gitEnv(), maxBuffer: 64 * 1024 * 1024 },
      )
        .split("\0")
        .filter(Boolean);
    } catch (err) {
      console.warn(
        `WARNING: could not list ${diffBase}'s source tree (git ls-tree), so the ` +
          `damaged-index check is skipped: ${err.message}`,
      );
    }
  }

  const modifiedFiles = parseGitDiffHunks(diffText);
  if (modifiedFiles.size === 0) {
    const deleted = deletedFiles(diffText);
    const deletedSet = new Set(deleted);
    const baseSources = baseSourceFiles.filter(isSourceFile);
    if (baseSources.length > 0 && baseSources.every((f) => deletedSet.has(f))) {
      console.error(
        `ERROR: the patch deletes every source file (${baseSources.length}), which means the ` +
          "git index is damaged, not that the code is gone. Check `git status`; `git reset` " +
          "restores the index from HEAD without touching your working tree.",
      );
      return { ok: false, overallPercent: 0, error: "index-damaged" };
    }
    if (deleted.length > 0)
      console.warn(
        `WARNING: the patch only deletes ${deleted.length} source file(s) (e.g. ${deleted[0]}). ` +
          "If that's unexpected, the index may be damaged (every file staged as deleted): " +
          "check `git status`, and `git reset` restores it from HEAD.",
      );
    console.log("No source changes found in patch. Patch coverage: 100.0% (0/0 lines).");
    return { ok: true, overallPercent: 100 };
  }

  let coverageData = loadCoverageReports();
  if (!options.noRun) {
    const hasBackend = Array.from(modifiedFiles.keys()).some((f) => f.startsWith("src/"));
    const hasFrontend = Array.from(modifiedFiles.keys()).some((f) => f.startsWith("frontend/src/"));

    const hasBackendCoverage = Object.keys(coverageData).some(
      (k) => k.startsWith("src/") && !k.startsWith("frontend/"),
    );
    const hasFrontendCoverage = Object.keys(coverageData).some((k) =>
      k.startsWith("frontend/src/"),
    );

    const needBackend = hasBackend && !hasBackendCoverage;
    const needFrontend = hasFrontend && !hasFrontendCoverage;

    if (needBackend || needFrontend) {
      console.log(
        "Missing coverage report for modified areas. Running tests with coverage first...",
      );
      if (needBackend) {
        try {
          execFileSync("npm", ["run", "test:coverage"], { cwd: root, stdio: "inherit" });
        } catch (err) {
          console.error("ERROR: Failed to run backend tests with coverage:", err.message);
          return { ok: false, overallPercent: 0, error: "coverage-run-failed" };
        }
      }
      if (needFrontend) {
        try {
          execFileSync("npm", ["--prefix", "frontend", "run", "test:coverage"], {
            cwd: root,
            stdio: "inherit",
          });
        } catch (err) {
          console.error("ERROR: Failed to run frontend tests with coverage:", err.message);
          return { ok: false, overallPercent: 0, error: "coverage-run-failed" };
        }
      }
      coverageData = loadCoverageReports();
    }
  }

  const summary = evaluatePatchCoverage(modifiedFiles, coverageData);

  console.log(`\nPatch Coverage Report (against ${baseRef}):`);
  console.log("----------------------------------------------------------------------");
  for (const r of summary.results) {
    if (r.totalExecutable === 0) {
      console.log(`  ${r.file.padEnd(50)} 100.0% (0/0 executable lines)`);
    } else {
      const pctStr = `${r.coveragePercent.toFixed(1)}%`.padStart(6);
      const counts = `(${r.covered}/${r.totalExecutable} lines)`;
      const uncovered =
        r.uncoveredLines.length > 0 ? `Uncovered: ${r.uncoveredLines.join(", ")}` : "";
      console.log(`  ${r.file.padEnd(45)} ${pctStr} ${counts.padEnd(14)} ${uncovered}`);
    }
  }
  console.log("----------------------------------------------------------------------");
  console.log(
    `Overall Patch Coverage: ${summary.overallPercent.toFixed(1)}% ` +
      `(${summary.totalCoveredLines}/${summary.totalExecutableLines} lines, threshold: ${threshold.toFixed(1)}%)\n`,
  );

  const ok = summary.overallPercent >= threshold;
  return { ok, ...summary };
}

// Direct execution
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

export function cli(args = process.argv.slice(2), testOptions = {}) {
  let threshold = 75.0;
  let baseRef = undefined;
  let noRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--threshold" && args[i + 1]) {
      threshold = parseFloat(args[i + 1]);
      i++;
    } else if (args[i] === "--base" && args[i + 1]) {
      baseRef = args[i + 1];
      i++;
    } else if (args[i] === "--no-run") {
      noRun = true;
    }
  }

  const res = runPatchCoverageCheck({ threshold, baseRef, noRun, ...testOptions });
  if (!res.ok) {
    console.error(
      `ERROR: Patch coverage ${res.overallPercent.toFixed(1)}% is below required ${threshold.toFixed(1)}% threshold.`,
    );
    return 1;
  }
  return 0;
}

if (isMain) {
  process.exit(cli());
}
