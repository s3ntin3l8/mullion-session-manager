import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getCommitDetail,
  getCommitFileDiff,
  getCommitLog,
  isSafeRepoPath,
  isValidSha,
} from "../../src/services/git-log.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim();

describe("git-log", () => {
  let dir: string;
  let mergeSha: string;
  let firstSha: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-log-test-"));
    git(dir, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "first");
    firstSha = git(dir, "rev-parse", "HEAD");
    git(dir, "checkout", "-q", "-b", "feat");
    fs.writeFileSync(path.join(dir, "b.txt"), "b\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "feat: b");
    git(dir, "checkout", "-q", "main");
    fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");
    git(dir, "commit", "-q", "-am", "second");
    git(dir, "merge", "-q", "--no-ff", "-m", "merge feat", "feat");
    git(dir, "tag", "v1");
    mergeSha = git(dir, "rev-parse", "HEAD");
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("pages the log in topo order with parents and decorations", async () => {
    const log = await getCommitLog(dir);
    expect(log).not.toBeNull();
    expect(new Set(log!.map((c) => c.subject))).toEqual(
      new Set(["merge feat", "second", "feat: b", "first"]),
    );
    // Topo order: the merge precedes both of its parents.
    expect(log![0].subject).toBe("merge feat");
    expect(log!).toHaveLength(4);
    const merge = log![0];
    expect(merge.sha).toBe(mergeSha);
    expect(merge.parents).toHaveLength(2);
    expect(merge.refs).toEqual(expect.arrayContaining(["HEAD -> main", "tag: v1"]));
    expect(log!.find((c) => c.sha === firstSha)!.parents).toEqual([]);

    const page2 = await getCommitLog(dir, { limit: 2, skip: 2 });
    expect(page2).toHaveLength(2);
    expect(page2!.map((c) => c.sha)).toEqual(log!.slice(2).map((c) => c.sha));
  });

  it("is not thrown off by signed commits under log.showSignature=true", async () => {
    // A stub gpg lets us really sign a commit: with showSignature on, plain
    // `git log` then prepends a `gpg:` verification block to each record.
    const stub = path.join(dir, "stub-gpg.sh");
    // Restore point captured before anything is changed, so teardown resets to
    // it whether or not the signed commit was actually created.
    const before = git(dir, "rev-parse", "HEAD");
    fs.writeFileSync(
      stub,
      [
        "#!/bin/sh",
        'for a in "$@"; do [ "$a" = "--verify" ] && verify=1; done',
        'if [ -n "$verify" ]; then',
        '  echo "gpg: Good signature from stub" >&2',
        '  echo "[GNUPG:] GOODSIG ABCDEF0123456789 stub"',
        '  echo "[GNUPG:] VALIDSIG ABCDEF0123456789 2026-01-01 1 0 4 0 1 8 00 ABCDEF0123456789"',
        "  exit 0",
        "fi",
        "cat >/dev/null",
        'echo "-----BEGIN PGP SIGNATURE-----"',
        "echo",
        'echo "c3R1Yg=="',
        'echo "-----END PGP SIGNATURE-----"',
        'echo "[GNUPG:] SIG_CREATED D 1 8 00 1 ABCDEF0123456789" >&2',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    try {
      git(dir, "config", "gpg.program", stub);
      git(dir, "config", "user.signingkey", "ABCDEF0123456789");
      fs.writeFileSync(path.join(dir, "signed.txt"), "s\n");
      git(dir, "add", "signed.txt");
      git(dir, "commit", "-q", "-S", "-m", "signed commit");
      git(dir, "config", "log.showSignature", "true");
      // Sanity: plain git really does emit the block here.
      expect(git(dir, "log", "-1")).toContain("gpg:");
      const log = await getCommitLog(dir);
      expect(log!.length).toBeGreaterThan(0);
      expect(log![0].subject).toBe("signed commit");
      expect(log!.every((c) => /^[0-9a-f]{40}$/.test(c.sha))).toBe(true);
      expect(await getCommitDetail(dir, log![0].sha)).not.toBeNull();
    } finally {
      // Best-effort and order-independent: a failure here must not mask the
      // original error, and unsetting an unwritten key must not throw.
      for (const key of ["log.showSignature", "gpg.program", "user.signingkey"]) {
        try {
          git(dir, "config", "--unset", key);
        } catch {
          // key was never set
        }
      }
      git(dir, "reset", "-q", "--hard", before);
      fs.rmSync(path.join(dir, "signed.txt"), { force: true });
      fs.rmSync(stub, { force: true });
    }
  });

  it("limits to HEAD's history when all=false", async () => {
    const onlyHead = await getCommitLog(dir, { all: false });
    expect(onlyHead).toHaveLength(4); // feat is merged into main
    git(dir, "branch", "side", firstSha);
    git(dir, "checkout", "-q", "side");
    fs.writeFileSync(path.join(dir, "s.txt"), "s\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "side only");
    const side = await getCommitLog(dir, { all: false });
    expect(side!.map((c) => c.subject)).toEqual(["side only", "first"]);
    const all = await getCommitLog(dir);
    expect(all!.map((c) => c.subject)).toContain("merge feat");
    git(dir, "checkout", "-q", "main");
  });

  it("returns commit detail with numstat, and a file's diff", async () => {
    const detail = await getCommitDetail(dir, mergeSha);
    expect(detail).toMatchObject({ sha: mergeSha, author: "T", email: "t@example.com" });
    expect(detail!.message).toBe("merge feat");

    const second = (await getCommitLog(dir))!.find((c) => c.subject === "second")!;
    const d2 = await getCommitDetail(dir, second.sha);
    expect(d2!.files).toEqual([{ path: "a.txt", additions: 1, deletions: 0 }]);
    const diff = await getCommitFileDiff(dir, second.sha, "a.txt");
    expect(diff).toContain("+two");
  });

  it("reports a rename by its new path, which git accepts back for the diff", async () => {
    git(dir, "mv", "b.txt", "renamed.txt");
    git(dir, "commit", "-q", "-m", "rename b");
    const sha = git(dir, "rev-parse", "HEAD");
    const detail = await getCommitDetail(dir, sha);
    expect(detail!.files).toEqual([{ path: "renamed.txt", additions: 0, deletions: 0 }]);
    // A path with spaces/specials survives -z unquoted too.
    fs.writeFileSync(path.join(dir, "sp ace.txt"), "x\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "spaced");
    const sha2 = git(dir, "rev-parse", "HEAD");
    expect((await getCommitDetail(dir, sha2))!.files[0].path).toBe("sp ace.txt");
    const diff = await getCommitFileDiff(dir, sha2, "sp ace.txt");
    expect(diff).toContain("+x");
  });

  it("rejects unsafe input and non-repos without spawning git for them", async () => {
    expect(isValidSha("abc1234")).toBe(true);
    expect(isValidSha("--output=x")).toBe(false);
    expect(isValidSha("ABCDEF1")).toBe(false);
    expect(isSafeRepoPath("src/a.ts")).toBe(true);
    expect(isSafeRepoPath("../etc/passwd")).toBe(false);
    expect(isSafeRepoPath("/etc/passwd")).toBe(false);
    expect(isSafeRepoPath("")).toBe(false);

    expect(await getCommitDetail(dir, "--output=/tmp/x")).toBeNull();
    expect(await getCommitFileDiff(dir, mergeSha, "../x")).toBeNull();
    const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), "git-log-norepo-"));
    expect(await getCommitLog(notRepo)).toBeNull();
    expect(await getCommitLog("relative/path")).toBeNull();
    fs.rmSync(notRepo, { recursive: true, force: true });
    expect(await getCommitDetail(dir, "0000000")).toBeNull();

    // A subdirectory of a repo is not a repo root: no history leaks from the parent.
    const sub = path.join(dir, "subdir");
    fs.mkdirSync(sub);
    expect(await getCommitLog(sub)).toBeNull();
  });

  it("clamps the page size", async () => {
    const log = await getCommitLog(dir, { limit: 100000, skip: -5 });
    expect(log!.length).toBeLessThanOrEqual(200);
  });
});
