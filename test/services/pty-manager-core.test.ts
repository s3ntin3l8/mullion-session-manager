// PtyManager core — the first spawn, the bootstrapMaster classifications, and the reuse/respawn rules.
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
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deriveInstanceId } from "../../src/services/session-process.js";

vi.mock("node-pty", () => nodePtyMock());
vi.mock("../../src/services/bundle-sync.js", () => bundleSyncMock());
vi.mock("node:child_process", async (importOriginal) => childProcessMock(await importOriginal()));
vi.mock("../../src/services/cgroup-inventory.js", () => cgroupInventoryMock());

const { PtyManager, getSkipPermissionFlag } = await import("../../src/services/pty-manager.js");

describe("getSkipPermissionFlag", () => {
  it("returns the flag for a bare binary name", () => {
    expect(getSkipPermissionFlag("claude")).toBe("--dangerously-skip-permissions");
    expect(getSkipPermissionFlag("codex")).toBe("--dangerously-bypass-approvals-and-sandbox");
    expect(getSkipPermissionFlag("opencode")).toBe("--auto");
    expect(getSkipPermissionFlag("gemini")).toBe("--approval-mode yolo");
    expect(getSkipPermissionFlag("agy")).toBe("--dangerously-skip-permissions --mode accept-edits");
  });

  it("returns the flag for a path-qualified binary", () => {
    expect(getSkipPermissionFlag("/usr/local/bin/claude")).toBe("--dangerously-skip-permissions");
    expect(getSkipPermissionFlag("/home/user/.local/bin/opencode")).toBe("--auto");
  });

  it("returns the flag when followed by arguments", () => {
    expect(getSkipPermissionFlag("claude --resume")).toBe("--dangerously-skip-permissions");
    expect(getSkipPermissionFlag("gemini -m gemini-3-pro-preview")).toBe("--approval-mode yolo");
  });

  it("returns null for a shell metacharacter chain", () => {
    expect(getSkipPermissionFlag("claude; echo hi")).toBeNull();
    expect(getSkipPermissionFlag("claude | grep foo")).toBeNull();
    expect(getSkipPermissionFlag("echo foo & claude")).toBeNull();
    expect(getSkipPermissionFlag("claude > out.txt")).toBeNull();
  });

  it("returns null for a non-agent command", () => {
    expect(getSkipPermissionFlag("bash")).toBeNull();
    expect(getSkipPermissionFlag("npm run dev")).toBeNull();
    expect(getSkipPermissionFlag("zsh")).toBeNull();
  });

  it("returns null for an unknown agent", () => {
    expect(getSkipPermissionFlag("pi")).toBeNull();
    expect(getSkipPermissionFlag("unknown-tool")).toBeNull();
  });

  it("handles leading/trailing whitespace", () => {
    expect(getSkipPermissionFlag("  claude  ")).toBe("--dangerously-skip-permissions");
  });
});

