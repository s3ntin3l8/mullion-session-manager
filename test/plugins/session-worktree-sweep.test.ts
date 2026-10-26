import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

const sweepSessionWorktrees = vi.fn();
vi.mock("../../src/services/session-worktree-reclaim.js", () => ({
  sweepSessionWorktrees: (...args: unknown[]) => sweepSessionWorktrees(...args),
}));

const { sessionWorktreeSweepPlugin, SESSION_WORKTREE_SWEEP_INTERVAL_MS } =
  await import("../../src/plugins/session-worktree-sweep.js");

// Issue #1964 — the periodic retry for isolated sessions whose worktree could
// not be reclaimed when they ended.

async function appWithRole(role: "primary" | "agent") {
  const app = Fastify({ logger: false });
  app.decorate("config", { MULLION_ROLE: role } as never);
  await app.register(sessionWorktreeSweepPlugin);
  await app.ready();
  return app;
}

describe("sessionWorktreeSweepPlugin", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sweepSessionWorktrees.mockReset();
    sweepSessionWorktrees.mockResolvedValue({ reclaimed: 0, kept: 0, deferred: 0 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does nothing on an agent: it has no database to find sessions in", async () => {
    const app = await appWithRole("agent");
    await vi.advanceTimersByTimeAsync(SESSION_WORKTREE_SWEEP_INTERVAL_MS * 3);
    expect(sweepSessionWorktrees).not.toHaveBeenCalled();
    await app.close();
  });

  it("sweeps shortly after boot, then on its interval", async () => {
    const app = await appWithRole("primary");
    expect(sweepSessionWorktrees).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(sweepSessionWorktrees).toHaveBeenCalledTimes(1);
    expect(sweepSessionWorktrees).toHaveBeenCalledWith(app);

    await vi.advanceTimersByTimeAsync(SESSION_WORKTREE_SWEEP_INTERVAL_MS);
    expect(sweepSessionWorktrees.mock.calls.length).toBeGreaterThanOrEqual(2);
    await app.close();
  });

  it("does not start a pass while the previous one is still running", async () => {
    let finish!: () => void;
    sweepSessionWorktrees.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ reclaimed: 0, kept: 0, deferred: 0 });
        }),
    );
    const app = await appWithRole("primary");

    // The first pass (2 min) is still blocked on a slow host when the
    // interval tick (30 min) arrives.
    await vi.advanceTimersByTimeAsync(SESSION_WORKTREE_SWEEP_INTERVAL_MS);
    expect(sweepSessionWorktrees).toHaveBeenCalledTimes(1);

    finish();
    await vi.advanceTimersByTimeAsync(SESSION_WORKTREE_SWEEP_INTERVAL_MS);
    expect(sweepSessionWorktrees).toHaveBeenCalledTimes(2);
    finish();
    await app.close();
  });

  it("survives a failing pass and tries again next time", async () => {
    sweepSessionWorktrees.mockRejectedValueOnce(new Error("boom"));
    const app = await appWithRole("primary");

    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await vi.advanceTimersByTimeAsync(SESSION_WORKTREE_SWEEP_INTERVAL_MS);

    expect(sweepSessionWorktrees).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("stops sweeping once the app is closed", async () => {
    const app = await appWithRole("primary");
    await app.close();
    await vi.advanceTimersByTimeAsync(SESSION_WORKTREE_SWEEP_INTERVAL_MS * 3);
    expect(sweepSessionWorktrees).not.toHaveBeenCalled();
  });
});
