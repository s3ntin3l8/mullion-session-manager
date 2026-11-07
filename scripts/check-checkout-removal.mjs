#!/usr/bin/env node
// Guard for issue #2700: every project worktree removal goes through
// src/services/checkout-removal.ts, which also closes the checkout's browsers
// and deletes their stored state. A use of one of the low-level remove
// operations anywhere else in src/ leaks both, so it fails here and names the
// file and line.
//
// This reads the TypeScript syntax tree, not lines of text, so it also catches
// what a regex cannot: an aliased import (`import { removeWorktree as rw }`), a
// destructured or bracket-accessed method (`const { removeWorktree } = b`,
// `b["removeWorktree"]()`) and a bare reference (`run(b.removeWorktree)`).
//
// The allowlist names a file, or a function inside it (`file#function`), and
// may cap how many uses that scope holds. A new caller added to a file that
// legitimately implements removal (git-worktree.ts, the backends, the agent
// routes) is therefore still found.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The low-level operations (git-worktree.ts exports, SessionBackend methods).
// `cleanupPreviewWorktree` is not here: it removes through the tracked info's
// required `remove` closure (session-lifecycle's previewRemover), so it cannot
// bypass the helper.
export const NAMES = new Set([
  "removeWorktreeIfClean",
  "removeWorktree",
  "removeListedWorktree",
  "pruneWorktrees",
  "clearOrphanedTaskWorktree",
]);

// Scopes that may use them, and why. `scope` is `file` or `file#function`; a
// function matches a class's methods too (`LocalBackend` covers
// `LocalBackend.removeWorktree`) and `import` is the file's import list.
// `count` pins the number of uses inside the scope EXACTLY: a new call there is
// found, and so is a deleted one (a stale entry would silently leave headroom).
export const ALLOWLIST = [
  { scope: "src/services/checkout-removal.ts", why: "the helper itself" },
  {
    scope: "src/services/git-worktree.ts#removeWorktree",
    why: "the local implementation: `git worktree remove`",
  },
  { scope: "src/services/git-worktree.ts#removeWorktreeIfClean", why: "the local implementation" },
  { scope: "src/services/git-worktree.ts#removeListedWorktree", why: "the local implementation" },
  {
    scope: "src/services/git-worktree.ts#clearOrphanedTaskWorktree",
    why: "the local implementation",
  },
  { scope: "src/services/git-worktree.ts#pruneWorktrees", why: "the local implementation" },
  { scope: "src/services/session-backend.ts#import", why: "the backends' imports" },
  { scope: "src/services/session-backend.ts#interface SessionBackend", why: "the seam" },
  { scope: "src/services/session-backend.ts#LocalBackend", why: "the local backend" },
  { scope: "src/services/session-backend.ts#RemoteBackend", why: "the remote backend" },
  { scope: "src/routes/internal.ts#import", why: "the agent endpoints' imports" },
  {
    scope: "src/routes/internal.ts#internalRoutes",
    why: "the five agent-side endpoints the remote backend calls",
    count: 5,
  },
  { scope: "src/hooks/worktree-hook.mjs", why: "a hook's own throwaway worktree, not a checkout" },
  {
    scope: "src/services/scaffold-generate.ts",
    why: "a scratch worktree of a generated scaffold, no project",
  },
];

