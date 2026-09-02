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

  it("skips the target repo's own local pre-push hook (--no-verify)", async () => {
    // A hook that would fail the push if it ran at all — a stronger, more
    // direct signal that --no-verify took effect than inspecting argv would
    // be, and it's exactly the failure mode observed in production (#722's
    // investigation): a repo's pre-push hook running unbounded work
    // synchronously inside the promotion push.
    const hookPath = path.join(workdir, ".git", "hooks", "pre-push");
    fs.writeFileSync(hookPath, `#!/bin/sh\necho "pre-push hook ran" >&2\nexit 1\n`, {
      mode: 0o755,
    });

    git(workdir, ["checkout", "-b", "mullion/task-5"]);
    const result = await pushBranch(workdir, "mullion/task-5", TOKEN);

    expect(result).toEqual({ ok: true });
    const branches = git(bareRemote, ["branch", "--list", "mullion/task-5"]);
    expect(branches).toContain("mullion/task-5");
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

  describe("force-with-lease for mullion/task-* branches (task 258971's investigation)", () => {
    it("delivers a rewritten commit (amend) that a plain push would reject", async () => {
      git(workdir, ["checkout", "-b", "mullion/task-6"]);
      const first = await pushBranch(workdir, "mullion/task-6", TOKEN);
      expect(first.ok).toBe(true);

      // Simulate a worker amending the commit it already ended a turn on —
      // this rewrites history on a branch Mullion already pushed.
      fs.writeFileSync(path.join(workdir, "amend.txt"), "amended");
      git(workdir, ["add", "-A"]);
      git(workdir, ["commit", "--amend", "-m", "amended", "--no-verify"]);

      const second = await pushBranch(workdir, "mullion/task-6", TOKEN);

      expect(second).toEqual({ ok: true });
      const log = git(bareRemote, ["log", "-1", "--format=%s", "mullion/task-6"]).trim();
      expect(log).toBe("amended");
    });

    it("the underlying --force-with-lease rejects a push whose expected sha is stale", async () => {
      // `pushBranch` fetches immediately before it pushes, so it always
      // leases against the freshest remote state it can see — reproducing
      // an actual race between that fetch and the push itself isn't
      // practical in a single-process test. What IS testable, and what
      // actually matters here, is that the lease mechanism itself rejects a
      // stale expected sha: this is what protects against the ONE case
      // fetch-then-lease can't observe (a push landing in the split second
      // between our fetch and our push), and it's exactly the git behavior
      // `pushBranch` relies on rather than a bare `--force`.
      git(workdir, ["checkout", "-b", "mullion/task-7"]);
      const first = await pushBranch(workdir, "mullion/task-7", TOKEN);
      expect(first.ok).toBe(true);
      const staleSha = git(workdir, ["rev-parse", "mullion/task-7"]).trim();

      const otherClone = fs.mkdtempSync(path.join(os.tmpdir(), "git-push-test-other-"));
      git(otherClone, ["clone", bareRemote, "."]);
      git(otherClone, ["checkout", "mullion/task-7"]);
      fs.writeFileSync(path.join(otherClone, "concurrent.txt"), "concurrent");
      git(otherClone, ["add", "-A"]);
      git(otherClone, ["commit", "-m", "concurrent change", "--no-verify"]);
      git(otherClone, ["push", "origin", "mullion/task-7"]);
      fs.rmSync(otherClone, { recursive: true, force: true });

      fs.writeFileSync(path.join(workdir, "amend.txt"), "amended");
      git(workdir, ["add", "-A"]);
      git(workdir, ["commit", "--amend", "-m", "amended locally", "--no-verify"]);

      expect(() =>
        git(workdir, [
          "push",
          `--force-with-lease=mullion/task-7:${staleSha}`,
          "origin",
          "mullion/task-7",
        ]),
      ).toThrow();
      const log = git(bareRemote, ["log", "-1", "--format=%s", "mullion/task-7"]).trim();
      expect(log).toBe("concurrent change");
    });

    it("pushes normally with no lease when the branch doesn't exist on the remote yet", async () => {
      git(workdir, ["checkout", "-b", "mullion/task-8"]);

      const result = await pushBranch(workdir, "mullion/task-8", TOKEN);

      expect(result).toEqual({ ok: true });
      const branches = git(bareRemote, ["branch", "--list", "mullion/task-8"]);
      expect(branches).toContain("mullion/task-8");
    });

    it("never force-pushes a branch outside the mullion/task- prefix", async () => {
      git(workdir, ["checkout", "-b", "hand-made-branch"]);
      const first = await pushBranch(workdir, "hand-made-branch", TOKEN);
      expect(first.ok).toBe(true);

      const otherClone = fs.mkdtempSync(path.join(os.tmpdir(), "git-push-test-other2-"));
      git(otherClone, ["clone", bareRemote, "."]);
      git(otherClone, ["checkout", "hand-made-branch"]);
      fs.writeFileSync(path.join(otherClone, "concurrent.txt"), "concurrent");
      git(otherClone, ["add", "-A"]);
      git(otherClone, ["commit", "-m", "concurrent change", "--no-verify"]);
      git(otherClone, ["push", "origin", "hand-made-branch"]);
      fs.rmSync(otherClone, { recursive: true, force: true });

      fs.writeFileSync(path.join(workdir, "amend.txt"), "amended");
      git(workdir, ["add", "-A"]);
      git(workdir, ["commit", "--amend", "-m", "amended locally", "--no-verify"]);

      // A plain (non-forced) push here must reject non-fast-forward, same
      // as before this change — a hand-made branch is never a candidate for
      // the lease/force logic at all.
      const result = await pushBranch(workdir, "hand-made-branch", TOKEN);

      expect(result.ok).toBe(false);
      const log = git(bareRemote, ["log", "-1", "--format=%s", "hand-made-branch"]).trim();
      expect(log).toBe("concurrent change");
    });
  });
});
