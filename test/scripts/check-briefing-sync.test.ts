// Issue #942 — the precedence-matching check (#716) this script used to run
// was retired along with the file-scanning "committed briefing" mechanism:
// AGENTS.md is now the single source of truth, so there's nothing left to
// compare it against. This exercises the REPURPOSED script via execFile
// (precedent: test/scripts/self-update.test.ts), against per-test fixture
// directories, using the script's BRIEFING_SYNC_ROOT override so it never
// touches this repo's own AGENTS.md/GEMINI.md — it now guards a narrower
// invariant: neither GEMINI.md nor AGENTS.override.md may re-acquire a
// content-bearing copy of the old `mullion:briefing` region.
//
// One case deliberately does NOT set BRIEFING_SYNC_ROOT: without it, the
// script falls back to the real repo root, which is the only path
// `npm run lint` and the pre-commit hook ever take in production. Every
// other case here injects the env var, so that fallback would otherwise go
// completely unexercised.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const SCRIPT = fileURLToPath(new URL("../../scripts/check-briefing-sync.mjs", import.meta.url));

const START = "<!-- mullion:briefing:start -->";
const END = "<!-- mullion:briefing:end -->";

function withRegion(label: string): string {
  return `# ${label}\n\nSome preamble.\n\n${START}\n\nsome briefing text\n\n${END}\n`;
}

function runScript(root?: string) {
  // Explicitly clear BRIEFING_SYNC_ROOT rather than passing bare
  // `process.env` when `root` is omitted — an ambient BRIEFING_SYNC_ROOT
  // leaked into this process's env (e.g. from a shell export) would
  // otherwise silently redirect the "unset" case to a fixture too, defeating
  // the one test that's supposed to exercise the real default-root fallback.
  const env = { ...process.env };
  if (root) {
    env.BRIEFING_SYNC_ROOT = root;
  } else {
    delete env.BRIEFING_SYNC_ROOT;
  }
  return execFileAsync("node", [SCRIPT], { env });
}

describe("scripts/check-briefing-sync.mjs", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "briefing-sync-test-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("passes when neither GEMINI.md nor AGENTS.override.md exist", async () => {
    fs.writeFileSync(path.join(root, "AGENTS.md"), withRegion("AGENTS.md"));

    const { stdout } = await runScript(root);

    expect(stdout).toContain("OK — no content-bearing briefing mirror or override found.");
  });

  it("passes when GEMINI.md exists but only carries a plain pointer, no mullion:briefing region", async () => {
    fs.writeFileSync(path.join(root, "AGENTS.md"), withRegion("AGENTS.md"));
    fs.writeFileSync(
      path.join(root, "GEMINI.md"),
      "# GEMINI.md\n\n<!-- mullion:pointer:start -->\nRead `AGENTS.md`.\n<!-- mullion:pointer:end -->\n",
    );

    const { stdout } = await runScript(root);

    expect(stdout).toContain("OK");
  });

  it("fails when GEMINI.md re-acquires a content-bearing mullion:briefing region", async () => {
    fs.writeFileSync(path.join(root, "AGENTS.md"), withRegion("AGENTS.md"));
    fs.writeFileSync(path.join(root, "GEMINI.md"), withRegion("GEMINI.md"));

    const error = await runScript(root).catch((e) => e);

    expect(error).toBeTruthy();
    expect(error.code).toBe(1);
    expect(error.stdout).toContain("GEMINI.md carries its own");
    expect(error.stdout).toContain("single source of truth");
  });

  it("fails when AGENTS.override.md carries a content-bearing mullion:briefing region", async () => {
    fs.writeFileSync(path.join(root, "AGENTS.md"), withRegion("AGENTS.md"));
    fs.writeFileSync(path.join(root, "AGENTS.override.md"), withRegion("AGENTS.override.md"));

    const error = await runScript(root).catch((e) => e);

    expect(error).toBeTruthy();
    expect(error.code).toBe(1);
    expect(error.stdout).toContain("AGENTS.override.md carries its own");
  });

  it("reports both files independently when both re-acquire a region", async () => {
    fs.writeFileSync(path.join(root, "AGENTS.md"), withRegion("AGENTS.md"));
    fs.writeFileSync(path.join(root, "GEMINI.md"), withRegion("GEMINI.md"));
    fs.writeFileSync(path.join(root, "AGENTS.override.md"), withRegion("AGENTS.override.md"));

    const error = await runScript(root).catch((e) => e);

    expect(error).toBeTruthy();
    expect(error.code).toBe(1);
    expect(error.stdout).toContain("GEMINI.md carries its own");
    expect(error.stdout).toContain("AGENTS.override.md carries its own");
  });

  it("passes against the real repo root when BRIEFING_SYNC_ROOT is unset", async () => {
    // This is the path `npm run lint` and the pre-commit hook actually take
    // in production — every other test in this file overrides the root, so
    // without this one the default-root fallback would never run at all.
    const { stdout } = await runScript();

    expect(stdout).toContain("OK —");
  });
});