function collect(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (/\.(ts|mjs|js)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

// The names of the functions, methods and interfaces a node sits inside.
function containers(node) {
  const out = [];
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isImportDeclaration(n)) out.push("import");
    else if (ts.isFunctionDeclaration(n) && n.name) out.push(n.name.text);
    else if (ts.isMethodDeclaration(n) && n.name) {
      const cls = ts.isClassLike(n.parent) && n.parent.name ? `${n.parent.name.text}.` : "";
      out.push(`${cls}${n.name.getText()}`);
    } else if (
      (ts.isVariableDeclaration(n) || ts.isPropertyAssignment(n)) &&
      n.initializer &&
      (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
    ) {
      out.push(n.name.getText());
    } else if (ts.isInterfaceDeclaration(n)) out.push(`interface ${n.name.text}`);
  }
  return out;
}

/**
 * Every use of a low-level removal operation in one file that its allowlist
 * does not cover. `allowlist` defaults to ALLOWLIST (tests pass their own).
 */
export function scanForBypass(relPath, content, allowlist = ALLOWLIST) {
  const wholeFile = allowlist.some((a) => a.scope === relPath);
  if (wholeFile) return [];
  const scoped = allowlist
    .filter((a) => a.scope.startsWith(`${relPath}#`))
    .map((a) => ({ fn: a.scope.slice(relPath.length + 1), count: a.count }));
  const sf = ts.createSourceFile(relPath, content, ts.ScriptTarget.Latest, true);
  const findings = [];
  const counts = new Map();
  const at = (node, text) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    return { file: relPath, line: line + 1, text };
  };
  const covered = (node) => {
    const chain = containers(node);
    for (const s of scoped) {
      if (chain.some((c) => c === s.fn || c.startsWith(`${s.fn}.`))) {
        if (s.count === undefined) return true;
        const n = (counts.get(s.fn) ?? 0) + 1;
        counts.set(s.fn, n);
        return n <= s.count;
      }
    }
    return false;
  };
  const visit = (node) => {
    // A name used as an identifier: a call, a bare reference, a destructured
    // property, an import (an alias keeps the original name as `propertyName`).
    if (ts.isIdentifier(node) && NAMES.has(node.text) && !covered(node)) {
      findings.push(at(node, node.parent.getText(sf).split("\n")[0].trim()));
    }
    // `backend["removeWorktree"]`: the name as a string.
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      NAMES.has(node.text) &&
      !covered(node)
    ) {
      findings.push(at(node, node.parent.getText(sf).split("\n")[0].trim()));
    }
    // `git worktree remove` as argv (`["worktree", "remove", ...]`) or as text.
    if (ts.isArrayLiteralExpression(node)) {
      const lits = node.elements.map((e) => (ts.isStringLiteralLike(e) ? e.text : null));
      for (let i = 0; i + 1 < lits.length; i += 1) {
        if (lits[i] === "worktree" && lits[i + 1] === "remove" && !covered(node)) {
          findings.push(at(node, node.getText(sf).split("\n")[0].trim()));
        }
      }
    }
    // A template with `${}` holes keeps its text in the head and spans.
    const literalText = ts.isStringLiteralLike(node)
      ? node.text
      : ts.isTemplateExpression(node)
        ? node.head.text + node.templateSpans.map((span) => span.literal.text).join("")
        : null;
    if (literalText !== null && literalText.includes("git worktree remove") && !covered(node)) {
      findings.push(at(node, node.getText(sf).split("\n")[0].trim()));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  // A pinned scope that now holds FEWER uses than its entry says is stale.
  for (const s of scoped) {
    const n = counts.get(s.fn) ?? 0;
    if (s.count !== undefined && n < s.count) {
      findings.push({
        file: relPath,
        line: 1,
        text: `${relPath}#${s.fn} now holds ${n} uses, its allowlist entry says ${s.count}: lower \`count\` in scripts/check-checkout-removal.mjs`,
      });
    }
  }
  return findings;
}

/** The repo-wide scan, as `[{file, line, text}]`; empty when nothing bypasses. */
export function scanRepo(allowlist = ALLOWLIST) {
  return collect(path.join(root, "src")).flatMap((file) =>
    scanForBypass(
      path.relative(root, file).split(path.sep).join("/"),
      readFileSync(file, "utf8"),
      allowlist,
    ),
  );
}

function main() {
  const findings = scanRepo();
  if (findings.length === 0) return;
  console.error(
    "Worktree removal outside src/services/checkout-removal.ts (it must also close the checkout's browsers and delete their storage, issue #2700):",
  );
  for (const f of findings) console.error(`  ${f.file}:${f.line}: ${f.text}`);
  console.error(
    "Use removeCheckoutIfClean / removeCheckoutForced / removeListedCheckout / pruneCheckouts / clearOrphanedCheckout, or add the file (or file#function) to ALLOWLIST in scripts/check-checkout-removal.mjs with a reason.",
  );
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
