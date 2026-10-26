import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { reviewMarkerSweepPlugin } from "../../src/plugins/review-marker-sweep.js";

const sweep = vi.hoisted(() => vi.fn());
vi.mock("../../src/services/hermes-review.js", () => ({ sweepOpenReviewMarkers: sweep }));

// A minimal Fastify stand-in: the plugin only touches config, log and addHook.
function fakeApp(role: string) {
  const hooks: Record<string, () => void> = {};
  const log = { error: vi.fn() };
  const app = {
    config: { MULLION_ROLE: role },
    log,
    addHook: (name: string, fn: () => void) => {
      hooks[name] = fn;
    },
  };
  return { app: app as unknown as FastifyInstance, hooks, log };
}

// `fp` wraps the function; the wrapped plugin is still directly callable.
const run = (app: FastifyInstance) =>
  (reviewMarkerSweepPlugin as unknown as (a: FastifyInstance) => Promise<void>)(app);

describe("reviewMarkerSweepPlugin", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sweep.mockReset().mockResolvedValue(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers nothing on the agent role", async () => {
    const { app, hooks } = fakeApp("agent");
    await run(app);
    expect(hooks).toEqual({});
  });

  it("sweeps every minute once the app is ready, and stops on close", async () => {
    const { app, hooks } = fakeApp("primary");
    await run(app);
    hooks.onReady();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sweep).toHaveBeenCalledTimes(1);
    hooks.onClose();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it("does not start a pass on top of one that is still running", async () => {
    let finish: () => void = () => undefined;
    sweep.mockReturnValue(new Promise<number>((r) => (finish = () => r(0))));
    const { app, hooks } = fakeApp("primary");
    await run(app);
    hooks.onReady();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(sweep).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sweep).toHaveBeenCalledTimes(2);
    hooks.onClose();
  });

  it("logs a failed pass and keeps sweeping", async () => {
    sweep.mockRejectedValueOnce(new Error("boom"));
    const { app, hooks, log } = fakeApp("primary");
    await run(app);
    hooks.onReady();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(sweep).toHaveBeenCalledTimes(2);
    hooks.onClose();
  });
});
