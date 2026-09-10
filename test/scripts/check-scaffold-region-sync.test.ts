// Issue #942 — the precedence-matching check (#716) this script used to run
// was retired along with the file-scanning "committed briefing" mechanism:
// AGENTS.md is now the single source of truth, so there's nothing left to
// compare it against. This exercises the REPURPOSED script via execFile
// (precedent: test/scripts/self-update.test.ts), against per-test fixture
// directories, using the script's SCAFFOLD_REGION_SYNC_ROOT override so it
// never touches this repo's own AGENTS.md/CLAUDE.md — it now guards a
// narrower invariant: none of CLAUDE.md, GEMINI.md, or AGENTS.override.md
// may re-acquire a content-bearing copy of the old `mullion:briefing`
// region. Issue #1215 — renamed from check-briefing-sync.test.ts; the
// marker literals below are unchanged (see SCAFFOLD_REGION_START's own doc
// comment in mullion-scaffold.ts for why the wire format is frozen).
//
// One case deliberately does NOT set SCAFFOLD_REGION_SYNC_ROOT: without it,
// the script falls back to the real repo root, which is the only path
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

const SCRIPT = fileURLToPath(
  new URL("../../scripts/check-scaffold-region-sync.mjs", import.meta.url),
);

const START = "<!-- mullion:briefing:start -->";
const END = "<!-- mullion:briefing:end -->";

function withRegion(label: string): string {
  return `# ${label}\n\nSome preamble.\n\n${START}\n\nsome briefing text\n\n${END}\n`;
}

function runScript(root?: string) {
  // Explicitly clear SCAFFOLD_REGION_SYNC_ROOT rather than passing bare
  // `process.env` when `root` is omitted — an ambient
  // SCAFFOLD_REGION_SYNC_ROOT leaked into this process's env (e.g. from a
  // shell export) would otherwise silently redirect the "unset" case to a
  // fixture too, defeating the one test that's supposed to exercise the
  // real default-root fallback.
  const env = { ...process.env };
  if (root) {
    env.SCAFFOLD_REGION_SYNC_ROOT = root;
  } else {
    delete env.SCAFFOLD_REGION_SYNC_ROOT;
  }
  return execFileAsync("node", [SCRIPT], { env });
}

describe("scripts/check-scaffold-region-sync.mjs", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "scaffold-region-sync-test-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("passes when none of CLAUDE.md, GEMINI.md, or AGENTS.override.md exist", async () => {
    fs.writeFileSync(path.join(root, "AGENTS.md"), withRegion("AGENTS.md"));

    const { stdout } = await runScript(root);

    expect(stdout).toContain("OK — no content-bearing scaffold-region mirror or override found.");
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

  it("passes when CLAUDE.md carries only an @AGENTS.md import, no mullion:briefing region", async () => {
    fs.writeFileSync(path.join(root, "AGENTS.md"), withRegion("AGENTS.md"));
    fs.writeFileSync(
      path.join(root, "CLAUDE.md"),
      "# CLAUDE.md\n\n<!-- mullion:pointer:start -->\n@AGENTS.md\n<!-- mullion:pointer:end -->\n",
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

  it("fails when CLAUDE.md carries a content-bearing mullion:briefing region", async () => {
    fs.writeFileSync(path.join(root, "AGENTS.md"), withRegion("AGENTS.md"));
    fs.writeFileSync(path.join(root, "CLAUDE.md"), withRegion("CLAUDE.md"));

    const error = await runScript(root).catch((e) => e);

    expect(error).toBeTruthy();
    expect(error.code).toBe(1);
    expect(error.stdout).toContain("CLAUDE.md carries its own");
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

  it("reports all three files independently when all three re-acquire a region", async () => {
    fs.writeFileSync(path.join(root, "AGENTS.md"), withRegion("AGENTS.md"));
    fs.writeFileSync(path.join(root, "CLAUDE.md"), withRegion("CLAUDE.md"));
    fs.writeFileSync(path.join(root, "GEMINI.md"), withRegion("GEMINI.md"));
    fs.writeFileSync(path.join(root, "AGENTS.override.md"), withRegion("AGENTS.override.md"));

    const error = await runScript(root).catch((e) => e);

    expect(error).toBeTruthy();
    expect(error.code).toBe(1);
    expect(error.stdout).toContain("CLAUDE.md carries its own");
    expect(error.stdout).toContain("GEMINI.md carries its own");
    expect(error.stdout).toContain("AGENTS.override.md carries its own");
  });

  it("passes against the real repo root when SCAFFOLD_REGION_SYNC_ROOT is unset", async () => {
    // This is the path `npm run lint` and the pre-commit hook actually take
    // in production — every other test in this file overrides the root, so
    // without this one the default-root fallback would never run at all.
    const { stdout } = await runScript();

    expect(stdout).toContain("OK —");
  });
});
