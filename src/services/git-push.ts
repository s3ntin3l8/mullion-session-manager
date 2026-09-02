// Task -> PR promotion push (Phase 6 Task Master, 6.7/#220) — this repo's
// first `git push`. Shells out (no Git-Data/Contents API round-trip to
// recreate a branch that already exists, committed, in the worktree) using
// the same spawn + gitEnv() + never-reject `runGit`-shaped helper as
// git-worktree.ts's own git calls.
//
// Credential: passed for this single invocation via `-c
// http.extraHeader=...` on argv, never by rewriting the remote URL — a
// token embedded in `.git/config` (e.g. `https://<token>@github.com/...`)
// persists on disk for every future git operation in that checkout,
// including ones a human might run by hand later. `http.extraHeader` is an
// http(s)-transport-only mechanism; an origin configured over ssh ignores
// it entirely and falls back to whatever ssh key is already set up for
// that host, which may or may not have push access — a known limitation of
// this approach, not a bug (this repo's own `origin` is https, and so is
// the vast majority of GitHub remotes Mullion connects to via a PAT/OAuth
// token in the first place).
//
// Security note (explicit callout per this PR's own plan): the header
// value is on argv, which means a `ps`/`/proc` listing on the SAME host
// during the push's brief lifetime could observe it — the same exposure
// every other argv-credentialed CLI tool on a shared host already has (git
// itself has no `--extra-header-from-stdin` equivalent). What THIS module
// guarantees is narrower and enforced by the redact() below: the token
// never appears in anything this module logs, throws, or returns — every
// error message is built from git's own stderr with the token string
// stripped out first.
//
// `--no-verify`: a plain `git push` runs the TARGET repo's own `pre-push`
// hook synchronously inside this Fastify request handler. Observed in
// production (task 213765/#722's investigation): a repo whose pre-push hook
// runs `go test -race` plus a networked `go install .../govulncheck` takes
// minutes, not the `GIT_TIMEOUT_MS` below — every promotion push into that
// repo timed out, permanently. The commit being pushed already passed its
// own pre-COMMIT hooks in the agent's worktree before this ever runs; CI on
// the resulting PR is the real gate. A repo's arbitrary, potentially
// multi-minute pre-push suite is not something a synchronous HTTP handler
// can support running, so this skips it unconditionally rather than trying
// to bound it.
//
// Known gap this doesn't cover (independent review): a repo using Git LFS
// relies on its OWN `pre-push` hook (`git lfs pre-push`) to actually upload
// LFS objects — `--no-verify` skips that too, so a promoted branch's LFS
// pointers can reference objects that were never uploaded. "CI on the PR is
// the real gate" doesn't hold here; CI can't recover an object this push
// never sent. No Task Master target repo uses LFS today — if one starts to,
// this needs its own fix (e.g. an explicit `git lfs push` before the
// `--no-verify` push), not a blanket workaround.
//
// Force-with-lease (task 258971's investigation): a worker that amends or
// rebases a commit it already ended a turn on rewrites history on a branch
// Mullion has already pushed — the plain push this file used to always run
// then rejects every subsequent attempt non-fast-forward, forever, since
// nothing else in the auto-return path ever un-sticks it. Mullion owns the
// `mullion/task-*` namespace exclusively (the worker preamble forbids
// pushing at all), so a rewrite here is expected, not a hazard to block —
// `pushBranch` below force-pushes with a lease whenever `branch` matches
// that prefix, and pushes normally otherwise (a hand-made or
// promoted-session branch a human owns).
//
// The lease is taken against a `git fetch origin <branch>` done immediately
// before the push, NOT against whatever `refs/remotes/origin/<branch>`
// already happens to be in the worktree — nothing in the auto-return path
// fetches on its own, so a stale remote-tracking ref would make the lease
// reject a push it should allow (reproducing the exact stuck-in-review loop
// this exists to fix). Honest limit: fetching immediately before every push
// means this always leases against the freshest state it can see, so it
// does NOT protect against a write that happened before that fetch — only
// against one landing in the brief window between the fetch and the push
// itself (still the direction we want to fail in, and the only case a bare
// `--force` wouldn't cover at all). If the branch doesn't exist on the
// remote yet (first push), the fetch finds nothing and the push proceeds
// without `--force-with-lease` — there's nothing to lease against, and an
// ordinary push already succeeds for a brand-new branch.
import { spawn as spawnChild } from "node:child_process";
import { gitEnv } from "./git-env.js";

// 120s, not 30s: sized for a real push over a slow link now that
// `--no-verify` means the timeout is no longer also budget for an arbitrary
// repo's pre-push hook.
const GIT_TIMEOUT_MS = 120_000;

// Separate, shorter timeout for the pre-push fetch — a plain `git fetch` of
// one branch never runs a repo's arbitrary hooks, so there's no pre-push-hook
// analog to budget for here.
const GIT_FETCH_TIMEOUT_MS = 30_000;

// Mullion only ever creates and pushes branches under this prefix (see
// task-promote.ts/git-worktree.ts) — forcing a push on anything else would
// mean overwriting a hand-made or promoted-session branch a human owns.
const FORCEABLE_BRANCH_PREFIX = "mullion/task-";

