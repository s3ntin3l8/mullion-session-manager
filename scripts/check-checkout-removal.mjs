#!/usr/bin/env node
// Guard for issue #2700: every project worktree removal goes through
// src/services/checkout-removal.ts, which also closes the checkout's browsers
// and deletes their stored state. A call to one of the low-level remove
// operations anywhere else in src/ leaks both, so it fails here and names the
// file.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The low-level operations (git-worktree.ts exports, SessionBackend methods).
const REMOVE_CALL =
  /\b(removeWorktreeIfClean|removeWorktree|removeListedWorktree|pruneWorktrees|clearOrphanedTaskWorktree)\s*\(/;
// `git worktree remove` spelled out as a shell/argv call.
const GIT_REMOVE = /["']worktree["']\s*,\s*["']remove["']|git worktree remove/;

// Files that may call them, and why.
export const ALLOWLIST = new Map([
  ["src/services/checkout-removal.ts", "the helper itself"],
  ["src/services/git-worktree.ts", "the local implementation (and its preview fallback)"],
  ["src/services/session-backend.ts", "the Local/Remote backend implementations"],
  ["src/routes/internal.ts", "the agent-side endpoints the remote backend calls"],
  ["src/hooks/worktree-hook.mjs", "a hook's own throwaway worktree, not a project checkout"],
  ["src/services/scaffold-generate.ts", "a scratch worktree of a generated scaffold, no project"],
]);

function collect(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (/\.(ts|mjs|js)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

// Blank comments but keep string literals (so "worktree", "remove" survives).
function stripComments(content) {
  return content.replace(
    /("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\/\*[\s\S]*?\*\/|\/\/[^\r\n]*)/g,
    (match, _str, comment) => (comment ? match.replace(/[^\r\n]/g, " ") : match),
  );
}

export function scanForBypass(relPath, content) {
  if (ALLOWLIST.has(relPath)) return [];
  const findings = [];
  stripComments(content)
    .split("\n")
    .forEach((line, i) => {
      if (REMOVE_CALL.test(line) || GIT_REMOVE.test(line)) {
        findings.push({ file: relPath, line: i + 1, text: line.trim() });
      }
    });
  return findings;
}

function main() {
  const findings = collect(path.join(root, "src")).flatMap((file) =>
    scanForBypass(path.relative(root, file).split(path.sep).join("/"), readFileSync(file, "utf8")),
  );
  if (findings.length === 0) return;
  console.error(
    "Worktree removal outside src/services/checkout-removal.ts (it must also close the checkout's browsers and delete their storage, issue #2700):",
  );
  for (const f of findings) console.error(`  ${f.file}:${f.line}: ${f.text}`);
  console.error(
    "Use removeCheckoutIfClean / removeCheckoutForced / removeListedCheckout / pruneCheckouts / clearOrphanedCheckout, or add the file to ALLOWLIST in scripts/check-checkout-removal.mjs with a reason.",
  );
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
