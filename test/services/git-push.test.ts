import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { pushBranch } from "../../src/services/git-push.js";
import { gitEnv } from "../../src/services/git-env.js";

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() }).toString();
}

const TOKEN = "ghp_test_secret_token_do_not_leak_1234567890"; // pragma: allowlist secret

describe("git-push", () => {
  let bareRemote: string;
  let workdir: string;

  beforeEach(() => {
    bareRemote = fs.mkdtempSync(path.join(os.tmpdir(), "git-push-test-remote-"));
    git(bareRemote, ["init", "--bare", "-b", "main"]);

    workdir = fs.mkdtempSync(path.join(os.tmpdir(), "git-push-test-work-"));
    git(workdir, ["init", "-b", "main"]);
    git(workdir, ["config", "user.email", "test@example.com"]);
    git(workdir, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(workdir, "a.txt"), "a");
    git(workdir, ["add", "-A"]);
    git(workdir, ["commit", "-m", "initial", "--no-verify"]);
    git(workdir, ["remote", "add", "origin", bareRemote]);
  });

  afterEach(() => {
    fs.rmSync(bareRemote, { recursive: true, force: true });
    fs.rmSync(workdir, { recursive: true, force: true });
  });

  it("pushes a branch and sets upstream tracking", async () => {
    git(workdir, ["checkout", "-b", "mullion/task-1"]);
    fs.writeFileSync(path.join(workdir, "b.txt"), "b");
    git(workdir, ["add", "-A"]);
    git(workdir, ["commit", "-m", "second", "--no-verify"]);

    const result = await pushBranch(workdir, "mullion/task-1", TOKEN);

    expect(result).toEqual({ ok: true });
    // Landed in the bare "remote" — verified independently of pushBranch's
    // own return value.
    const branches = git(bareRemote, ["branch", "--list", "mullion/task-1"]);
    expect(branches).toContain("mullion/task-1");
    const upstream = git(workdir, [
      "rev-parse",
      "--abbrev-ref",
      "mullion/task-1@{upstream}",
    ]).trim();
    expect(upstream).toBe("origin/mullion/task-1");
  });

  it("is idempotent — pushing an already-pushed branch again still succeeds", async () => {
    git(workdir, ["checkout", "-b", "mullion/task-2"]);
    const first = await pushBranch(workdir, "mullion/task-2", TOKEN);
    expect(first.ok).toBe(true);

    const second = await pushBranch(workdir, "mullion/task-2", TOKEN);
    expect(second.ok).toBe(true);
  });

  it("fails cleanly for a branch that doesn't exist locally, with a redacted detail", async () => {
    const result = await pushBranch(workdir, "mullion/task-does-not-exist", TOKEN);

    expect(result.ok).toBe(false);
    expect(result.detail).toBeTruthy();
    expect(result.detail).not.toContain(TOKEN);
  });

  it("never leaks the token into the returned detail, even if it appears verbatim in git's own stderr", async () => {
    // A server-side pre-receive hook that echoes the token to stderr and
    // rejects the push — deterministically forces the exact failure mode
    // pushBranch's redact() exists to guard against, rather than relying
    // on git never happening to echo a credential back (which it usually
    // doesn't, making the guarantee hard to exercise honestly otherwise).
    const hookPath = path.join(bareRemote, "hooks", "pre-receive");
    fs.writeFileSync(hookPath, `#!/bin/sh\necho "leaked: ${TOKEN}" >&2\nexit 1\n`, { mode: 0o755 });

    git(workdir, ["checkout", "-b", "mullion/task-3"]);
    const result = await pushBranch(workdir, "mullion/task-3", TOKEN);

    expect(result.ok).toBe(false);
    expect(result.detail).toBeTruthy();
    expect(result.detail).not.toContain(TOKEN);
    expect(result.detail).toContain("[redacted]");
  });

  it("also redacts the base64-encoded http.extraHeader form of the credential, not just the raw token", async () => {
    // The encoded form is the same credential in a different shape — a
    // hook that leaks THIS instead of the raw token string is just as
    // real a leak (Hermes review, PR #475).
    const encoded = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");
    const hookPath = path.join(bareRemote, "hooks", "pre-receive");
    fs.writeFileSync(hookPath, `#!/bin/sh\necho "leaked: ${encoded}" >&2\nexit 1\n`, {
      mode: 0o755,
    });

    git(workdir, ["checkout", "-b", "mullion/task-4"]);
    const result = await pushBranch(workdir, "mullion/task-4", TOKEN);

    expect(result.ok).toBe(false);
    expect(result.detail).not.toContain(encoded);
    expect(result.detail).toContain("[redacted]");
  });
});