export interface PushResult {
  ok: boolean;
  /** Redacted — safe to log or return in an HTTP error body. Only set when
   * `!ok`. */
  detail?: string;
}

/** Strips every given secret from `text`, in order — used for both the raw
 * token and the base64-encoded `http.extraHeader` value derived from it
 * (Hermes review, PR #475: the encoded form is the same credential in a
 * different shape, and redact() previously only covered the raw one). */
function redact(text: string, ...secrets: string[]): string {
  let result = text;
  for (const secret of secrets) {
    if (secret) result = result.split(secret).join("[redacted]");
  }
  return result;
}

/** Runs one git subcommand against `cwd` with the shared credential header,
 * env, and timeout/kill-group handling — shared by `pushBranch`'s pre-push
 * fetch, its sha lookup, and the push itself, so all three go through the
 * exact same never-throws, always-redacted plumbing. On success resolves
 * `{ ok: true, stdout }`; every failure path (spawn error, non-zero exit,
 * timeout) resolves `{ ok: false, detail }` with `detail` already redacted
 * of the token. */
function runGitCommand(
  cwd: string,
  args: string[],
  headerValue: string,
  token: string,
  encodedCredential: string,
  timeoutMs: number,
): Promise<{ ok: true; stdout: string } | { ok: false; detail: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const child = spawnChild(
      "git",
      ["-C", cwd, "-c", `http.extraHeader=${headerValue}`, ...args],
      // `detached: true` puts `child` in its own process group so the
      // timeout handler below can kill the whole group, not just the `git`
      // process itself — a pre-push hook's own children (e.g. `go test`,
      // `go install`) are otherwise left running past `child.kill()`.
      { stdio: ["ignore", "pipe", "pipe"], env: gitEnv(), detached: true },
    );

    const finish = (result: { ok: true; stdout: string } | { ok: false; detail: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // Process (group) may already be gone — nothing more to do.
      }
      finish({ ok: false, detail: `git ${args[0]} timed out` });
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      finish({
        ok: false,
        detail: redact(`git ${args[0]} failed to start: ${err.message}`, token, encodedCredential),
      });
    });
    child.on("close", (code) => {
      if (code === 0) {
        finish({ ok: true, stdout });
        return;
      }
      finish({
        ok: false,
        detail: redact(stderr.trim() || `git ${args[0]} exited ${code}`, token, encodedCredential),
      });
    });
  });
}

/**
 * Pushes `branch` from `cwd` to `origin`, setting upstream tracking
 * (`-u`) — idempotent to call on a branch that's already fully pushed
 * (`git push` reports "Everything up-to-date" and exits 0), so callers
 * don't need to separately detect "has this been pushed before."
 *
 * For a `mullion/task-*` branch (the only ones Mullion ever pushes to,
 * outside a human's own promoted-session branch), fetches the branch first
 * and force-pushes with `--force-with-lease` against the sha just fetched —
 * see this file's header comment for why a rewritten task branch needs this
 * and why the lease is taken fresh rather than trusting the worktree's own
 * remote-tracking ref. Any other branch is pushed exactly as before.
 *
 * Never throws. Every failure path (spawn error, non-zero exit, timeout)
 * resolves `{ ok: false, detail }` with `detail` already redacted of the
 * token — see this file's header comment on the argv-visibility caveat
 * this does NOT cover.
 */
export async function pushBranch(cwd: string, branch: string, token: string): Promise<PushResult> {
  const encodedCredential = Buffer.from(`x-access-token:${token}`).toString("base64");
  const headerValue = `AUTHORIZATION: basic ${encodedCredential}`;

  let leaseArg: string | null = null;
  if (branch.startsWith(FORCEABLE_BRANCH_PREFIX)) {
    const fetchResult = await runGitCommand(
      cwd,
      ["fetch", "--quiet", "origin", branch],
      headerValue,
      token,
      encodedCredential,
      GIT_FETCH_TIMEOUT_MS,
    );
    // A fetch failure here (network blip, branch doesn't exist on the
    // remote yet) just means there's nothing to lease against — fall
    // through to an ordinary push rather than failing the whole operation
    // over a step that's purely an optimization for the rewritten-branch
    // case.
    if (fetchResult.ok) {
      const shaResult = await runGitCommand(
        cwd,
        ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`],
        headerValue,
        token,
        encodedCredential,
        GIT_FETCH_TIMEOUT_MS,
      );
      if (shaResult.ok) {
        const sha = shaResult.stdout.trim();
        if (sha) leaseArg = `--force-with-lease=${branch}:${sha}`;
      }
      // No remote-tracking ref resolved: the branch doesn't exist on the
      // remote yet (first push) — push without a lease, same as always.
    }
  }

  const pushArgs = ["push", "--no-verify", "-u", "origin", branch];
  if (leaseArg) pushArgs.splice(1, 0, leaseArg);

  const result = await runGitCommand(
    cwd,
    pushArgs,
    headerValue,
    token,
    encodedCredential,
    GIT_TIMEOUT_MS,
  );
  return result.ok ? { ok: true } : { ok: false, detail: result.detail };
}
