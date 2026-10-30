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
// guarantees is narrower and enforced by git-run.ts's redact(): the token
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
// The lease reads `--force-with-lease=<branch>` with NO explicit `:<sha>` —
// git fills that in from whatever `refs/remotes/origin/<branch>` already is
// locally at push time. That's exactly why this fetches the branch
// immediately beforehand: nothing in the auto-return path fetches on its
// own, so a stale remote-tracking ref would make the (implicit) lease
// reject a push it should allow, reproducing the exact stuck-in-review loop
// this exists to fix. An earlier version of this fix resolved the sha with
// an explicit `rev-parse` and passed it as `--force-with-lease=<branch>:<sha>`
// — verified empirically (a real bare remote, three cases: a legitimate
// rewrite, a genuinely stale/concurrently-moved branch, and a brand-new
// branch with no tracking ref at all) to behave identically to the bare
// form once the fetch above has already run, so the extra round-trip was
// dropped as pure overhead.
//
// Honest limit: fetching immediately before every push means this always
// leases against the freshest state it can see, so it does NOT protect
// against a write that happened before that fetch — only against one
// landing in the brief window between the fetch and the push itself (still
// the direction we want to fail in, and the only case a bare `--force`
// wouldn't cover at all). If the branch doesn't exist on the remote yet
// (first push) the fetch fails to find it, `refs/remotes/origin/<branch>`
// stays unresolved, and git treats the bare lease as an ordinary push in
// that case (verified) — no separate no-lease fallback needed for it.
import { runGitCommand } from "./git-run.js";

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

/**
 * Pushes `branch` from `cwd` to `origin`, setting upstream tracking
 * (`-u`) — idempotent to call on a branch that's already fully pushed
 * (`git push` reports "Everything up-to-date" and exits 0), so callers
 * don't need to separately detect "has this been pushed before."
 *
 * For a `mullion/task-*` branch (the only ones Mullion ever pushes to,
 * outside a human's own promoted-session branch), fetches the branch first
 * and force-pushes with a bare `--force-with-lease` (no explicit sha —
 * see this file's header comment for why that's equivalent here) so a
 * rewritten task branch can still be delivered. Any other branch is pushed
 * exactly as before, never forced.
 *
 * Never throws. Every failure path (spawn error, non-zero exit, timeout)
 * resolves `{ ok: false, detail }` with `detail` already redacted of the
 * token — see this file's header comment on the argv-visibility caveat
 * this does NOT cover.
 */
export async function pushBranch(cwd: string, branch: string, token: string): Promise<PushResult> {
  const encodedCredential = Buffer.from(`x-access-token:${token}`).toString("base64");
  const headerValue = `AUTHORIZATION: basic ${encodedCredential}`;
  const forceable = branch.startsWith(FORCEABLE_BRANCH_PREFIX);

  if (forceable) {
    // Best-effort — freshens refs/remotes/origin/<branch> so the bare
    // --force-with-lease below reads a value we just confirmed, not
    // whatever this worktree's own tracking ref happened to hold. A
    // failure here (network blip, or the branch genuinely doesn't exist on
    // the remote yet) just means the lease falls back to whatever's
    // already local — see this file's header comment for why that's still
    // never worse than not fetching at all.
    await runGitCommand(
      cwd,
      ["fetch", "--quiet", "origin", branch],
      headerValue,
      token,
      encodedCredential,
      GIT_FETCH_TIMEOUT_MS,
    );
  }

  const pushArgs = ["push", "--no-verify", "-u", "origin", branch];
  if (forceable) pushArgs.splice(1, 0, `--force-with-lease=${branch}`);

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
