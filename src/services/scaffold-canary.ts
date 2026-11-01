import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Issue #2535 — the scaffold bugs that cost the most (#2430, #2472) all ended
// in a turn that exited 0 and printed plausible content written WITHOUT
// reading the repository. The unit tests mock the agent, so only a live run
// showed them. A canary makes that failure loud: a random value is placed in
// a file in the scratch worktree, the prompt asks the agent to read the file
// and echo the value on a last line, and a turn that did not echo it is
// rejected. The prompt never contains the value, so only a turn that really
// read the file can produce it.
//
// It lives inside the real turn, not in a separate preflight turn: a second
// turn would double the latency and cost of every Generate for the same signal.
// It is applied in `runGenerationTurnInScratchWorktree`, which both the local
// path and the remote agent's `/internal/run-generation-turn` run, so it needs
// no wire change (an older remote agent simply has no canary).

export const CANARY_FILE = ".mullion-canary";
const CANARY_LABEL = "MULLION_CANARY:";

export interface Canary {
  readonly value: string;
  /** The prompt with the canary instruction appended. */
  withInstruction(prompt: string): string;
  /** `stdout` without the canary line, or `null` if the agent did not echo it. */
  verify(stdout: string): string | null;
}

/** Writes the canary file into `worktreePath`, which must lie strictly inside
 * `rootDir` (the server-controlled scratch root), and returns the handle. */
export function placeCanary(worktreePath: string, rootDir: string): Canary {
  const value = randomBytes(8).toString("hex");
  const dir = path.resolve(worktreePath);
  if (!dir.startsWith(path.resolve(rootDir) + path.sep)) {
    throw new Error(`refusing to place a canary outside the scratch root (${dir})`);
  }
  const file = path.join(dir, CANARY_FILE);
  // The worktree is a checkout of the project repo, so the repo may already
  // track this name (even as a symlink): remove it, then create exclusively
  // with owner-only permissions so nothing is followed or overwritten.
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, `${value}\n`, { flag: "wx", mode: 0o600 });
  // A turn that echoed the token DID read the file, whatever surrounds the
  // token (backticks, a bullet, a period), so the accept check is just "the
  // token is present" (the value is random per turn; it may appear anywhere,
  // not only on the last line the prompt asks for). Stripping removes only the
  // token, so an echo sharing a line with real output (or a section marker)
  // leaves that output intact; a line left holding nothing but decoration goes.
  const token = `${CANARY_LABEL} ${value}`;
  const decorationOnly = /^[\s`*_>.\-\u2022]*$/;
  return {
    value,
    withInstruction: (prompt) =>
      `${prompt}\n\nBefore anything else, read the file ${CANARY_FILE} in the repository root. ` +
      `Then, after everything else you print, add one final line of the form ` +
      `"${CANARY_LABEL} <the file's content>" (the content is a short token; copy it exactly). ` +
      `That line is a check that you could read the repository.`,
    verify: (stdout) => {
      if (!stdout.includes(token)) return null;
      return stdout
        .split(/(?<=\n)/)
        .flatMap((line) => {
          if (!line.includes(token)) return [line];
          const eol = /\r?\n$/.exec(line)?.[0] ?? "";
          const rest = line
            .slice(0, line.length - eol.length)
            .split(token)
            .join("");
          return decorationOnly.test(rest) ? [] : [rest.trimEnd() + eol];
        })
        .join("");
    },
  };
}

export const CANARY_MISSING_MESSAGE =
  "the agent did not read the repository (it never echoed the canary file's content), so the " +
  "output was discarded; likely causes are its credentials, its own sandbox, or its working directory";
