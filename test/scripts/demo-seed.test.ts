import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  KEEPALIVE_INTERVAL_S,
  agentTranscriptScript,
  lastTranscriptLine,
} from "../../scripts/demo/seed.mjs";

// The demo's fake agents must never fall silent after their transcript, or
// the backend's silence watchdog flags them "Gone quiet" in every screenshot.

const dir = mkdtempSync(path.join(tmpdir(), "mullion-demo-seed-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Runs a generated script for `ms` and returns everything it wrote. */
function runFor(script: string, ms: number): Promise<string> {
  const file = path.join(dir, `agent-${Math.random().toString(36).slice(2)}.sh`);
  writeFileSync(file, script, { mode: 0o755 });
  return new Promise((resolve, reject) => {
    // TERM=dumb so `clear` prints nothing we have to strip.
    const child = spawn(file, { env: { PATH: process.env.PATH, TERM: "dumb" } });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.on("error", reject);
    setTimeout(() => {
      child.kill("SIGKILL");
      resolve(out);
    }, ms);
  });
}

describe("agentTranscriptScript", () => {
  it("prints the transcript verbatim, including shell metacharacters", async () => {
    const lines = ["Claude Code v2.1.0", "", "const key = `${req.ip}`;", "it's done"];
    const out = await runFor(agentTranscriptScript({ startDelay: 0, lines }), 2_000);
    expect(out).toContain("Claude Code v2.1.0\n\nconst key = `${req.ip}`;\nit's done\n");
  });

  it("keeps writing an invisible SGR reset after the transcript", async () => {
    const out = await runFor(agentTranscriptScript({ startDelay: 0, lines: ["done"] }), 2_600);
    const tail = out.slice(out.indexOf("done\n") + "done\n".length);
    // Nothing but keepalives after the last line, and more than one of them.
    expect(tail.replaceAll("\u001b[0m", "")).toBe("");
    expect(tail.split("\u001b[0m").length - 1).toBeGreaterThanOrEqual(2);
  });

  it("holds the transcript until its release file exists", async () => {
    const releaseFile = path.join(dir, "release-me");
    const script = agentTranscriptScript({ startDelay: 0, lines: ["held line"], releaseFile });
    const before = runFor(script, 1_500);
    expect(await before).not.toContain("held line");
    writeFileSync(releaseFile, "");
    expect(await runFor(script, 1_500)).toContain("held line");
  });

  it("writes keepalives faster than the backend's 2 s idle threshold", () => {
    expect(KEEPALIVE_INTERVAL_S).toBeLessThan(2);
  });
});

describe("lastTranscriptLine", () => {
  it("skips trailing blank lines", () => {
    expect(lastTranscriptLine(["first", "last", "", "  "])).toBe("last");
  });
});
