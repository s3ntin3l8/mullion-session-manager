// Shared git runner, extracted from git-push.ts so the clone service (git-clone.ts)
// goes through the exact same never-throws, always-redacted plumbing instead of a
// copy. `headerValue: null` runs git without an `http.extraHeader` (a public clone).
import { spawn as spawnChild } from "node:child_process";
import { GIT_NO_AUTO_GC, gitEnv } from "./git-env.js";

/** Strips every given secret from `text`, in order — used for both the raw
 * token and the base64-encoded `http.extraHeader` value derived from it
 * (Hermes review, PR #475: the encoded form is the same credential in a
 * different shape, and redact() previously only covered the raw one). */
export function redact(text: string, ...secrets: string[]): string {
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
export function runGitCommand(
  cwd: string,
  args: string[],
  headerValue: string | null,
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
      [
        ...GIT_NO_AUTO_GC,
        "-C",
        cwd,
        ...(headerValue === null ? [] : ["-c", `http.extraHeader=${headerValue}`]),
        ...args,
      ],
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

/** One `git clone` — generous: a large repo over a slow link. Lives here, not
 * in git-clone.ts, so remote-host-client.ts can derive its request timeout from
 * it without importing the service (and its host-registry dependency). */
export const GIT_CLONE_TIMEOUT_MS = 10 * 60_000;
