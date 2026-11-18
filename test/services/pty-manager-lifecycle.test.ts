// PtyManager lifecycle — kill(), terminate(), the stashed seed, list() and killAll().
//
// Split out of the former test/services/pty-manager.test.ts (issue #3277) —
// that file sat at the file-size ratchet's ceiling, so a change here could no
// longer land next to the tests it belongs with. The shared mock preamble and
// helpers live in test/helpers/pty-manager-harness.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  bundleSyncMock,
  cgroupInventoryMock,
  childProcessMock,
  createPtyManagerFixture,
  destroyPtyManagerFixture,
  fakePtyChildren,
  nodePtyMock,
  ownedLine,
  resetPtyManagerMocks,
  scopeMocks,
  waitForSpawn,
} from "../helpers/pty-manager-harness.js";
import { spawn as spawnChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { sessionWorkflowConventionsPath } from "../../src/services/workflow-conventions.js";

vi.mock("node-pty", () => nodePtyMock());
vi.mock("../../src/services/bundle-sync.js", () => bundleSyncMock());
vi.mock("node:child_process", async (importOriginal) => childProcessMock(await importOriginal()));
vi.mock("../../src/services/cgroup-inventory.js", () => cgroupInventoryMock());

const { PtyManager } = await import("../../src/services/pty-manager.js");

describe("PtyManager", () => {
  let sessionsDir: string;
  let manager: InstanceType<typeof PtyManager>;

  beforeEach(() => {
    // Every test starts from a clean slate: no fake PTYs, no `systemctl`
    // fixtures and no cgroup-inventory call log left over from a sibling.
    resetPtyManagerMocks();
    ({ sessionsDir, manager } = createPtyManagerFixture(PtyManager));
  });

  afterEach(async () => {
    await destroyPtyManagerFixture({ sessionsDir, manager });
  });

  it("kill() only kills our tracked client, not conceptually the whole session", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    manager.kill("1");
    expect(fakePtyChildren[0].killed).toBe(true);
    expect(session.isAlive).toBe(false);
    expect(manager.get("1")).toBeUndefined();
  });

  it("terminate() stops the session's systemd scope in addition to killing our tracked client", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    // Issue #1140 (PR 1) — terminate()'s stopScope() now confirms ownership
    // via a listing before stopping anything; without a matching row here it
    // would correctly no-op (see the "never stops another instance's scope"
    // coverage in session-process.test.ts) rather than stop blindly.
    scopeMocks.listUnitsReply = [ownedLine("1", sessionsDir)];

    await manager.terminate("1");

    expect(fakePtyChildren[0].killed).toBe(true);
    expect(manager.get("1")).toBeUndefined();
    // Deterministic, id-derived scope name — this is what lets terminate()
    // fully end a session's master + program even when nothing about it is
    // tracked in this process's memory (e.g. right after a restart).
    expect(vi.mocked(spawnChildProcess)).toHaveBeenCalledWith(
      "systemctl",
      ["--user", "stop", "crs-session-1.scope"],
      expect.objectContaining({ stdio: "ignore" }),
    );
  });

  // Issue #937 follow-up — writeSessionWorkflowConventions (launch-plan.ts)
  // writes this file unconditionally at spawn time; terminate() is the
  // genuinely-terminal moment nothing else cleans it up, same shape as the
  // pre-existing agent-guide/briefing leak #405 already fixed.
  it("terminate() removes the session's own workflow-conventions copy, if one was written", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    const conventionsPath = sessionWorkflowConventionsPath(sessionsDir, "1");
    fs.writeFileSync(conventionsPath, "Never commit directly to the default branch.");
    expect(fs.existsSync(conventionsPath)).toBe(true);

    scopeMocks.listUnitsReply = [ownedLine("1", sessionsDir)];
    await manager.terminate("1");

    expect(fs.existsSync(conventionsPath)).toBe(false);
  });

  it("terminate() does not throw when the session had no workflow-conventions copy (opted out, or no global text configured)", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    expect(fs.existsSync(sessionWorkflowConventionsPath(sessionsDir, "1"))).toBe(false);

    scopeMocks.listUnitsReply = [ownedLine("1", sessionsDir)];
    await expect(manager.terminate("1")).resolves.not.toThrow();
  });

  it("terminate() stops the scope even when the session was never tracked in this process", async () => {
    // Simulates deleting a session in a fresh process that hasn't re-attached
    // to it yet — the real gap found during M2's E2E verification.
    scopeMocks.listUnitsReply = [ownedLine("42", sessionsDir)];

    await manager.terminate("42");

    expect(vi.mocked(spawnChildProcess)).toHaveBeenCalledWith(
      "systemctl",
      ["--user", "stop", "crs-session-42.scope"],
      expect.objectContaining({ stdio: "ignore" }),
    );
  });

  // Issue #1140 (PR 1) — the OTHER half of #1137: terminate() must never
  // stop a scope it hasn't confirmed this instance owns, even when the
  // legacy unit name matches — that would kill a live session belonging to
  // a DIFFERENT Mullion instance on the same host.
  it("terminate() does not stop a same-named scope owned by a different instance's sessionsDir", async () => {
    scopeMocks.listUnitsReply = [ownedLine("1", "/some/other/instances/sessions")];

    // spawnChildProcess is a module-level mock shared across this whole
    // test file (not reset per-test — see the A10 test above's identical
    // note) — snapshot the call count first and only inspect calls made by
    // THIS test, since an earlier test's own legitimate
    // `systemctl stop crs-session-1.scope` call would otherwise still be
    // sitting in the full cross-test history and produce a false pass here.
    const callsBefore = vi.mocked(spawnChildProcess).mock.calls.length;

    await manager.terminate("1");

    const callsDuringThisTest = vi.mocked(spawnChildProcess).mock.calls.slice(callsBefore);
    expect(callsDuringThisTest).not.toContainEqual([
      "systemctl",
      ["--user", "stop", "crs-session-1.scope"],
      expect.anything(),
    ]);
  });

  // A8 — state-file lifecycle: lost on restart, resurrected on delete.
  it("kill() flushes pending dirty state immediately, not after the 5s debounce (A8)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      const filePath = path.join(sessionsDir, "1.state.json");

      // Dirty the state (schedules the normal 5s debounced write) without
      // ever letting that timer fire on its own.
      session.emitHookEvent({ kind: "permission_request", tool: "Bash", summary: "Run ls" });
      expect(session.toInfo().permissionState).toBe("pending");
      expect(fs.existsSync(filePath)).toBe(false);

      // Before the fix, both stateFileTimeout and stateFileCeilingTimeout
      // are .unref()'d and kill() never flushed — so a `systemctl --user
      // restart` (which drains the event loop, exactly what killAll() on
      // shutdown simulates here) would silently drop this pending
      // permissionState. manager.kill() must flush synchronously instead
      // of relying on the debounce timer to get there first.
      manager.kill("1");

      expect(fs.existsSync(filePath)).toBe(true);
      const written = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
        state: { permissionState: string };
      };
      expect(written.state.permissionState).toBe("pending");
    } finally {
      vi.useRealTimers();
    }
  });

  it("terminate() leaves no resurrected state file even after waiting past the old 5s debounce window (A8)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      const filePath = path.join(sessionsDir, "1.state.json");

      // Dirty the state so there's something for a stray write to
      // resurrect, then terminate. terminate() -> kill() -> ptyProcess.kill()
      // triggers the fake pty's onExit synchronously, which (before the
      // fix) re-dirties the session via emitEvent("status_change") and
      // arms a BRAND NEW 5s timer after kill()'s own flush already ran —
      // that timer would fire after terminate()'s own unlinkSync below,
      // resurrecting the file terminate() just deleted.
      session.emitHookEvent({ kind: "permission_request", tool: "Bash", summary: "Run ls" });

      await manager.terminate("1");

      expect(fs.existsSync(filePath)).toBe(false);

      // Advance well past both the old 5s debounce and the 30s ceiling —
      // before the fix, a leftover timer would fire in here and recreate
      // the file for a session that no longer exists.
      await vi.advanceTimersByTimeAsync(35_000);

      expect(fs.existsSync(filePath)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // B9 — a seed stashed for the promote flow (stashSeed) must not leak
  // forever when `id` is genuinely done (terminate(), the exited-session
  // reconciler, a spawn-failure rollback) before its SessionStart hook ever
  // fires and consumes it (consumeSeed) — but a plain kill()/killAll() must
  // NOT discard it, since killAll() is reached on a graceful shutdown/
  // redeploy, where the dtach master and program (and so a still-pending
  // SessionStart hook) survive. Independent review on PR #587 caught an
  // earlier version of this fix clearing it unconditionally inside kill()
  // itself, which would have silently lost a seed on every redeploy.
  it("kill() alone (the killAll()-reachable path) does NOT clear a stashed seed", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    manager.stashSeed("1", "some initial prompt");
    manager.kill("1");

    expect(manager.consumeSeed("1")).toBe("some initial prompt");
  });

  it("killAll() (the redeploy/shutdown path) does NOT clear a stashed seed", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    manager.stashSeed("1", "some initial prompt");
    manager.killAll();

    expect(manager.consumeSeed("1")).toBe("some initial prompt");
  });

  it("discardPendingSeed() explicitly clears a stashed-but-never-consumed seed", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    manager.stashSeed("1", "some initial prompt");
    manager.kill("1");
    manager.discardPendingSeed("1");

    // consumeSeed is single-use and destructive, so calling it once already
    // proves whether anything was left.
    expect(manager.consumeSeed("1")).toBeNull();
  });

  it("terminate() discards a stashed seed (it's a genuinely terminal call, unlike kill() alone)", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    manager.stashSeed("1", "some initial prompt");
    await manager.terminate("1");

    expect(manager.consumeSeed("1")).toBeNull();
  });

  it("discardPendingSeed() does not clear an unrelated session's stashed seed", async () => {
    const a = manager.getOrCreate({ id: "1", cwd: "/tmp", command: "bash", cols: 80, rows: 24 });
    const b = manager.getOrCreate({ id: "2", cwd: "/tmp", command: "bash", cols: 80, rows: 24 });
    await waitForSpawn(a);
    await waitForSpawn(b);

    manager.stashSeed("1", "seed for session 1");
    manager.stashSeed("2", "seed for session 2");
    manager.kill("1");
    manager.discardPendingSeed("1");

    expect(manager.consumeSeed("1")).toBeNull();
    expect(manager.consumeSeed("2")).toBe("seed for session 2");
  });

  it("list() reports alive state and subscriber counts", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);
    session.onData(() => {});

    const [info] = manager.list();
    expect(info).toMatchObject({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      alive: true,
      subscriberCount: 1,
    });
  });

  it("killAll() kills every tracked session", async () => {
    const a = manager.getOrCreate({ id: "1", cwd: "/tmp", command: "bash", cols: 80, rows: 24 });
    const b = manager.getOrCreate({ id: "2", cwd: "/tmp", command: "bash", cols: 80, rows: 24 });
    await waitForSpawn(a);
    await waitForSpawn(b);

    manager.killAll();
    expect(fakePtyChildren.every((c) => c.killed)).toBe(true);
    expect(manager.list()).toHaveLength(0);
  });
});
