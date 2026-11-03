import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { gitEnv } from "../../scripts/git-env.mjs";
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
    // pty-manager.ts's SUSTAINED_SILENCE_MS: what governs a hookless `.sh` demo
    // script. Past it, "Gone quiet" would depend on how the output streaks fall.
    expect(IDLE_KEEPALIVE_INTERVAL_S).toBeLessThan(10);
    expect(IDLE_KEEPALIVE_INTERVAL_S).toBeGreaterThan(KEEPALIVE_INTERVAL_S);
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
    const script = (name: string) =>
      readFileSync(String(sessions.find((b) => b.name === name)!.command), "utf8");
    expect(script("Document the cookie lifetime")).toContain("claude-code Notification");
    expect(script("Add a health endpoint")).toContain("claude-code Stop");
    expect(script("Add a health endpoint")).toContain(`sleep ${IDLE_KEEPALIVE_INTERVAL_S}; done`);
    expect(script("Fix flaky login test").trimEnd().endsWith("exit 0")).toBe(true);
    const palette = sessions.at(-1)!;
    expect(palette.worktree).toEqual({ baseRef: "main", branchName: "feat/dark-palette" });
    const paletteScript = script("Dark mode palette");
    expect(paletteScript).toContain("PostToolUse");
    expect(paletteScript).toContain("git worktree add");
    expect(paletteScript).toContain("-b feat/dark-palette");
  });
});

describe("seedDemo git depth and dock", () => {
  it("gives aurora-web branches, a worktree, a dev-server port and a dock control", async () => {
    const root = mkdtempSync(path.join(dir, "seed-"));
    const calls: { url: string; method?: string; body: Record<string, unknown> }[] = [];
    const api = async (url: string, init?: { method?: string; body?: string }) => {
      calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(init.body) : {} });
      return { id: 1, taskMaster: { enabled: "on", autoClaimPaused: true } };
    };
    await seedDemo({ api, root });
    const aurora = path.join(root, "aurora-web");
    const tracks = execFileSync(
      "git",
      ["for-each-ref", "--format=%(refname:short) %(upstream:track)", "refs/heads"],
      { cwd: aurora, env: gitEnv() },
    ).toString();
    expect(tracks).toContain("feat/ahead [ahead 1]");
    expect(tracks).toContain("feat/behind [behind 1]");
    expect(tracks).toContain("feat/gone [gone]");
    expect(existsSync(path.join(aurora, ".mullion-worktrees", "feat-search-filters"))).toBe(true);
    expect(existsSync(path.join(aurora, ".crs", "dock.json"))).toBe(true);
    const patch = calls.find((c) => c.method === "PATCH" && c.url.startsWith("/api/projects/"));
    // The palette session asks the server to create its own worktree; a
    // pre-made branch or path of that name would make the server refuse it.
    expect(existsSync(path.join(aurora, ".mullion-worktrees", "feat-dark-palette"))).toBe(false);
    expect(tracks).not.toContain("feat/dark-palette");
    expect(patch?.body).toEqual({ devServerUrl: "3958" });
  });
});

describe("agentTranscriptScript leadMs", () => {
  it("pauses after the release, before the first line", () => {
    const script = agentTranscriptScript({
      lines: ["first"],
      releaseFile: "/tmp/x.release",
      leadMs: 2500,
    });
    const release = script.indexOf("while [ ! -e");
    const lead = script.indexOf("sleep 2.50");
    expect(release).toBeGreaterThan(-1);
    expect(lead).toBeGreaterThan(release);
    expect(lead).toBeLessThan(script.indexOf("echo 'first'"));
  });

  it("adds no pause by default", () => {
    expect(agentTranscriptScript({ lines: ["a"] })).not.toMatch(/sleep 0\.00|sleep 2/);
  });
});

describe("seedDemo held sessions", () => {
  const sessionsFor = async (opts: { holdTranscripts?: boolean; now?: number }) => {
    const root = mkdtempSync(path.join(dir, "seed-"));
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const api = async (url: string, init?: { body?: string }) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : {} });
      return { id: 1, taskMaster: { enabled: "on", autoClaimPaused: true } };
    };
    const seeded = await seedDemo({ api, root, ...opts });
    return { calls, seeded };
  };

  it("seeds the mobile and loop sessions only when holding", async () => {
    const held = await sessionsFor({ holdTranscripts: true });
    const names = held.calls.filter((c) => c.url === "/api/sessions").map((c) => c.body.name);
    expect(names).toContain("mobile demo");
    expect(names.filter((n) => n === "Add login rate limiting")).toHaveLength(2);
    const loop = readFileSync(path.join(held.seeded.scriptsDir, "loop-demo.sh"), "utf8");
    expect(loop).toContain("loop-demo.release");
    expect(loop).toMatch(/sleep 3\.00/);
    expect(readFileSync(path.join(held.seeded.scriptsDir, "mobile-demo.sh"), "utf8")).toContain(
      "mobile-demo.release",
    );

    const plain = await sessionsFor({});
    const plainNames = plain.calls.filter((c) => c.url === "/api/sessions").map((c) => c.body.name);
    expect(plainNames).not.toContain("mobile demo");
    expect(plainNames.filter((n) => n === "Add login rate limiting")).toHaveLength(1);
  });

  it("counts the fixture tasks' timestamps back from `now`", async () => {
    const now = Date.parse("2026-10-01T09:00:00Z");
    const { calls } = await sessionsFor({ now });
    const stamps = calls
      .filter((c) => c.url === "/api/demo/fixtures/tasks")
      .flatMap((c) => c.body.tasks as Record<string, unknown>[])
      .flatMap((t) => [t.claimedAt, t.startedAt])
      .filter((v): v is string => typeof v === "string");
    expect(stamps.length).toBeGreaterThan(0);
    for (const stamp of stamps) expect(Date.parse(stamp)).toBeLessThan(now);
    // 80 minutes before `now`: the orbit task's claim.
    expect(stamps).toContain("2026-10-01T07:40:00.000Z");
  });
});
