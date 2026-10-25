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
// fails if `aria-haspopup="true"` appears anywhere in the frontend.
//
// It lives here rather than in a vitest file for one concrete reason: the
// frontend's test tree has no node types (the frontend tsconfig does not
// include them), so a test cannot read the source tree's files at all. This
// repo's own precedent for "assert something about the source tree's
// contents" is a `scripts/check-*` node script wired into `npm run lint`
// (see check-token-contrast.mjs and check-phone-palette.mjs, whose header
// comments say the same thing).
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

// The attribute with the generic value, in either quoting style and with
// the optional JSX expression wrapper: `aria-haspopup="true"`,
// `aria-haspopup={'true'}`, `aria-haspopup={"true"}`.
const GENERIC = /aria-haspopup\s*=\s*(?:\{)?['"]true['"]/;

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
  lines.forEach((line, i) => {
    if (!GENERIC.test(line)) return;
    offenders.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
  });
}

if (offenders.length > 0) {
  fail(
    'a trigger declares aria-haspopup="true", which the ARIA spec maps to "menu":\n' +
      offenders.map((o) => `  ${o}`).join("\n") +
      '\n  Name what the trigger opens instead — "menu", "listbox", "dialog", ' +
      '"grid", "tree" — as every other trigger in this app already does (issue #1894).',
  );
}

console.log("OK — every aria-haspopup names what its trigger opens.");
