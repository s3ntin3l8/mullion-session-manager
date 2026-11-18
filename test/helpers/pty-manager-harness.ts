// The shared harness behind the pty-manager test split (issue #3277).
//
// `test/services/pty-manager.test.ts` was 7,504 code lines — frozen at the
// file-size ratchet's ceiling (scripts/max-file-lines.baseline.json) — so
// every new behaviour had to land in a NEW file, and every new file had to
// re-create the preamble below: a fake PTY, a faked `systemctl`/`systemd-run`
// child process, and the per-test state reset. That preamble is what lives
// here now.
//
// WHAT STAYS IN EACH TEST FILE, AND WHY: the hoisted `vi.mock(...)` CALLS.
// Vitest hoists them above every import in the file, and a mock registered
// from inside this helper would not be hoisted into the test file's own
// import order — so each test file keeps its own one-line call and delegates
// the factory BODY to a function exported from here:
//
//   vi.mock("node-pty", () => nodePtyMock());
//
// See test/helpers/mock-pty.ts for the same story in the suite's other
// node-pty mocks, and mock-spawn.ts for the child_process one.
//
// THE IMPORT ORDER MATTERS. Vitest triggers a mock at the position of the
// import that first reaches the mocked module, so the helper's own import
// has to come BEFORE any import that could pull in "node-pty" or
// "node:child_process" — directly or through src/services/. Every test file
// that uses this harness therefore imports it before any other src/ import
// (only "vitest" itself may precede it).

import { vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import type { PtyManager } from "../../src/services/pty-manager.js";

// PtyManager spawns real OS processes (systemd-run, dtach) — see
// src/services/pty-manager.ts. Milestone 1 already proved the real
// mechanics work empirically against a live Claude Code session; these
// tests are for our own orchestration logic (spawn-once, scrollback
// trimming, listener lifecycle), so node-pty and the systemd-run/dtach
// bootstrap child_process are faked rather than depending on a real
// systemd --user session existing in CI.
export const fakePtyChildren: FakePty[] = [];

export class FakePty {
  dataListeners: Array<(data: string) => void> = [];
  // node-pty's exit event carries the killing signal alongside the exit
  // code (`onExit: IEvent<{ exitCode: number, signal?: number }>`), and
  // pty-manager.ts's own exit-attribution log reads it — so the double has
  // to carry it too, or that log would always say "signal=none".
  exitListeners: Array<(e: { exitCode: number; signal?: number }) => void> = [];
  cols: number;
  rows: number;
  killed = false;
  writeSpy = vi.fn((_data: string) => {});
  resizeSpy = vi.fn((_cols: number, _rows: number) => {});

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
  }

  onData(cb: (data: string) => void) {
    this.dataListeners.push(cb);
    return { dispose: () => {} };
  }

  onExit(cb: (e: { exitCode: number; signal?: number }) => void) {
    this.exitListeners.push(cb);
    return { dispose: () => {} };
  }

  write(data: string) {
    this.writeSpy(data);
  }

  resize(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.resizeSpy(cols, rows);
  }

  kill() {
    this.killed = true;
    for (const cb of this.exitListeners) cb({ exitCode: 0 });
  }

  emitData(chunk: string) {
    for (const cb of this.dataListeners) cb(chunk);
  }
}

// Issue #1140 (PR 1) — the fake `systemctl --user list-units` reply every
// session-process.ts function now goes through (isMasterAliveStateBatch/
// isMasterAliveBatch, and terminate()'s stopScope): raw `--plain
// --no-legend` output LINES, not just unit names — ownership is resolved
// from each row's Description (the dtach socket path), not from the unit
// name alone, so a fixture has to render a real-shaped Description. Defaults
// to empty (nothing owned/active) so tests unrelated to this don't need to
// care about it. See ownedLine() below, this suite's own equivalent of
// session-process.test.ts's identical helper.
export const scopeMocks = {
  /** The raw lines the faked `systemctl --user list-units` replies with. */
  listUnitsReply: [] as string[],
  /**
   * Issue #1137 — the fake `systemctl --user show <unit> -p Description -p
   * ActiveState` reply describeScope() should see, keyed by unit name.
   * Defaults (unit absent from this map) to systemd's own real fallback for a
   * unit that never existed (Description equal to the bare unit name,
   * ActiveState "inactive") — see session-process.test.ts's identical
   * showReplies convention — so tests unrelated to the bootstrap-collision
   * diagnostic don't need to care about it.
   */
  showReplies: {} as Record<string, { description: string; activeState: string }>,
};

// "UNIT LOAD ACTIVE SUB DESCRIPTION" — the real `--plain --no-legend` shape.
export function scopeLine(unit: string, description: string, state = "active"): string {
  return `${unit} loaded ${state} running ${description}`;
}

