import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseSttySize, ptySizeFile } from "../../scripts/demo/geometry.mjs";
import {
  KEEPALIVE_INTERVAL_S,
  agentTranscriptScript,
  lastTranscriptLine,
  seedDemo,
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
    const out = await runFor(agentTranscriptScript({ lines }), 2_000);
    expect(out).toContain("Claude Code v2.1.0\n\nconst key = `${req.ip}`;\nit's done\n");
  });

  it("keeps writing an invisible SGR reset after the transcript", async () => {
    // Two keepalives at a 1 s cadence, with margin for a loaded host.
    const out = await runFor(agentTranscriptScript({ lines: ["done"] }), 3_600);
    const tail = out.slice(out.indexOf("done\n") + "done\n".length);
    // Nothing but keepalives after the last line, and more than one of them.
    expect(tail.replaceAll("\u001b[0m", "")).toBe("");
    expect(tail.split("\u001b[0m").length - 1).toBeGreaterThanOrEqual(2);
  });

  it("holds the transcript until its release file exists", async () => {
    const releaseFile = path.join(dir, "release-me");
    const script = agentTranscriptScript({ lines: ["held line"], releaseFile });
    const before = runFor(script, 1_500);
    expect(await before).not.toContain("held line");
    writeFileSync(releaseFile, "");
    expect(await runFor(script, 1_500)).toContain("held line");
  });

  it("records its size next to the release file and prints even without a tty", async () => {
    const releaseFile = path.join(dir, "release-sized");
    writeFileSync(releaseFile, "");
    const out = await runFor(agentTranscriptScript({ lines: ["sized line"], releaseFile }), 1_500);
    expect(out).toContain("sized line");
    // No tty here, so stty fails: the file exists but holds no size.
    expect(parseSttySize(readFileSync(ptySizeFile(releaseFile), "utf8"))).toBeNull();
  });

  it("writes keepalives faster than the backend's 2 s idle threshold", () => {
    expect(KEEPALIVE_INTERVAL_S).toBeLessThan(2);
  });
});

describe("lastTranscriptLine", () => {
  it("skips trailing blank lines", () => {
    expect(lastTranscriptLine(["first", "last", "", "  "])).toBe("last");
  });

  it("throws on an all-blank transcript", () => {
    expect(() => lastTranscriptLine(["", "  "])).toThrow("no non-blank line");
  });
});

describe("seedDemo holdTranscripts", () => {
  // Seeds against a stub API (every call answers with an id) so only the
  // generated scripts and the returned release path are under test.
  const seed = (holdTranscripts?: boolean) => {
    const root = mkdtempSync(path.join(dir, "seed-"));
    return seedDemo({ api: async () => ({ id: 1 }), root, holdTranscripts });
  };

  it("gates fake-agent.sh on the returned release file when holding", async () => {
    const seeded = await seed(true);
    const script = readFileSync(path.join(seeded.scriptsDir, "fake-agent.sh"), "utf8");
    expect(seeded.authReleaseFile).toBe(path.join(seeded.scriptsDir, "fake-agent.release"));
    expect(script).toContain(`while [ ! -e '${seeded.authReleaseFile}' ]`);
  });

  it("starts printing immediately by default, as `make demo` expects", async () => {
    const seeded = await seed();
    const script = readFileSync(path.join(seeded.scriptsDir, "fake-agent.sh"), "utf8");
    expect(script).not.toContain("fake-agent.release");
  });
});
