// Issue #1798: run_with_timeout's watchdog subshell blocks in `sleep`; killing
// the subshell alone orphaned that sleep for the whole budget (a leaked
// `sleep 600` per `npm ci` in self-update.sh).
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";

const PORTABLE = path.resolve(__dirname, "../../scripts/portable.sh");

function sleepersWithBudget(seconds: number): string {
  try {
    return execFileSync("pgrep", ["-x", "-a", "sleep"], { encoding: "utf8" })
      .split("\n")
      .filter((l) => l.endsWith(` ${seconds}`))
      .join("\n");
  } catch {
    return ""; // pgrep exits 1 when nothing matches
  }
}

describe("run_with_timeout", () => {
  it("leaves no watchdog sleep behind when the command finishes first", () => {
    const budget = 3000 + (process.pid % 500); // unlikely to collide with another process
    execFileSync("bash", ["-c", `. '${PORTABLE}'; run_with_timeout ${budget} true`]);
    expect(sleepersWithBudget(budget)).toBe("");
  });

  it("still kills a command that outlives the budget", () => {
    let status = 0;
    try {
      execFileSync("bash", ["-c", `. '${PORTABLE}'; run_with_timeout 1 sleep 30`]);
    } catch (err) {
      status = (err as { status: number }).status;
    }
    expect(status).not.toBe(0);
  });
});
