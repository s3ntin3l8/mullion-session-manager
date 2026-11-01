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

/** Writes the canary file into `worktreePath` and returns the handle. */
export function placeCanary(worktreePath: string): Canary {
  const value = randomBytes(8).toString("hex");
  fs.writeFileSync(path.join(worktreePath, CANARY_FILE), `${value}\n`);
  // One pattern for both the accept check and the strip, so a turn is never
  // accepted on a line that then stays in the output.
  const lineRe = new RegExp(`^[ \\t]*${CANARY_LABEL} ${value}[ \\t]*\\r?(?:\\n|$)`, "gm");
  return {
    value,
    withInstruction: (prompt) =>
      `${prompt}\n\nBefore anything else, read the file ${CANARY_FILE} in the repository root. ` +
      `Then, after everything else you print, add one final line of the form ` +
      `"${CANARY_LABEL} <the file's content>" (the content is a short token; copy it exactly). ` +
      `That line is a check that you could read the repository.`,
    verify: (stdout) => {
      if (!new RegExp(lineRe.source, "m").test(stdout)) return null;
      return stdout.replace(lineRe, "");
    },
  };
}

export const CANARY_MISSING_MESSAGE =
  "the agent did not read the repository (it never echoed the canary file's content), so the " +
  "output was discarded; likely causes are its credentials, its own sandbox, or its working directory";
