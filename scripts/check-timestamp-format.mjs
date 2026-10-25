#!/usr/bin/env node
// The app renders times through the shared formatter (issue #1890).
//
// `frontend/src/relativeTime.ts` holds `formatRelativeAge` — the app's one
// way of saying when something happened ("3m ago", "2h ago"). The review
// relay's Settings section was the one surface that did not use it: it
// rendered `new Date(run.dispatchedAt).toLocaleTimeString()`, so a screen
// that showed a review run's age next to anything else from the app showed
// two different ways of saying the same thing.
//
// This script keeps the convention: it fails if a locale-dependent DATE or
// TIME format appears anywhere in the frontend.
//
//   `.toLocaleTimeString()` and `.toLocaleDateString()` are the two that
//   unambiguously format a date. `.toLocaleString()` is NOT covered: it is
//   also how the app formats plain numbers (a byte count, say), and a text
//   scan cannot tell those apart — a Date's `.toLocaleString()` is the
//   hazard the other two names cover.
//
// The shared time module itself is exempt, so an absolute timestamp (a real
// deadline, say) can be added there and used from the surfaces that need it,
// rather than being spelled out inline at each call site.
//
// It lives here rather than in a vitest file for one concrete reason: the
// frontend's test tree has no node types (the frontend tsconfig does not
// include them), so a test cannot read the source tree's files at all. This
// repo's own precedent for "assert something about the source tree's
// contents" is a `scripts/check-*` node script wired into `npm run lint`
// (see check-token-contrast.mjs, check-phone-palette.mjs and
// check-aria-haspopup.mjs, whose header comments say the same thing).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "frontend", "src");

// The shared time module — where an absolute formatter belongs, and the one
// file allowed to reach for the locale-dependent API.
const SHARED_TIME_MODULE = path.join(SRC, "relativeTime.ts");

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

// A comment is prose, not a call — and this repo's own comments quote the
// call they are talking about, so reading comments would fail on the
// explanation.
const stripComments = (content) =>
  content.replace(
    /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\/\*[\s\S]*?\*\/|\/\/[^\r\n]*)/g,
    (match, _str, comment) => (comment ? match.replace(/[^\r\n]/g, " ") : match),
  );

const RAW_DATE_FORMAT = /\.toLocale(?:Time|Date)String\s*\(/g;

const offenders = [];
for (const file of collectSourceFiles(SRC)) {
  if (file === SHARED_TIME_MODULE) continue;
  const content = stripComments(readFileSync(file, "utf8"));
  content.split("\n").forEach((line, i) => {
    RAW_DATE_FORMAT.lastIndex = 0;
    if (!RAW_DATE_FORMAT.test(line)) return;
    offenders.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
  });
}

if (offenders.length > 0) {
  fail(
    "a timestamp is rendered with the locale-dependent Date API:\n" +
      offenders.map((o) => `  ${o}`).join("\n") +
      "\n  Render times through the shared formatter instead — " +
      "formatRelativeAge(epochMs) from frontend/src/relativeTime.ts — so every " +
      "surface says when something happened the same way (issue #1890).\n" +
      "  If you need an ABSOLUTE time (a deadline, say), add a shared formatter " +
      "next to formatRelativeAge in frontend/src/relativeTime.ts and use it from " +
      "there; do not spell the format out at the call site.",
  );
}

console.log("OK — every timestamp is rendered through the shared formatter.");
