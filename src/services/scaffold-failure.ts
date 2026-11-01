import type { ExecException } from "node:child_process";

// Failure reporting for a generation turn, split out of scaffold-generate.ts
// (which is at its size ceiling): how a failed turn is described and which
// secrets are redacted from what is logged or put in a 502 body.

export const FAILURE_LOG_TAIL_CHARS = 2000;
const FAILURE_MESSAGE_TAIL_CHARS = 300;

/** Noise an agent CLI prints that says nothing about why the turn failed. */
const HARMLESS_STDERR_LINE = /^Warning: no stdin data received in \d+s/i;

/** Credentials an agent turn could echo (it can read its own credentials file).
 * Applied to every tail that is logged or put in the 502 message. */
const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[\w-]+/g,
  /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g,
  /("?(?:access|refresh|id)_?[Tt]oken"?\s*[:=]\s*)"?[^"\s,}]+"?/g,
  /\bBearer\s+[\w.~+/=-]+/gi,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m, prefix) =>
      typeof prefix === "string" ? `${prefix}"[redacted]"` : "[redacted]",
    );
  }
  return out;
}

/** A fixed label for the agent in log lines. The agent command arrives from a
 * request or project setting; the log gets only the literal it matched, never
 * the caller's string. */
export function agentLogLabel(agentCommand: string): string {
  switch (agentCommand) {
    case "claude":
      return "claude";
    case "codex":
      return "codex";
    case "opencode":
      return "opencode";
    case "agy":
      return "agy";
    default:
      return "unknown agent";
  }
}

export function tail(text: string | Buffer | undefined, max: number): string {
  const t = redactSecrets((text ?? "").toString()).trim();
  return t.length > max ? `…${t.slice(-max)}` : t;
}

type ExecFailure = Pick<ExecException, "code" | "killed" | "signal" | "message">;

export function describeExit(err: ExecFailure): string {
  if (err.killed || err.signal) return `killed by ${err.signal ?? "a signal"}`;
  if (typeof err.code === "number") return `exit code ${err.code}`;
  // A spawn error (ENOENT, EACCES, …): the code alone says nothing, the message does.
  return (err.message ?? "unknown error").split("\n")[0].slice(0, 200);
}

/** The message of a failed generation turn: how it ended, then the tail of what
 * the CLI printed. stdout is included because `claude -p` reports its errors
 * there ("Not logged in"), and known-harmless stderr lines are dropped so they
 * cannot mask the real cause. Bounded: the message ends up in a 502 body. */
export function describeSpawnFailure(
  err: ExecFailure,
  stdout: string | Buffer | undefined,
  stderr: string | Buffer | undefined,
): string {
  const cleanedStderr = (stderr ?? "")
    .toString()
    .split("\n")
    .filter((line) => !HARMLESS_STDERR_LINE.test(line.trim()))
    .join("\n");
  const parts = [describeExit(err)];
  const out = tail(stdout, FAILURE_MESSAGE_TAIL_CHARS);
  const errText = tail(cleanedStderr, FAILURE_MESSAGE_TAIL_CHARS);
  if (out) parts.push(`stdout: ${out}`);
  if (errText) parts.push(`stderr: ${errText}`);
  return parts.join(" — ");
}
