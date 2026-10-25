#!/usr/bin/env node
// Every trigger names what it opens (issue #1894).
//
// `aria-haspopup="true"` is the generic "this opens something" value, and
// the ARIA spec maps it to `menu`. NotificationBell's trigger carried it
// while what the trigger opens is the notifications panel — `role="dialog"`
// on the desktop, a `ui/BottomSheet.tsx` (itself `role="dialog"`) on the
// phone — so assistive technology was told it opens a menu.
//
// Every other trigger in this app already names what it opens: "menu"
// (`ui/KebabMenu.tsx`, `PaneActionsMenu.tsx`), "listbox"
// (`ui/CustomSelect.tsx`, the palette's target chip), "dialog"
// (`ui/Modal.tsx`, `ui/BottomSheet.tsx`, `MobileSessionSwitcher.tsx`,
// `unified-board/TasksToolbar.tsx`). This script keeps it that way: it
// fails if `aria-haspopup="true"` appears anywhere in `frontend/src`.
//
// It lives here rather than in a vitest file for one concrete reason: this
// guard asserts a property of the WHOLE frontend source tree, in one pass,
// and the repo's precedent for a whole-tree source assertion is the
// `scripts/check-*` family wired into `npm run lint` — `check-case-collision`
// and `check-security-antipatterns` walk the tree the same way.
//
// A frontend test CAN read source text — `import.meta.glob(..., { query:
// "?raw" })` is how `src/ui/primitives.a11y.test.tsx`,
// `src/ui/Modal.migration.test.tsx` and `src/pwaSplashScreens.test.ts` do
// it, and the reason `node:fs` is not used there is that the frontend's
// tsconfig deliberately omits Node's global types. Those tests all scan a
// subtree or a single directory; this one is about every file in
// `frontend/src`, so it is a lint-time tree walk.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "frontend", "src");

const fail = (message) => {
  console.error(`FAIL — ${message}`);
  process.exit(1);
};

function collectSourceFiles(dir, fileList = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "dist" && entry.name !== ".git") {
        collectSourceFiles(fullPath, fileList);
      }
    } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

// The attribute with the generic value, in every spelling React accepts:
// `aria-haspopup="true"`, `aria-haspopup={'true'}`, `aria-haspopup={"true"}`
// and `aria-haspopup={true}` (React renders a boolean aria-* value as the
// string "true"). The value may sit on its own line — the braces are a JSX
// expression container, so `aria-haspopup={` and `"true"` can be split by a
// newline — and the lookahead keeps `aria-haspopup="trueish"` (not a token
// ARIA knows) out of the net.
const GENERIC = /aria-haspopup\s*=\s*\{?\s*(?:['"]true['"]|true(?=\s*\}))\s*\}?/g;

// A comment is prose, not an attribute — and this repo's own comments quote
// the attribute they are talking about, so reading comments would fail on
// the explanation.
const stripComments = (content) =>
  content.replace(
    /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\/\*[\s\S]*?\*\/|\/\/[^\r\n]*)/g,
    (match, _str, comment) => (comment ? match.replace(/[^\r\n]/g, " ") : match),
  );

const offenders = [];
for (const file of collectSourceFiles(SRC)) {
  const content = stripComments(readFileSync(file, "utf8"));
  const lines = content.split("\n");
  GENERIC.lastIndex = 0;
  let match;
  while ((match = GENERIC.exec(content)) !== null) {
    const lineNumber = content.slice(0, match.index).split("\n").length;
    offenders.push(
      `${path.relative(ROOT, file)}:${lineNumber}: ${(lines[lineNumber - 1] ?? "").trim()}`,
    );
  }
}

if (offenders.length > 0) {
  fail(
    'a trigger declares aria-haspopup="true", which the ARIA spec maps to "menu":\n' +
      offenders.map((o) => `  ${o}`).join("\n") +
      '\n  Name what the trigger opens instead — "menu", "listbox", "dialog", ' +
      '"grid", "tree" — as every other trigger in this app already does (issue #1894).',
  );
}

console.log("OK — every aria-haspopup in frontend/src names what its trigger opens.");
