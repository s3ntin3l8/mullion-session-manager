import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claudeSessionsDirsFor,
  defaultClaudeSessionsDir,
  isLivePidFile,
  isSessionUuid,
  loadLiveSessions,
  scanClaudeDir,
} from "../../src/services/claude-scratch.js";

const UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
let base: string;

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "claude-scratch-test-"));
});
afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

// A pidDomain in this process's own PID namespace, like Claude Code writes.
async function ownDomain(): Promise<string> {
  return `linux:test:${await fs.readlink("/proc/self/ns/pid")}`;
}

async function startTicks(): Promise<string> {
  const stat = await fs.readFile("/proc/self/stat", "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
}

describe("claude-scratch", () => {
  it("recognises session uuids", () => {
    expect(isSessionUuid(UUID)).toBe(true);
    expect(isSessionUuid("scratchpad")).toBe(false);
  });

  it("collects live session ids and drops dead pids and reused pids", async () => {
    const write = (name: string, body: unknown) =>
      fs.writeFile(path.join(base, name), JSON.stringify(body));
    const pidDomain = await ownDomain();
    await write("live.json", {
      pid: process.pid,
      sessionId: "live",
      procStart: await startTicks(),
      pidDomain,
    });
    await write("nostart.json", { pid: process.pid, sessionId: "legacy", pidDomain });
    await write("reused.json", {
      pid: process.pid,
      sessionId: "reused",
      procStart: "1",
      pidDomain,
    });
    await write("gone.json", {
      pid: 2 ** 22 + 12345,
      sessionId: "gone",
      procStart: "5",
      pidDomain,
    });
    await fs.writeFile(path.join(base, "ignored.txt"), "not json, but not a registry file");
    const live = await loadLiveSessions([base]);
    expect(live.ids).toEqual(new Set(["live", "legacy"]));
    expect(live.blocked).toBeUndefined();
  });

  it("blocks when the server's own registry is missing or has an unparseable file of a possibly running process", async () => {
    expect((await loadLiveSessions([path.join(base, "nope")])).blocked).toContain("nope");
    // Not named after a pid: nothing says it's dead.
    await fs.writeFile(path.join(base, "a.json"), "{");
    expect((await loadLiveSessions([base])).blocked).toContain("a.json");
    await fs.rm(path.join(base, "a.json"));
    // Named after a live pid (this process), so it may be a running session.
    await fs.writeFile(
      path.join(base, `${String(process.pid)}.json`),
      JSON.stringify({ pid: "x" }),
    );
    expect((await loadLiveSessions([base])).blocked).toContain("may be running");
  });

  it("skips an unparseable file whose pid is gone, with a warning, and keeps the rest", async () => {
    const deadPid = 2 ** 22 + 12345;
    await fs.writeFile(path.join(base, `${String(deadPid)}.json`), "{");
    await fs.writeFile(
      path.join(base, `${String(deadPid + 1)}.json`),
      JSON.stringify({ pid: "x" }),
    );
    await fs.writeFile(
      path.join(base, "live.json"),
      JSON.stringify({
        pid: process.pid,
        sessionId: "live",
        procStart: await startTicks(),
        pidDomain: await ownDomain(),
      }),
    );
    const live = await loadLiveSessions([base]);
    expect(live.blocked).toBeUndefined();
    expect(live.ids).toEqual(new Set(["live"]));
    // readdir order is filesystem-dependent: check both without relying on it.
    expect(live.warnings).toHaveLength(2);
    for (const pid of [deadPid, deadPid + 1]) {
      expect(live.warnings.filter((w) => w.includes(`${String(pid)}.json`))).toHaveLength(1);
    }
  });

  it("unions several registries; only the first must exist", async () => {
    const [a, b] = [path.join(base, "a"), path.join(base, "b")];
    await fs.mkdir(a);
    await fs.mkdir(b);
    const pidDomain = await ownDomain();
    const entry = (sessionId: string) =>
      JSON.stringify({ pid: process.pid, sessionId, procStart: "n/a", pidDomain });
    await fs.writeFile(path.join(a, "1.json"), entry("in-a"));
    await fs.writeFile(path.join(b, "1.json"), entry("in-b"));
    const gone = path.join(base, "gone");
    const notADir = path.join(base, "file");
    await fs.writeFile(notADir, "x");
    expect((await loadLiveSessions([a, b, gone, notADir])).ids).toEqual(new Set(["in-a", "in-b"]));
    // A missing first dir (an old Claude Code with no registry at all) blocks...
    expect((await loadLiveSessions([gone, a])).blocked).toBeDefined();
    // ...and a bad file in a later dir is just as unknown as in the first.
    await fs.writeFile(path.join(b, "bad.json"), "{");
    expect((await loadLiveSessions([a, b])).blocked).toContain("bad.json");
  });

  describe("versions in use", () => {
    let procDir: string;
    beforeEach(async () => {
      procDir = path.join(base, "proc");
      await fs.mkdir(procDir);
    });

    it("collects registry versions, and marks the set incomplete when one is missing", async () => {
      const pidDomain = await ownDomain();
      const write = (name: string, body: object) =>
        fs.writeFile(path.join(base, name), JSON.stringify({ pidDomain, ...body }));
      await write("a.json", {
        pid: process.pid,
        sessionId: "a",
        procStart: "n/a",
        version: "2.1.9",
      });
      const withVersion = await loadLiveSessions([base], { procDir });
      expect(withVersion.versions).toEqual(new Set(["2.1.9"]));
      expect(withVersion.versionsComplete).toBe(true);
      await write("b.json", { pid: process.pid, sessionId: "b", procStart: "n/a" });
      expect((await loadLiveSessions([base], { procDir })).versionsComplete).toBe(false);
    });

    it("adds the versions of running claude binaries, even a replaced one", async () => {
      const exe = (pid: string, target: string) =>
        fs
          .mkdir(path.join(procDir, pid), { recursive: true })
          .then(() => fs.symlink(target, path.join(procDir, pid, "exe")));
      await exe("11", "/h/.local/share/claude/versions/2.1.301");
      await exe("12", "/h/.local/share/claude/versions/2.1.302 (deleted)");
      await exe("13", "/usr/bin/node");
      await fs.mkdir(path.join(procDir, "self"));
      const live = await loadLiveSessions([base], { procDir });
      expect(live.versions).toEqual(new Set(["2.1.301", "2.1.302"]));
      expect(live.versionsComplete).toBe(true);
      const idsOnly = await loadLiveSessions([base], { procDir, includeBinaries: false });
      expect(idsOnly.versions.size).toBe(0);
    });

    it("marks the set incomplete when /proc can't be listed", async () => {
      const live = await loadLiveSessions([base], { procDir: path.join(base, "no-proc") });
      expect(live.versionsComplete).toBe(false);
    });
  });

  it("treats unverifiable entries as running: other PID namespace, no pidDomain, odd procStart", async () => {
    const write = (name: string, body: unknown) =>
      fs.writeFile(path.join(base, name), JSON.stringify(body));
    await write("ns.json", { pid: 1, sessionId: "ns", pidDomain: "linux:x:pid:[1]" });
    // Not written by a Claude Code whose pid we can verify: even a dead pid and
    // a mismatching procStart can't prove it's gone.
    await write("nodomain.json", { pid: 2 ** 22 + 12345, sessionId: "nodomain", procStart: "1" });
    await write("odd.json", {
      pid: process.pid,
      sessionId: "odd",
      procStart: "n/a",
      pidDomain: await ownDomain(),
    });
    expect((await loadLiveSessions([base])).ids).toEqual(new Set(["ns", "nodomain", "odd"]));
  });

  it("sorts claude-<uid> by what can vouch for each entry", async () => {
    const claude = path.join(base, "claude-1000");
    await fs.mkdir(path.join(claude, "-home-me-proj", UUID), { recursive: true });
    await fs.writeFile(path.join(claude, "-home-me-proj", "stray.txt"), "x");
    await fs.mkdir(path.join(claude, "-home-me-empty"));
    await fs.mkdir(path.join(claude, "-home-me-locks"));
    await fs.writeFile(path.join(claude, "-home-me-locks", "tasks.lock"), "x");
    await fs.mkdir(path.join(claude, "bundled-skills", "2.1.299", "hash"), { recursive: true });
    await fs.writeFile(path.join(claude, "bundled-skills", "README"), "x");
    await fs.mkdir(path.join(claude, "emptyhome", ".config"), { recursive: true });
    await fs.mkdir(path.join(claude, "next-branch"));
    // Not slug-named, but it holds a session: a project, never "loose".
    await fs.mkdir(path.join(claude, "odd-proj", UUID), { recursive: true });
    await fs.writeFile(path.join(claude, "top.log"), "x");
    const scan = await scanClaudeDir(claude);
    const rel = (p: string) => path.relative(claude, p);
    expect(scan.sessions.map((e) => [rel(e.fullPath), e.sessionId]).sort()).toEqual([
      [path.join("-home-me-proj", UUID), UUID],
      [path.join("odd-proj", UUID), UUID],
    ]);
    expect(scan.emptyProjects.map(rel)).toEqual(["-home-me-empty"]);
    expect(scan.bundledVersions.map((v) => [rel(v.fullPath), v.version])).toEqual([
      [path.join("bundled-skills", "2.1.299"), "2.1.299"],
    ]);
    expect(scan.loose.map(rel).sort()).toEqual(["next-branch", "top.log"]);
  });

  it("recognises a *.pid file naming a running process, and nothing else", async () => {
    const write = (name: string, body: string) => fs.writeFile(path.join(base, name), body);
    await write("live.pid", `${String(process.pid)}\n`);
    await write("dead.pid", String(2 ** 22 + 12345));
    await write("junk.pid", "not a pid");
    await write("live.log", String(process.pid));
    expect(await isLivePidFile(path.join(base, "live.pid"))).toBe(true);
    expect(await isLivePidFile(path.join(base, "dead.pid"))).toBe(false);
    expect(await isLivePidFile(path.join(base, "junk.pid"))).toBe(false);
    expect(await isLivePidFile(path.join(base, "live.log"))).toBe(false);
    // A link or a directory is not a pid file, however it is named.
    await fs.symlink(path.join(base, "live.pid"), path.join(base, "link.pid"));
    await fs.mkdir(path.join(base, "dir.pid"));
    expect(await isLivePidFile(path.join(base, "link.pid"))).toBe(false);
    expect(await isLivePidFile(path.join(base, "dir.pid"))).toBe(false);
    // Unreadable or missing: can't tell, so leave it.
    expect(await isLivePidFile(path.join(base, "missing.pid"))).toBe(true);
  });

  it("derives registry dirs from the server default plus each session's CLAUDE_CONFIG_DIR", () => {
    const env = (value: unknown) => JSON.stringify({ CLAUDE_CONFIG_DIR: value });
    expect(
      claudeSessionsDirsFor([
        env("/work/claude"),
        env("/work/claude"),
        env("/other/"),
        env("relative/dir"),
        env(""),
        env(7),
        JSON.stringify({ OTHER: "x" }),
        "not json",
        "null",
        null,
      ]),
    ).toEqual([
      defaultClaudeSessionsDir(),
      path.join("/work/claude", "sessions"),
      path.join("/other", "sessions"),
    ]);
    expect(claudeSessionsDirsFor([])).toEqual([defaultClaudeSessionsDir()]);
  });
});
