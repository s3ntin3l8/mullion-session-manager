// Issue #716 — scripts/check-briefing-sync.mjs previously only compared
// AGENTS.md against GEMINI.md; it had no awareness of AGENTS.override.md,
// the file Codex reads *instead of* AGENTS.md whenever it exists (see
// src/services/agent-rules.ts's precedence table). This exercises the REAL
// script via execFile (precedent: test/scripts/self-update.test.ts), against
// per-test fixture directories, using the script's BRIEFING_SYNC_ROOT
// override so it never touches this repo's own AGENTS.md/GEMINI.md.
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
const REGION = "- **Work in a worktree.** Some rule text.";

function agentsMd(region = REGION): string {
  return `# AGENTS.md\n\nSome preamble.\n\n${START}\n\n${region}\n\n${END}\n`;
}

function geminiMd(region = REGION): string {
  return `# GEMINI.md\n\nSome preamble.\n\n${START}\n\n${region}\n\n${END}\n`;
}

function runScript(root?: string) {
  return execFileAsync("node", [SCRIPT], {
    env: root ? { ...process.env, BRIEFING_SYNC_ROOT: root } : process.env,
  });
}

describe("scripts/check-briefing-sync.mjs", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "briefing-sync-test-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("passes when AGENTS.md and GEMINI.md are in sync and no override exists", async () => {
    fs.writeFileSync(path.join(root, "AGENTS.md"), agentsMd());
    fs.writeFileSync(path.join(root, "GEMINI.md"), geminiMd());

    const { stdout } = await runScript(root);

    expect(stdout).toContain("OK — AGENTS.md, GEMINI.md carry identical briefing regions.");
  });

  it("passes when AGENTS.override.md exists and is in sync", async () => {
    fs.writeFileSync(path.join(root, "AGENTS.md"), agentsMd());
    fs.writeFileSync(path.join(root, "GEMINI.md"), geminiMd());
    fs.writeFileSync(path.join(root, "AGENTS.override.md"), agentsMd());

    const { stdout } = await runScript(root);

    expect(stdout).toContain(
      "OK — AGENTS.md, GEMINI.md, AGENTS.override.md carry identical briefing regions.",
    );
  });

  it("fails when AGENTS.override.md's region has drifted from AGENTS.md's", async () => {
    fs.writeFileSync(path.join(root, "AGENTS.md"), agentsMd());
    fs.writeFileSync(path.join(root, "GEMINI.md"), geminiMd());
    fs.writeFileSync(
      path.join(root, "AGENTS.override.md"),
      agentsMd("- **Work in a worktree.** Drifted, different text."),
    );

    const error = await runScript(root).catch((e) => e);

    expect(error).toBeTruthy();
    expect(error.code).toBe(1);
    expect(error.stdout).toContain(
      "AGENTS.override.md's briefing region does not match AGENTS.md's",
    );
  });

  it("fails with a distinct message when AGENTS.override.md has no marker region at all", async () => {
    fs.writeFileSync(path.join(root, "AGENTS.md"), agentsMd());
    fs.writeFileSync(path.join(root, "GEMINI.md"), geminiMd());
    fs.writeFileSync(
      path.join(root, "AGENTS.override.md"),
      "# AGENTS.override.md\n\nNo marker region here at all.\n",
    );

    const error = await runScript(root).catch((e) => e);

    expect(error).toBeTruthy();
    expect(error.code).toBe(1);
    expect(error.stdout).toContain("AGENTS.override.md has no");
    expect(error.stdout).toContain("shadows AGENTS.md for Codex");
    // Distinct from the drift-message case above.
    expect(error.stdout).not.toContain("does not match");
  });

  it("fails when GEMINI.md's region has drifted from AGENTS.md's (regression guard)", async () => {
    fs.writeFileSync(path.join(root, "AGENTS.md"), agentsMd());
    fs.writeFileSync(
      path.join(root, "GEMINI.md"),
      geminiMd("- **Work in a worktree.** Drifted, different text."),
    );

    const error = await runScript(root).catch((e) => e);

    expect(error).toBeTruthy();
    expect(error.code).toBe(1);
    expect(error.stdout).toContain("GEMINI.md's briefing region does not match AGENTS.md's");
  });

  it("passes against the real repo root when BRIEFING_SYNC_ROOT is unset", async () => {
    // This is the path `npm run lint` and the pre-commit hook actually take
    // in production — every other test in this file overrides the root, so
    // without this one the default-root fallback would never run at all.
    const { stdout } = await runScript();

    expect(stdout).toContain("OK —");
  });
});