// A row for `id`'s scope whose socket resolves under `dir` (defaults to
// the suite's own per-test sessionsDir) — the shape stopScope/
// isMasterAliveStateBatch/isMasterAliveBatch now require to treat a unit as
// this instance's own.
export function ownedLine(id: string, dir: string): string {
  return scopeLine(
    `crs-session-${id}.scope`,
    `/usr/bin/dtach -n ${dir}/${id}.sock /usr/bin/zsh -lc bash`,
  );
}

/**
 * The `node-pty` mock — every spawned PTY is a FakePty recorded in
 * `fakePtyChildren`, in call order, so a test can push synthetic output
 * through a specific session's PTY or simulate it exiting.
 */
export function nodePtyMock() {
  return {
    spawn: vi.fn((_file: string, _args: string[], opts: { cols: number; rows: number }) => {
      const child = new FakePty(opts.cols, opts.rows);
      fakePtyChildren.push(child);
      return child;
    }),
  };
}

/**
 * The `node:child_process` mock: `systemctl --user list-units` and
 * `systemctl --user show` reply with the fixtures above, and every other
 * command (the `systemd-run --user --scope ...` bootstrap, `systemctl --user
 * stop ...`) succeeds immediately with no output, matching a real bootstrap
 * against a socket that doesn't exist yet.
 *
 * `actual` is the real module, spread through so every other export still
 * works.
 */
export function childProcessMock(actual: unknown): typeof ChildProcess {
  const real = actual as typeof ChildProcess;
  return {
    ...real,
    spawn: vi.fn((file: string, args: string[]) => {
      const ee = new EventEmitter() as EventEmitter & { stdout?: EventEmitter };
      if (file === "systemctl" && args[1] === "list-units") {
        ee.stdout = new EventEmitter();
        // 'exit' fires before 'data'/'close' — the exact real race
        // isMasterAliveStateBatch()/isMasterAliveBatch() must resolve off
        // 'close' to survive; see their own doc comments and agent-detect.ts's
        // probe() for the live bug this guards against.
        setImmediate(() => {
          ee.emit("exit", 0);
          setImmediate(() => {
            const lines = scopeMocks.listUnitsReply.join("\n");
            ee.stdout?.emit("data", Buffer.from(lines ? `${lines}\n` : ""));
            ee.emit("close", 0);
          });
        });
        return ee;
      }
      if (file === "systemctl" && args[1] === "show") {
        ee.stdout = new EventEmitter();
        const unit = args[2];
        const reply = scopeMocks.showReplies[unit] ?? {
          description: unit,
          activeState: "inactive",
        };
        setImmediate(() => {
          ee.emit("exit", 0);
          setImmediate(() => {
            ee.stdout?.emit(
              "data",
              Buffer.from(`Description=${reply.description}\nActiveState=${reply.activeState}\n`),
            );
            ee.emit("close", 0);
          });
        });
        return ee;
      }
      // Stands in for `systemd-run --user --scope ... dtach -n ...` and
      // `systemctl --user stop ...`: succeeds immediately with no output,
      // matching a real bootstrap against a socket that doesn't exist yet.
      setImmediate(() => ee.emit("exit", 0));
      return ee;
    }) as unknown as typeof ChildProcess.spawn,
  };
}

/**
 * Issue #941 — this suite does real spawns through applyHookAdapters, which
 * now calls bundle-sync.ts's isBundleSyncedFor from inside claude-code.ts's/
 * opencode.ts's prepareLaunch. Left unmocked, that reads the REAL
 * ~/.mullion/bundle-sync.json (HOME is never redirected in this file), so
 * every assertion below asserting today's per-session --plugin-dir/
 * skills.paths fallback would start depending on whether this exact
 * developer/CI machine happens to have already run a real boot-time sync.
 * Pinned to "never synced" so this suite keeps testing the fallback path
 * deterministically, matching its own existing (pre-#941) expectations.
 */
export function bundleSyncMock() {
  return { isBundleSyncedFor: () => false };
}

/**
 * Issue #1715 — the per-session process inventory is read through
 * cgroup-inventory's listScopeProcesses(). Mocked here so a test can
 * assert WHICH scope unit the backend resolved — a bare "an array came
 * back" assertion cannot tell "read the owned scope's inventory" apart
 * from "ownership failed, so nothing was read".
 */
const listScopeProcessesMock = vi.fn(async () => []);

export function cgroupInventoryMock() {
  return { listScopeProcesses: listScopeProcessesMock };
}

/**
 * Reset every piece of shared state between tests, so no test can rely on
 * another's leftovers: the fake PTYs, the `systemctl` fixtures, and the
 * cgroup-inventory call log.
 */
