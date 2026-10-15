import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isSessionUuid,
  listClaudeScratchEntries,
  loadLiveSessionIds,
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
    const live = await loadLiveSessionIds(base);
    expect(live).toEqual(new Set(["live", "legacy"]));
  });

  it("returns null when the registry is missing or malformed", async () => {
    expect(await loadLiveSessionIds(path.join(base, "nope"))).toBeNull();
    await fs.writeFile(path.join(base, "a.json"), "{");
    expect(await loadLiveSessionIds(base)).toBeNull();
    await fs.writeFile(path.join(base, "a.json"), JSON.stringify({ pid: "x" }));
    expect(await loadLiveSessionIds(base)).toBeNull();
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
    expect(await loadLiveSessionIds(base)).toEqual(new Set(["ns", "nodomain", "odd"]));
  });

  it("offers only UUID-named session dirs, never other state under claude-<uid>", async () => {
    const claude = path.join(base, "claude-1000");
    await fs.mkdir(path.join(claude, "proj", UUID), { recursive: true });
    await fs.writeFile(path.join(claude, "proj", "stray.txt"), "x");
    await fs.mkdir(path.join(claude, "bundled-skills", "2.1.299", "hash"), { recursive: true });
    await fs.mkdir(path.join(claude, "emptyhome"));
    await fs.writeFile(path.join(claude, "top.log"), "x");
    await fs.writeFile(path.join(claude, "proj", "plain-file"), "x");
    const entries = await listClaudeScratchEntries(claude);
    expect(entries).toEqual([{ fullPath: path.join(claude, "proj", UUID), sessionId: UUID }]);
  });
});
