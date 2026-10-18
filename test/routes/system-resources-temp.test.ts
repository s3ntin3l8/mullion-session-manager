import { describe, expect, it, vi } from "vitest";

const inspectTempStorage = vi.fn(async (..._args: unknown[]) => ({ available: true }));
const pruneTempStorage = vi.fn(async (_mode?: string) => ({ output: "", reclaimedBytes: 7 }));
const pruneOptions = vi.fn((_options?: unknown) => undefined);
vi.mock("../../src/services/temp-storage.js", () => ({
  inspectTempStorage: (...args: unknown[]) => inspectTempStorage(...args),
  pruneTempStorage: (mode?: string, options?: unknown) => {
    pruneOptions(options);
    return pruneTempStorage(mode);
  },
}));

import path from "node:path";
import { projects, sessions } from "../../src/db/schema.js";
import { defaultClaudeSessionsDir } from "../../src/services/claude-scratch.js";
import { buildTestApp } from "../helpers/app.js";

describe("/api/storage/temp", () => {
  it("consults the registry of every config dir an active session runs with", async () => {
    inspectTempStorage.mockClear();
    const app = await buildTestApp();
    const { lastInsertRowid } = app.db
      .insert(projects)
      .values({ name: "p", cwd: "/tmp/p-registry-dirs" })
      .run();
    const projectId = Number(lastInsertRowid);
    const remote = app.db
      .insert(projects)
      .values({ name: "r", cwd: "/tmp/r-registry-dirs", hostId: "remote-1" })
      .run();
    const env = (dir: string) => JSON.stringify({ CLAUDE_CONFIG_DIR: dir });
    app.db
      .insert(sessions)
      .values([
        { projectId, command: "claude", cwd: "/tmp", env: env("/work/active") },
        { projectId, command: "claude", cwd: "/tmp", env: env("/work/dead"), status: "killed" },
        { projectId, command: "claude", cwd: "/tmp", env: env("/work/exited"), status: "exited" },
        { projectId, command: "claude", cwd: "/tmp" },
        {
          projectId: Number(remote.lastInsertRowid),
          command: "claude",
          cwd: "/tmp",
          env: env("/work/remote"),
        },
      ])
      .run();
    const expected = {
      claudeSessionsDirs: [defaultClaudeSessionsDir(), path.join("/work/active", "sessions")],
    };
    await app.inject({ method: "GET", url: "/api/storage/temp" });
    expect(inspectTempStorage).toHaveBeenLastCalledWith(expected);
  });

  it("answers 'measuring' at once for a slow walk and never starts a second one", async () => {
    inspectTempStorage.mockClear();
    let finish!: (value: { available: boolean }) => void;
    inspectTempStorage.mockImplementationOnce(
      () => new Promise<{ available: boolean }>((resolve) => (finish = resolve)),
    );
    const app = await buildTestApp();
    const started = Date.now();
    const first = await app.inject({ method: "GET", url: "/api/storage/temp" });
    // Waits out the probe's short grace period, never the walk itself.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(first.json()).toEqual({ state: "measuring", measuredAt: null });

    // A poll and a Refresh click while it is still running share that one walk.
    await app.inject({ method: "GET", url: "/api/storage/temp" });
    await app.inject({ method: "GET", url: "/api/storage/temp?refresh=1" });
    expect(inspectTempStorage).toHaveBeenCalledTimes(1);

    finish({ available: true });
    await new Promise((resolve) => setImmediate(resolve));
    const done = await app.inject({ method: "GET", url: "/api/storage/temp" });
    expect(done.json()).toMatchObject({ available: true, state: "ready" });
    expect(done.json().measuredAt).toEqual(expect.any(String));
    expect(inspectTempStorage).toHaveBeenCalledTimes(1);
  });

  it("re-measures on ?refresh=1 once the last walk has finished", async () => {
    inspectTempStorage.mockClear();
    const app = await buildTestApp();
    await app.inject({ method: "GET", url: "/api/storage/temp" });
    await app.inject({ method: "GET", url: "/api/storage/temp?refresh=1" });
    expect(inspectTempStorage).toHaveBeenCalledTimes(2);
  });
});