export function resetPtyManagerMocks(): void {
  fakePtyChildren.length = 0;
  scopeMocks.listUnitsReply = [];
  for (const key of Object.keys(scopeMocks.showReplies)) delete scopeMocks.showReplies[key];
  listScopeProcessesMock.mockClear();
}

/**
 * spawnInternal() chains an async socket-liveness check with the mocked
 * child_process "exit" event (itself fired via setImmediate) before
 * attachClient() runs — that's more event-loop hops than a single
 * setImmediate flush covers, and how many exactly is an implementation
 * detail we shouldn't hard-code. Poll for the actual condition instead.
 */
export async function waitForSpawn(session: { isAlive: boolean }): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (session.isAlive) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("session never became alive");
}

/**
 * Settle the async work a test left PENDING, so it cannot land in the next
 * test (issue #3277's "no test relies on another's leftovers").
 *
 * WHY THIS IS NOT COSMETIC: the faked `systemd-run` child reports its
 * "exit" on a setImmediate, and the scope backend's onSettled hook calls
 * invalidateOwnedScopesCache() when it fires — session-process.ts's
 * MODULE-LEVEL owned-scopes listing cache. The hook is INVOKED by
 * src/services/scope/spawn.ts (`opts.onSettled?.()`) and SUPPLIED by
 * src/services/scope/systemd.ts (`onSettled: invalidateOwnedScopesCache`) —
 * the latter is where to look for who wires it up. A test that calls
 * getOrCreate() and never awaits spawnOutcome() therefore leaves that
 * settle pending, and it lands in whatever test runs next.
 *
 * An invalidation landing inside ANOTHER test's `systemctl --user
 * list-units` window is not a no-op: listOwnedScopes() stamps each listing
 * with the cache generation it started under, so an invalidation that
 * arrives before the listing resolves stops that listing from populating
 * the TTL cache at all (session-process.ts's own "a listing that STARTED
 * before the invalidation can't repopulate the cache" rule). The next
 * reader then re-lists instead of seeing the cached verdict — which is
 * exactly how the #1541 case in pty-manager-core.test.ts came to depend on
 * its neighbours' timing.
 *
 * Draining here keeps every settle inside the test that caused it. A few
 * turns is plenty: the settle is one setImmediate, and the work it unblocks
 * (the attach-client spawn, the spawn failure's rollback) is a couple more.
 *
 * setImmediate must be REAL for this to work — no suite using this harness
 * fakes it (they fake Date and/or setTimeout only), and a suite that did
 * would hang here rather than drain.
 */
export async function drainPendingScopeWork(turns = 10): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** A per-test PtyManager and the sessions dir it owns. */
export interface PtyManagerFixture {
  sessionsDir: string;
  manager: PtyManager;
}

/**
 * Create a per-test PtyManager over a fresh temp sessions dir.
 *
 * mkdtempSync, not a hand-rolled random suffix: the OS's own atomic,
 * exclusive directory creation is what CodeQL's js/insecure-temporary-
 * file query treats as safe — a hand-templated path under os.tmpdir()
 * is a TOCTOU sink the moment test code writes into it directly, even
 * with high-entropy randomness in the name (same reasoning already
 * documented in test/routes/projects.test.ts's own worktree fixtures).
 */
export function createPtyManagerFixture(
  PtyManagerCtor: typeof PtyManager,
  prefix = "pty-manager-test-",
): PtyManagerFixture {
  const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { sessionsDir, manager: new PtyManagerCtor({ sessionsDir }) };
}

/**
 * Tear a fixture down: stop PtyManager's own attention-evaluator interval
 * (issue #171/#98) — unref()'d so it can't hang the test runner either
 * way, but leaving it running would keep ticking (and console.debug-
 * logging) an abandoned manager's sessions into later, unrelated tests.
 *
 * Then drain what the test left pending (see drainPendingScopeWork): a
 * bootstrap spawn's settle invalidates the module-level owned-scopes cache,
 * and an invalidation that lands in the NEXT test is that test reading
 * state its neighbour produced. Draining BEFORE the temp dir is removed
 * keeps the settle's own cwd alive while it runs, too.
 *
 * AWAIT IT — the drain is async, and the footgun is a block-body teardown
 * (`afterEach(() => { destroyPtyManagerFixture(fixture); })`): it compiles,
 * returns nothing, and silently skips the drain while still removing the
 * temp dir, reintroducing exactly the leftover-settle leak this drain
 * exists to prevent. Write `afterEach(async () => { await
 * destroyPtyManagerFixture(fixture); })`, or return the promise.
 */
export async function destroyPtyManagerFixture(fixture: PtyManagerFixture): Promise<void> {
  fixture.manager.killAll();
  await drainPendingScopeWork();
  fs.rmSync(fixture.sessionsDir, { recursive: true, force: true });
}
