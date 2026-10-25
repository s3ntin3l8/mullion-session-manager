import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { gitEnv } from "../../src/services/git-env.js";

/**
 * A clone with a real local remote, and a commit on the remote that the clone
 * does NOT have yet — so a fetch is observable: before the fetch the clone's
 * origin/main is the first commit, after it the second.
 *
 * `git clone` sets up `refs/remotes/origin/main` itself, so a clone alone
 * cannot show whether a fetch happened; the second commit is what makes the
 * difference visible.
 */
export function cloneWithRemote(base: string): { repo: string; fetchedHead: string } {
  const remote = path.join(base, "remote.git");
  const work = path.join(base, "work");
  const repo = path.join(base, "clone");
  const author = {
    ...gitEnv(),
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  fs.mkdirSync(base, { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", remote], { env: gitEnv() });
  execFileSync("git", ["init", "-q", work], { env: gitEnv() });
  fs.writeFileSync(path.join(work, "a.txt"), "hello\n");
  execFileSync("git", ["-C", work, "add", "-A"], { env: gitEnv() });
  execFileSync("git", ["-C", work, "commit", "-q", "-m", "one"], { env: author });
  execFileSync("git", ["-C", work, "remote", "add", "origin", remote], { env: gitEnv() });
  execFileSync("git", ["-C", work, "push", "-q", "origin", "HEAD:refs/heads/main"], {
    env: gitEnv(),
  });
  execFileSync("git", ["clone", "-q", remote, repo], { env: gitEnv() });

  // A second commit on the remote, pushed AFTER the clone: the clone only
  // learns about it through a fetch.
  fs.writeFileSync(path.join(work, "b.txt"), "more\n");
  execFileSync("git", ["-C", work, "add", "-A"], { env: gitEnv() });
  execFileSync("git", ["-C", work, "commit", "-q", "-m", "two"], { env: author });
  execFileSync("git", ["-C", work, "push", "-q", "origin", "HEAD:refs/heads/main"], {
    env: gitEnv(),
  });
  const fetchedHead = execFileSync("git", ["-C", work, "rev-parse", "HEAD"], {
    env: gitEnv(),
    encoding: "utf8",
  }).trim();
  return { repo, fetchedHead };
}

/** Whether the clone has fetched the remote's newer commit. */
export function hasFetched(repo: string, head: string): boolean {
  try {
    const ref = execFileSync(
      "git",
      ["-C", repo, "rev-parse", "--verify", "refs/remotes/origin/main"],
      { env: gitEnv(), stdio: ["ignore", "pipe", "ignore"] },
    )
      .toString()
      .trim();
    return ref === head;
  } catch {
    return false;
  }
}
