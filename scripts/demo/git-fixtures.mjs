import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { GIT_NO_AUTO_GC, gitEnv } from "../git-env.mjs";

/**
 * Git history shapes for the demo's scratch repos, shared by the seed and
 * `scripts/verify-history-view.mjs`. Everything is built with plumbing
 * (`commit-tree`, `branch`, `update-ref`) because the seeded work tree is
 * deliberately dirty, which would make a checkout refuse.
 */

const execFileAsync = promisify(execFile);

const IDENTITY = {
  GIT_AUTHOR_NAME: "Demo",
  GIT_AUTHOR_EMAIL: "demo@example.invalid",
  GIT_COMMITTER_NAME: "Demo",
  GIT_COMMITTER_EMAIL: "demo@example.invalid",
};

/** Runs git in `cwd` and returns trimmed stdout. */
export async function gitOut(cwd, ...args) {
  const { stdout } = await execFileAsync("git", [...GIT_NO_AUTO_GC, ...args], {
    cwd,
    env: { ...gitEnv(), ...IDENTITY },
  });
  return stdout.trim();
}

// Fixture commits get their own dates, one minute apart and all in the past, in
// creation order. Left to the clock, commits made within the same second tie and
// the branch list (sorted by recency) shows them in an arbitrary order, so two
// renders of the same demo differ.
let commitClock = Date.now() - 2 * 60 * 60_000;

/** A commit on `parents` that reuses `tree`, so no work tree is touched. */
async function commit(repo, tree, parents, message) {
  const parentArgs = parents.flatMap((p) => ["-p", p]);
  commitClock += 60_000;
  const date = new Date(commitClock).toISOString();
  const { stdout } = await execFileAsync(
    "git",
    [...GIT_NO_AUTO_GC, "commit-tree", tree, ...parentArgs, "-m", message],
    {
      cwd: repo,
      env: { ...gitEnv(), ...IDENTITY, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    },
  );
  return stdout.trim();
}

/**
 * `count` branches off the first commit, one commit each, the fourth with a
 * long name: with 11 the widest shape `All branches` has to lay out. Branches
 * that already exist are left alone, so a caller can top a seeded repo up.
 */
export async function widenHistory(repo, count = 11) {
  const root = await gitOut(repo, "rev-list", "--max-parents=0", "HEAD");
  const tree = await gitOut(repo, "rev-parse", `${root}^{tree}`);
  for (let i = 0; i < count; i += 1) {
    const name = i === 3 ? "feat/1877-sidebar-workspace-scope" : `topic-${i}`;
    const exists = await gitOut(repo, "branch", "--list", name);
    if (exists) continue;
    const sha = await commit(repo, tree, [root], `topic ${i}: a reasonably long subject`);
    await gitOut(repo, "branch", name, sha);
  }
}

/**
 * Branches that exercise the Git panel against `origin` (a bare clone that
 * already holds `main`):
 *
 *   feat/ahead   one local commit not on origin
 *   feat/behind  one commit on origin not local
 *   feat/gone    upstream configured, remote branch deleted (Prune: gone)
 *   feat/merged  already merged into main (Prune: merged)
 *
 * Plus a merge commit on `main`, so the History graph has a join.
 *
 * `archive/audit-log` on origin is load-bearing: it keeps `feat/gone`'s tip
 * reachable from a remote ref, which is what stops Prune treating `feat/gone`
 * as holding unpushed work (branchesWithUnpushedTips). Don't clean it up.
 *
 * Every branch except `feat/merged` carries a commit of its own: listBranches
 * reads a tip that is an ancestor of `main` as "merged" before it looks at
 * the upstream state (git-refs.ts), so a branch forked at main's tip would
 * never show ahead/behind/gone.
 */
export async function addBranchDepth(repo) {
  const head = await gitOut(repo, "rev-parse", "main");
  const tree = await gitOut(repo, "rev-parse", `${head}^{tree}`);

  // Merged: a branch tip that main then merges, leaving a merge commit.
  const mergedTip = await commit(repo, tree, [head], "Add retry helper");
  await gitOut(repo, "branch", "feat/merged", mergedTip);
  const merge = await commit(repo, tree, [head, mergedTip], "Merge feat/merged");
  await gitOut(repo, "update-ref", "refs/heads/main", merge, head);

  const track = async (name, sha) => {
    await gitOut(repo, "branch", name, sha);
    await gitOut(repo, "push", "-q", "origin", `${name}:${name}`);
    await gitOut(repo, "branch", "-q", `--set-upstream-to=origin/${name}`, name);
  };

  // Ahead: pushed at its own commit, then one more local commit.
  const aheadBase = await commit(repo, tree, [merge], "Add the session cache");
  await track("feat/ahead", aheadBase);
  const ahead = await commit(repo, tree, [aheadBase], "Cache the session lookup");
  await gitOut(repo, "update-ref", "refs/heads/feat/ahead", ahead, aheadBase);

  // Behind: origin's copy moves on without the local branch.
  const behindBase = await commit(repo, tree, [merge], "Add the request timeout");
  await track("feat/behind", behindBase);
  const remoteTip = await commit(repo, tree, [behindBase], "Tighten the timeout");
  await gitOut(repo, "push", "-q", "origin", `${remoteTip}:refs/heads/feat/behind`);

  // Gone: the remote branch is deleted but its tip stays reachable from
  // another remote ref, so Prune sees no unpushed work (branchesWithUnpushedTips).
  const goneTip = await commit(repo, tree, [merge], "Draft the audit log");
  await track("feat/gone", goneTip);
  await gitOut(repo, "push", "-q", "origin", `${goneTip}:refs/heads/archive/audit-log`);
  await gitOut(repo, "push", "-q", "origin", "--delete", "feat/gone");

  await gitOut(repo, "push", "-q", "origin", "main");
  await gitOut(repo, "fetch", "-q", "--prune", "origin");
  await gitOut(repo, "branch", "-q", "--set-upstream-to=origin/main", "main");
}

/**
 * A worktree under the project's `.mullion-worktrees` on `branch`, which gets
 * a commit of its own so it is not an ancestor of main (the app would chip it
 * "merged" even with an open PR). Pick a branch no seeded session creates:
 * the server's own `git worktree add -b` refuses an existing branch or path.
 */
export async function addWorktree(repo, branch, message = "Start the work") {
  const head = await gitOut(repo, "rev-parse", "main");
  const tree = await gitOut(repo, "rev-parse", `${head}^{tree}`);
  await gitOut(repo, "branch", branch, await commit(repo, tree, [head], message));
  const dir = path.join(repo, ".mullion-worktrees", branch.replaceAll("/", "-"));
  await mkdir(path.dirname(dir), { recursive: true });
  await gitOut(repo, "worktree", "add", "-q", dir, branch);
  return dir;
}

/** The dock's one control: a static server on the project's dev-server port. */
export async function writeDockControl(repo, { port, scriptDir }) {
  const script = path.join(scriptDir, "dev-server.mjs");
  await writeFile(
    script,
    `import http from "node:http";
http
  .createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end("<h1>Aurora dev server</h1>");
  })
  .listen(${port}, "127.0.0.1");
`,
  );
  await mkdir(path.join(repo, ".crs"), { recursive: true });
  await writeFile(
    path.join(repo, ".crs", "dock.json"),
    JSON.stringify(
      {
        controls: [
          {
            id: "dev-server",
            title: "Dev server",
            command: `node ${JSON.stringify(script)}`,
            port,
            preview: true,
          },
        ],
      },
      null,
      2,
    ),
  );
}
