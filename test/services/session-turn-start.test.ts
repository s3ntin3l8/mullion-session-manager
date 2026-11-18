import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discoverTurnStarted } from "../../src/services/session-turn-start.js";
import type { TurnStartSearch } from "../../src/services/session-turn-start.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
async function setup(format: TurnStartSearch["format"] = "codex") {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "turn-start-"));
  dirs.push(home);
  const root = path.join(home, "sessions");
  await fs.mkdir(root);
  const search: TurnStartSearch = {
    format,
    roots: [root],
    cwd: "/work/task",
    since: Date.now() - 60_000,
  };
  const write = async (lines: unknown[], file = path.join(root, "rollout.jsonl")) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    return file;
  };
  const meta = (cwd = search.cwd, timestamp = new Date().toISOString()) => ({
    type: "session_meta",
    payload: { cwd, timestamp },
  });
  return { home, root, search, write, meta };
}

describe("hook-independent turn discovery", () => {
  it("finds a rollout under Codex's date tree before any output", async () => {
    const { root, search, write, meta } = await setup();
    await write([meta()], path.join(root, "2026", "11", "18", "rollout.jsonl"));
    expect(await discoverTurnStarted(search)).toBe(true);
  });
  it("ignores other cwds and files older than the worker", async () => {
    const { root, search, write, meta } = await setup();
    await write([meta("/other")]);
    const old = await write([meta()], path.join(root, "old.jsonl"));
    await fs.utimes(old, new Date(0), new Date(0));
    expect(await discoverTurnStarted(search)).toBe(false);
  });
  it("observes a resumed Codex turn in an older rollout", async () => {
    const { search, write, meta } = await setup();
    await write([
      meta(search.cwd, new Date(0).toISOString()),
      {
        type: "event_msg",
        timestamp: new Date().toISOString(),
        payload: { type: "user_message", message: "seed" },
      },
    ]);
    expect(await discoverTurnStarted(search)).toBe(true);
  });
  it("does not treat old Codex metadata alone as a new turn", async () => {
    const { search, write, meta } = await setup();
    await write([meta(search.cwd, new Date(0).toISOString())]);
    expect(await discoverTurnStarted(search)).toBe(false);
  });
  it.each([{}, { type: "session_meta", payload: { cwd: "/work/task" } }])(
    "fails open on malformed rollout metadata %j",
    async (line) => {
      const { search, write } = await setup();
      await write([line]);
      expect(await discoverTurnStarted(search)).toBeNull();
    },
  );
  it("fails open on a symlink rather than following it", async () => {
    const { root, search, write, meta } = await setup();
    const target = await write([meta()]);
    await fs.symlink(target, path.join(root, "alias.jsonl"));
    expect(await discoverTurnStarted(search)).toBeNull();
  });
  it("distinguishes absent sessions from an unreadable configuration root", async () => {
    const { root, search } = await setup();
    await fs.rm(root, { recursive: true });
    expect(await discoverTurnStarted(search)).toBe(false);
    expect(
      await discoverTurnStarted({ ...search, roots: [path.join(root, "sessions")] }),
    ).toBeNull();
    expect(await discoverTurnStarted({ ...search, roots: [] })).toBeNull();
  });
  it("requires a Claude user turn, not assistant output or an old turn", async () => {
    const { search, write } = await setup("claude-code");
    await write([
      { type: "assistant", timestamp: new Date().toISOString(), message: { content: "hello" } },
      { type: "user", timestamp: new Date(0).toISOString(), message: { content: "old" } },
    ]);
    expect(await discoverTurnStarted(search)).toBe(false);
    await write([
      { type: "user", timestamp: new Date().toISOString(), message: { content: "seed" } },
    ]);
    expect(await discoverTurnStarted(search)).toBe(true);
  });
  it("treats a user turn without a timestamp as evidence, never an absent turn", async () => {
    const { search, write } = await setup("claude-code");
    await write([{ type: "user", message: { content: "seed" } }]);
    expect(await discoverTurnStarted(search)).toBe(true);
  });
  it("recognizes a rollout whose cwd is the canonical form of the launch path", async () => {
    const { home, search, write, meta } = await setup();
    const work = path.join(home, "work");
    const alias = path.join(home, "alias");
    await fs.mkdir(work);
    await fs.symlink(work, alias);
    await write([meta(work)]);
    expect(await discoverTurnStarted({ ...search, cwd: alias })).toBe(true);
  });
});
