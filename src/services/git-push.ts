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
import { spawn as spawnChild } from "node:child_process";
import { gitEnv } from "./git-env.js";

// 120s, not 30s: sized for a real push over a slow link now that
// `--no-verify` means the timeout is no longer also budget for an arbitrary
// repo's pre-push hook.
const GIT_TIMEOUT_MS = 120_000;

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

/**
 * Pushes `branch` from `cwd` to `origin`, setting upstream tracking
 * (`-u`) — idempotent to call on a branch that's already fully pushed
 * (`git push` reports "Everything up-to-date" and exits 0), so callers
 * don't need to separately detect "has this been pushed before."
 *
 * Never throws. Every failure path (spawn error, non-zero exit, timeout)
 * resolves `{ ok: false, detail }` with `detail` already redacted of the
 * token — see this file's header comment on the argv-visibility caveat
 * this does NOT cover.
 */
export function pushBranch(cwd: string, branch: string, token: string): Promise<PushResult> {
  return new Promise((resolve) => {
    const encodedCredential = Buffer.from(`x-access-token:${token}`).toString("base64");
    const headerValue = `AUTHORIZATION: basic ${encodedCredential}`;
    let stderr = "";
    let settled = false;

    const child = spawnChild(
      "git",
      [
        "-C",
        cwd,
        "-c",
        `http.extraHeader=${headerValue}`,
        "push",
        "--no-verify",
        "-u",
        "origin",
        branch,
      ],
      // `detached: true` puts `child` in its own process group so the
      // timeout handler below can kill the whole group, not just the `git`
      // process itself — a pre-push hook's own children (e.g. `go test`,
      // `go install`) are otherwise left running past `child.kill()`.
      { stdio: ["ignore", "ignore", "pipe"], env: gitEnv(), detached: true },
    );

    const finish = (result: PushResult) => {
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
      finish({ ok: false, detail: "git push timed out" });
    }, GIT_TIMEOUT_MS);

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      finish({
        ok: false,
        detail: redact(`git push failed to start: ${err.message}`, token, encodedCredential),
      });
    });
    child.on("close", (code) => {
      if (code === 0) {
        finish({ ok: true });
        return;
      }
      finish({
        ok: false,
        detail: redact(stderr.trim() || `git push exited ${code}`, token, encodedCredential),
      });
    });
  });
}
