import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseSttySize, ptySizeFile } from "../../scripts/demo/geometry.mjs";
import {
  IDLE_KEEPALIVE_INTERVAL_S,
  KEEPALIVE_INTERVAL_S,
  agentTranscriptScript,
  lastTranscriptLine,
  seedDemo,
} from "../../scripts/demo/seed.mjs";
import { pinnedPath } from "../helpers/pinned-path.js";

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
    const child = spawn(file, { env: { PATH: pinnedPath(), TERM: "dumb" } });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.on("error", reject);
    setTimeout(() => {
      child.kill("SIGKILL");
      resolve(out);
    }, ms);
  });
}

describe("agentTranscriptScript options", () => {
  const lines = ["hello"];

  it("sends a hook event through the shipped forwarder, tolerating its absence", () => {
    const script = agentTranscriptScript({
      lines,
      hookEvent: { kind: "Notification", payload: { message: "needs you" } },
    });
    expect(script).toContain('claude-code Notification <<< \'{"message":"needs you"}\'');
    // `set -u` would abort on an unset variable, so both must have defaults.
    expect(script).toContain("${MULLION_FORWARDER_PATH:-}");
    expect(script).toContain("${MULLION_FORWARDER_NODE:-node}");
    expect(script).toContain("|| true");
    expect(agentTranscriptScript({ lines })).not.toContain("claude-code");
  });

  it("exits after the transcript when asked, and never loops", () => {
    const script = agentTranscriptScript({ lines, exitAfter: true });
    expect(script.trimEnd().endsWith("exit 0")).toBe(true);
    expect(script).not.toContain("while :");
  });

  it("idles on a slow keepalive: past the idle threshold, under the silence bound", () => {
    const script = agentTranscriptScript({ lines, idle: true });
    expect(script).toContain(`sleep ${IDLE_KEEPALIVE_INTERVAL_S}; done`);
    expect(IDLE_KEEPALIVE_INTERVAL_S).toBeGreaterThan(2); // backend idle threshold
    expect(IDLE_KEEPALIVE_INTERVAL_S).toBeLessThan(60); // "Gone quiet" bound
    expect(agentTranscriptScript({ lines })).toContain(`sleep ${KEEPALIVE_INTERVAL_S}; done`);
  });
});

describe("agentTranscriptScript", () => {
  it("prints the transcript verbatim, including shell metacharacters", async () => {
    const lines = ["Claude Code v2.1.0", "", "const key = `${req.ip}`;", "it's done"];
    // `releaseFile` is optional in the implementation (`releaseFile ? ... :
    // ""`), but scripts/demo/seed.mjs is plain JS — its options destructuring
    // has no default, so TypeScript infers the field as required. Pass it
    // explicitly as undefined where the test means "no release file".
    const out = await runFor(agentTranscriptScript({ lines, releaseFile: undefined }), 2_000);
    expect(out).toContain("Claude Code v2.1.0\n\nconst key = `${req.ip}`;\nit's done\n");
  });

  it("keeps writing an invisible SGR reset after the transcript", async () => {
    // Two keepalives at a 1 s cadence, with margin for a loaded host.
    const out = await runFor(
      agentTranscriptScript({ lines: ["done"], releaseFile: undefined }),
      3_600,
    );
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

// Every call answers with an id; GET /api/settings also reports the Task Master
// state the seed reads back (`paused: false` simulates a lost pause).
const stubApi =
  (paused = true) =>
  async () => ({ id: 1, taskMaster: { enabled: "on", autoClaimPaused: paused } });

describe("seedDemo holdTranscripts", () => {
  // Seeds against a stub API (every call answers with an id) so only the
  // generated scripts and the returned release path are under test.
  const seed = (holdTranscripts?: boolean) => {
    const root = mkdtempSync(path.join(dir, "seed-"));
    return seedDemo({ api: stubApi(), root, holdTranscripts });
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

describe("seedDemo Task Master pin", () => {
  it("refuses to go on when auto-claim is not paused", async () => {
    const root = mkdtempSync(path.join(dir, "seed-"));
    await expect(seedDemo({ api: stubApi(false), root })).rejects.toThrow(
      /Task Master must be on with auto-claim paused/,
    );
  });
});

describe("seedDemo sessions", () => {
  it("seeds sessions in four end states and one manual worktree session on a PR's branch", async () => {
    const root = mkdtempSync(path.join(dir, "seed-"));
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const api = async (url: string, init?: { body?: string }) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : {} });
      return { id: 1, taskMaster: { enabled: "on", autoClaimPaused: true } };
    };
    await seedDemo({ api, root });
    const sessions = calls.filter((c) => c.url === "/api/sessions").map((c) => c.body);
    expect(sessions.map((b) => b.name)).toEqual([
      "Add login rate limiting",
      "Speed up orders query",
      "Document the cookie lifetime",
      "Add a health endpoint",
      "Fix flaky login test",
      "Dark mode palette",
    ]);
    const palette = sessions.at(-1)!;
    expect(palette.worktree).toEqual({ baseRef: "main", branchName: "feat/dark-palette" });
    const script = readFileSync(String(palette.command), "utf8");
    expect(script).toContain("PostToolUse");
    expect(script).toContain("git worktree add");
    expect(script).toContain("-b feat/dark-palette");
  });
});
