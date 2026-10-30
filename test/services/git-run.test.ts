import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { gitEnv } from "../../src/services/git-env.js";
import { redact, runGitCommand } from "../../src/services/git-run.js";

describe("git-run", () => {
  it("redact strips every secret and ignores empty ones", () => {
    expect(redact("a SECRET b ENC c", "SECRET", "ENC", "")).toBe("a [redacted] b [redacted] c");
  });

  it("redacts the token from a failing command's output", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-run-test-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir, env: gitEnv() });
      // `git checkout <unknown>` echoes its argument in the error.
      const r = await runGitCommand(dir, ["checkout", "tok123"], "H: x", "tok123", "enc", 10_000);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.detail).toContain("[redacted]");
        expect(r.detail).not.toContain("tok123");
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs without an auth header when headerValue is null", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-run-test-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir, env: gitEnv() });
      const r = await runGitCommand(
        dir,
        ["config", "--get", "http.extraHeader"],
        null,
        "",
        "",
        10_000,
      );
      expect(r.ok).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