describe("PtyManager", () => {
  let sessionsDir: string;
  let manager: InstanceType<typeof PtyManager>;

  beforeEach(() => {
    // Every test starts from a clean slate: no fake PTYs, no `systemctl`
    // fixtures and no cgroup-inventory call log left over from a sibling.
    resetPtyManagerMocks();
    ({ sessionsDir, manager } = createPtyManagerFixture(PtyManager));
  });

  afterEach(() => {
    destroyPtyManagerFixture({ sessionsDir, manager });
  });

  // Issue #1734 — the codex home the rollout path is looked for under.
  describe("the codex home beside the rollout path (issue #1734)", () => {
    it("resolves the home from the SESSION's own environment", () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
        env: { CODEX_HOME: "/opt/session-home" },
      });
      session.setCodexTranscriptPath("/opt/session-home/sessions/rollout-x.jsonl");
      expect(session.codexHome()).toBe("/opt/session-home");
    });

    it("a restored home wins over the one the path setter resolves", () => {
      // The restore order is: path first (which resolves a home of its own
      // from the env), then the persisted home. The persisted one must win —
      // it is the home the session's codex actually ran under, and the
      // session's own (unpersisted) environment can no longer tell us.
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
        env: { CODEX_HOME: "/opt/backend-home" },
      });
      session.setCodexTranscriptPath("/opt/persisted-home/sessions/rollout-x.jsonl");
      session.setCodexTranscriptHome("/opt/persisted-home");
      expect(session.codexHome()).toBe("/opt/persisted-home");
    });

    it("re-resolves the home when a NEW path arrives", () => {
      // A different path means a different codex process — the agent was
      // restarted inside the same PTY, possibly under a different
      // CODEX_HOME. Keeping the old home would reject the new path, and the
      // session would silently stop being watched.
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      session.setCodexTranscriptPath("/opt/home-a/sessions/rollout-x.jsonl");
      session.setCodexTranscriptHome("/opt/home-a");
      expect(session.codexHome()).toBe("/opt/home-a");

      // Asserted EXACTLY, not "not the old one": `not.toBe` would also pass
      // for undefined, "" or any other wrong value, so it proves nothing
      // about what the new path actually resolves to. With no session env and
      // no CODEX_HOME in the backend's env, the fallback is `~/.codex`.
      session.setCodexTranscriptPath("/opt/home-b/sessions/rollout-y.jsonl");
      expect(session.codexHome()).toBe(path.join(os.homedir(), ".codex"));
    });
  });

  it("creates and spawns a session on first getOrCreate", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    expect(fakePtyChildren).toHaveLength(1);
    expect(session.isAlive).toBe(true);
  });

  // A10 — an inconclusive socket probe must not unlink a live dtach socket.
  it("does not unlink or bootstrap a socket whose probe is merely inconclusive, not confirmed dead (A10)", async () => {
    // Real-world "unknown" is either the 2s probe timeout or a non-
    // ECONNREFUSED connect error (EACCES, ENOTSOCK, ...) — see
    // unix-socket.ts's own doc comment. Rather than depend on which syscall
    // error a plain regular file happens to produce on any given OS/kernel
    // (not portable, and not the point of this test), force the exact
    // "unknown" outcome directly and assert on spawnInternal()'s reaction to
    // it — the same "assert on the SUT's behavior, not on OS plumbing"
    // approach the rest of this file already uses for `systemctl` replies
    // via scopeMocks.listUnitsReply.
    const unixSocketModule = await import("../../src/services/unix-socket.js");
    const socketFilePath = path.join(sessionsDir, "1.sock");
    fs.writeFileSync(socketFilePath, "");
    const probeSpy = vi.spyOn(unixSocketModule, "probeSocket").mockResolvedValue("unknown");
    // spawnChildProcess is a module-level mock shared across this whole test
    // file (not reset per-test), so a plain `.not.toHaveBeenCalledWith(...)`
    // would also "pass" for the wrong reason if it only ever inspected the
    // full cross-test history — snapshot the call count first and only
    // inspect calls made by THIS test.
    const callsBefore = vi.mocked(spawnChildProcess).mock.calls.length;

    try {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      expect(probeSpy).toHaveBeenCalledWith(socketFilePath);

      // The file must survive completely untouched — no unlink attempt.
      // Before the fix, isSocketLive() collapsed "unknown" straight to
      // `false`, and spawnInternal() would unlinkSync this file and
      // bootstrap a brand-new systemd-run scope — deleting the only handle
      // to what could genuinely be a live, running agent process, whose
      // real dtach master would then collide with the freshly-created scope
      // and be orphaned.
      expect(fs.existsSync(socketFilePath)).toBe(true);
      expect(fs.readFileSync(socketFilePath, "utf8")).toBe("");

      // No fresh systemd-run bootstrap either — that's the second half of
      // the same bug (the follow-on scope creation colliding with the
      // still-active one and orphaning the real master).
      const callsDuringThisTest = vi.mocked(spawnChildProcess).mock.calls.slice(callsBefore);
      expect(callsDuringThisTest.some((call) => call[0] === "systemd-run")).toBe(false);

      // spawnInternal() falls through to attachClient() regardless (an
      // inconclusive probe is treated the same as "live" — just attempt the
      // dtach -a attach, which fails harmlessly against a genuinely stale
      // socket) — so this session still ends up alive via the mocked pty.
      expect(session.isAlive).toBe(true);
    } finally {
      probeSpy.mockRestore();
    }
  });

  // Issue #988's investigation: Node's own spawn ENOENT blames whichever
  // binary it tried to exec ("spawn systemd-run ENOENT") even when the REAL
  // cause is `cwd` itself having vanished (a worktree deleted out from
  // under an in-flight re-seed) — a misleading message that sent that
  // incident's own investigation looking at the wrong binary.
  // bootstrapMaster() now classifies this against `existsSync(this.cwd)`.
  // Issue #1541 — listOwnedScopes() is TTL-cached; a spawn must never be
  // masked by a cached "dead"/"absent" listing read before the scope existed
  // (the reconciler would mark the live session exited and terminate it).
  describe("bootstrapMaster invalidates the owned-scopes cache (issue #1541)", () => {
    it("a cached dead verdict is dropped once systemd-run creates the scope", async () => {
      scopeMocks.listUnitsReply = [];
      await expect(manager.isMasterAliveState("1")).resolves.toBe("dead");
      // The scope now exists, but the cached listing still says "dead".
      scopeMocks.listUnitsReply = [ownedLine("1", sessionsDir)];
      await expect(manager.isMasterAliveState("1")).resolves.toBe("dead");

      const session = manager.getOrCreate({
        id: "1",
        cwd: sessionsDir,
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await session.spawnOutcome();

      await expect(manager.isMasterAliveState("1")).resolves.toBe("alive");
    });
  });

  describe("bootstrapMaster ENOENT classification (issue #988)", () => {
    it("reclassifies a systemd-run ENOENT as a vanished cwd when the cwd doesn't exist", async () => {
      const missingCwd = path.join(sessionsDir, "does-not-exist");
      vi.mocked(spawnChildProcess).mockImplementationOnce((file: string) => {
        const ee = new EventEmitter();
        expect(file).toBe("systemd-run");
        setImmediate(() =>
          ee.emit(
            "error",
            Object.assign(new Error("spawn systemd-run ENOENT"), { code: "ENOENT" }),
          ),
        );
        return ee as unknown as ReturnType<typeof spawnChildProcess>;
      });

      const session = manager.getOrCreate({
        id: "1",
        cwd: missingCwd,
        command: "bash",
        cols: 80,
        rows: 24,
      });

      await expect(session.spawnOutcome()).rejects.toThrow(`cwd does not exist: ${missingCwd}`);
    });

    it("leaves a systemd-run ENOENT unclassified when the cwd genuinely exists", async () => {
      vi.mocked(spawnChildProcess).mockImplementationOnce((file: string) => {
        const ee = new EventEmitter();
        expect(file).toBe("systemd-run");
        setImmediate(() =>
          ee.emit(
            "error",
            Object.assign(new Error("spawn systemd-run ENOENT"), { code: "ENOENT" }),
          ),
        );
        return ee as unknown as ReturnType<typeof spawnChildProcess>;
      });

      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });

      await expect(session.spawnOutcome()).rejects.toThrow("spawn systemd-run ENOENT");
    });

    it("leaves a non-ENOENT systemd-run spawn error unclassified even when the cwd is missing", async () => {
      const missingCwd = path.join(sessionsDir, "still-does-not-exist");
      vi.mocked(spawnChildProcess).mockImplementationOnce((file: string) => {
        const ee = new EventEmitter();
        expect(file).toBe("systemd-run");
        setImmediate(() =>
          ee.emit(
            "error",
            Object.assign(new Error("spawn systemd-run EACCES"), { code: "EACCES" }),
          ),
        );
        return ee as unknown as ReturnType<typeof spawnChildProcess>;
      });

      const session = manager.getOrCreate({
        id: "1",
        cwd: missingCwd,
        command: "bash",
        cols: 80,
        rows: 24,
      });

      await expect(session.spawnOutcome()).rejects.toThrow("spawn systemd-run EACCES");
    });

    // Hermes review, PR #1001 — a plain existsSync check alone would miss
    // this case: a `cwd` that exists but is a regular file (not a
    // directory) spawns with the identical ENOENT and would otherwise still
    // surface the misleading raw error.
    it("reclassifies a systemd-run ENOENT as unusable when the cwd exists but isn't a directory", async () => {
      const fileCwd = path.join(sessionsDir, "a-plain-file");
      fs.writeFileSync(fileCwd, "");
      vi.mocked(spawnChildProcess).mockImplementationOnce((file: string) => {
        const ee = new EventEmitter();
        expect(file).toBe("systemd-run");
        setImmediate(() =>
          ee.emit(
            "error",
            Object.assign(new Error("spawn systemd-run ENOENT"), { code: "ENOENT" }),
          ),
        );
        return ee as unknown as ReturnType<typeof spawnChildProcess>;
      });

      const session = manager.getOrCreate({
        id: "1",
        cwd: fileCwd,
        command: "bash",
        cols: 80,
        rows: 24,
      });

      await expect(session.spawnOutcome()).rejects.toThrow(`cwd does not exist: ${fileCwd}`);
    });
  });

  // Issue #1137's investigation: a leaked scope from an earlier process (a
  // crashed test run, a stale scratch dev instance) squatting on a
  // low-numbered id made a fresh backend's own bootstrap fail with nothing
  // but `master bootstrap exited with code 1 (unit crs-session-1)` — no
  // hint that a name collision, not a genuine systemd-run/dtach problem,
  // was the cause. bootstrapMaster() now probes describeScope() on any
  // non-zero exit and names the squatter when one is actually occupying the
  // name.
  describe("bootstrapMaster scope-collision diagnostic (issue #1137)", () => {
    it("names the squatting unit's Description when the scope name is already active", async () => {
      // Issue #1140 (PR 2) — the unit name is namespaced by this
      // PtyManager's own instanceId (derived from `sessionsDir`, fresh per
      // test), so the squatting unit this test simulates must use that
      // same computed name, not a bare `crs-session-1`.
      const unit = `crs-session-${deriveInstanceId(sessionsDir)}-1.scope`;
      scopeMocks.showReplies[unit] = {
        description:
          "/usr/bin/dtach -n /tmp/pty-manager-filechange-test-abc123/1.sock /bin/zsh -lc bash",
        activeState: "active",
      };
      vi.mocked(spawnChildProcess).mockImplementationOnce((file: string) => {
        const ee = new EventEmitter();
        expect(file).toBe("systemd-run");
        setImmediate(() => ee.emit("exit", 1));
        return ee as unknown as ReturnType<typeof spawnChildProcess>;
      });

      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });

      await expect(session.spawnOutcome()).rejects.toThrow(
        /already exists and is running "\/usr\/bin\/dtach -n \/tmp\/pty-manager-filechange-test-abc123\/1\.sock \/bin\/zsh -lc bash"/,
      );
      // The original plain message survives too — describeScope augments
      // it, it doesn't replace it — so anything grepping logs for the old
      // shape still matches.
      await expect(session.spawnOutcome()).rejects.toThrow(`unit ${unit.replace(/\.scope$/, "")}`);
    });

    it("falls back to the plain message unchanged when the scope name isn't actually occupied", async () => {
      // scopeMocks.showReplies has no entry for this instance's own namespaced unit —
      // the shared mock's default (systemd's own real fallback for a unit
      // that never existed: ActiveState "inactive") — so describeScope()
      // resolves null and the non-zero exit must be some other,
      // non-collision cause.
      vi.mocked(spawnChildProcess).mockImplementationOnce((file: string) => {
        const ee = new EventEmitter();
        expect(file).toBe("systemd-run");
        setImmediate(() => ee.emit("exit", 1));
        return ee as unknown as ReturnType<typeof spawnChildProcess>;
      });

      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });

      await expect(session.spawnOutcome()).rejects.toThrow(
        `master bootstrap exited with code 1 (unit crs-session-${deriveInstanceId(sessionsDir)}-1)`,
      );
    });
  });

  it("reuses the same session object and does not respawn while alive", async () => {
    const first = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(first);
    const second = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });

    expect(second).toBe(first);
    expect(fakePtyChildren).toHaveLength(1);
  });

  it("respawns a fresh attach-client if the tracked one died", async () => {
    const first = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(first);
    fakePtyChildren[0].kill();

    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    expect(session.isAlive).toBe(true);
    expect(fakePtyChildren).toHaveLength(2);
  });

  // Issue #1156 — getOrCreate() used to read opts.cols/opts.rows only in the
  // `if (!session)` branch (brand-new Session). Reattaching to a
  // Session that's still in the map but whose attach-client died (in the
  // map, ptyProcess null — the dtach master is still alive) returned it
  // unchanged, so the respawned pty inherited the stale size instead of the
  // new caller's request.
  it("applies the requested cols/rows when reattaching to a dead session", async () => {
    const first = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(first);
    fakePtyChildren[0].kill();
    expect(first.isAlive).toBe(false);

    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 120,
      rows: 40,
    });
    await waitForSpawn(session);

    expect(session).toBe(first);
    // attachClient() spawns the pty at the Session's own this.cols/this.rows
    // (never the opts it was handed), so this is what proves the new size
    // was applied before spawn rather than the pty just happening to start
    // that way.
    expect(fakePtyChildren[1].cols).toBe(120);
    expect(fakePtyChildren[1].rows).toBe(40);
    expect(session.toInfo().cols).toBe(120);
    expect(session.toInfo().rows).toBe(40);
  });

  // Same reattach path, but the requested size is below MIN_TERMINAL_COLS/
  // ROWS. 80 (the stale pre-fix size), 10 (the raw request), and 40 (the
  // clamped floor) are three distinct values, so this one assertion also
  // discriminates "fix applies resize() but bypasses clampTerminalSize" from
  // "fix applies the clamp correctly" — not a redundant clamp test.
  it("clamps the requested cols/rows below the floor when reattaching to a dead session", async () => {
    const first = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(first);
    fakePtyChildren[0].kill();

    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 10,
      rows: 2,
    });
    await waitForSpawn(session);

    expect(fakePtyChildren[1].cols).toBe(40);
    expect(fakePtyChildren[1].rows).toBe(10);
    expect(session.toInfo().cols).toBe(40);
    expect(session.toInfo().rows).toBe(10);
  });

  // getScrollback() always prepends a screen-mode preamble (see pty-manager.ts)
  // — "\x1b[?1049l" while tracked state is primary (the default), so a fresh
  // xterm.js is guaranteed to land with a scrollbar. Assert with a suffix
  // check rather than exact equality so these tests don't hard-code the
  // preamble's own byte content.
  const PRIMARY_PREAMBLE = "\x1b[?1049l";

  it("forwards data to subscribers and buffers it as scrollback", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    const received: Buffer[] = [];
    session.onData((chunk) => received.push(chunk));
    fakePtyChildren[0].emitData("hello");

    expect(received).toHaveLength(1);
    expect(received[0].toString()).toBe("hello");
    expect(session.getScrollback().toString()).toBe(`${PRIMARY_PREAMBLE}hello`);
  });

  it("replays scrollback to a late subscriber without needing a new attach", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);
    fakePtyChildren[0].emitData("existing output");

    // A second "viewer" joining later (e.g. a reconnecting browser tab)
    // reads getScrollback() directly rather than a fresh dtach attach —
    // this is the no-redraw-needed common case from pty-manager.ts.
    expect(session.getScrollback().toString()).toBe(`${PRIMARY_PREAMBLE}existing output`);
  });

  it("trims scrollback to the configured byte cap", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    // 1 MiB cap — push comfortably past it in large chunks. The preamble is
    // added on top of the cap (it's synthesized at read time, not buffered),
    // so allow a little slack for it.
    const chunk = "x".repeat(256 * 1024);
    for (let i = 0; i < 8; i++) fakePtyChildren[0].emitData(chunk);

    expect(session.getScrollback().length).toBeLessThanOrEqual(1024 * 1024 + 32);
  });
});
