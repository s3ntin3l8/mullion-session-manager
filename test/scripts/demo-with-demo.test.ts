import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withDemo } from "../../scripts/demo/with-demo.mjs";

function fakes() {
  const demo = { stop: vi.fn(async () => {}) };
  const browser = { close: vi.fn(async () => {}) };
  const signals = new EventEmitter();
  return { demo, browser, signals, startDemo: vi.fn(async () => demo) };
}

describe("withDemo", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("runs against the demo, then closes the browser and stops the demo", async () => {
    const { demo, browser, signals, startDemo } = fakes();
    const run = vi.fn(async () => "captured");

    await expect(
      withDemo({ startDemo, launchBrowser: async () => browser, run, signals }),
    ).resolves.toBe("captured");

    expect(run).toHaveBeenCalledWith(browser, demo, expect.any(AbortSignal));
    expect(browser.close).toHaveBeenCalledOnce();
    expect(demo.stop).toHaveBeenCalledOnce();
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("stops the demo when the browser fails to launch", async () => {
    const { demo, signals, startDemo } = fakes();
    const run = vi.fn();
    const launchBrowser = async () => {
      throw new Error("Executable doesn't exist");
    };

    await expect(withDemo({ startDemo, launchBrowser, run, signals })).rejects.toThrow(
      "Executable doesn't exist",
    );

    expect(run).not.toHaveBeenCalled();
    expect(demo.stop).toHaveBeenCalledOnce();
  });

  it("stops the demo when the launch throws synchronously", async () => {
    const { demo, signals, startDemo } = fakes();
    const launchBrowser = () => {
      throw new Error("sync failure");
    };

    await expect(withDemo({ startDemo, launchBrowser, run: vi.fn(), signals })).rejects.toThrow(
      "sync failure",
    );
    expect(demo.stop).toHaveBeenCalledOnce();
  });

  it("closes the browser and stops the demo when the run fails", async () => {
    const { demo, browser, signals, startDemo } = fakes();
    const run = async () => {
      throw new Error("selector timed out");
    };

    await expect(
      withDemo({ startDemo, launchBrowser: async () => browser, run, signals }),
    ).rejects.toThrow("selector timed out");

    expect(browser.close).toHaveBeenCalledOnce();
    expect(demo.stop).toHaveBeenCalledOnce();
  });

  it("still stops the demo when closing the browser fails", async () => {
    const { demo, browser, signals, startDemo } = fakes();
    browser.close.mockRejectedValueOnce(new Error("already gone"));

    await withDemo({ startDemo, launchBrowser: async () => browser, run: async () => {}, signals });

    expect(demo.stop).toHaveBeenCalledOnce();
  });

  it("tears down on SIGINT during the run instead of leaving the demo up", async () => {
    const { demo, browser, signals, startDemo } = fakes();
    let entered!: () => void;
    const running = new Promise<void>((r) => (entered = r));
    const run = () => {
      entered();
      return new Promise(() => {}); // a capture that never finishes on its own
    };

    const result = withDemo({ startDemo, launchBrowser: async () => browser, run, signals });
    await running;
    signals.emit("SIGINT", "SIGINT");

    await expect(result).rejects.toThrow("interrupted by SIGINT");
    expect(browser.close).toHaveBeenCalledOnce();
    expect(demo.stop).toHaveBeenCalledOnce();
    expect(signals.listenerCount("SIGINT")).toBe(0);
  });

  it("waits for a launch that lands after a SIGTERM and closes that browser first", async () => {
    const { demo, browser, signals, startDemo } = fakes();
    let land!: (b: typeof browser) => void;
    let launched!: () => void;
    const launchStarted = new Promise<void>((r) => (launched = r));
    const launchBrowser = () => {
      launched();
      return new Promise<typeof browser>((r) => (land = r));
    };

    const result = withDemo({ startDemo, launchBrowser, run: vi.fn(), signals });
    await launchStarted;
    signals.emit("SIGTERM", "SIGTERM");
    await new Promise((r) => setTimeout(r, 10));
    expect(demo.stop).not.toHaveBeenCalled();

    land(browser);
    await expect(result).rejects.toThrow("interrupted by SIGTERM");
    expect(browser.close).toHaveBeenCalledOnce();
    expect(browser.close.mock.invocationCallOrder[0]).toBeLessThan(
      demo.stop.mock.invocationCallOrder[0],
    );
  });

  it("gives up on a launch that never lands and still stops the demo", async () => {
    const { demo, signals, startDemo } = fakes();
    let launched!: () => void;
    const launchStarted = new Promise<void>((r) => (launched = r));
    const launchBrowser = () => {
      launched();
      return new Promise(() => {});
    };

    const result = withDemo({ startDemo, launchBrowser, run: vi.fn(), signals, lateLaunchMs: 20 });
    await launchStarted;
    signals.emit("SIGINT", "SIGINT");

    await expect(result).rejects.toThrow("interrupted by SIGINT");
    expect(demo.stop).toHaveBeenCalledOnce();
  });

  it("keeps the launch error when stopping the demo also fails", async () => {
    const { demo, signals, startDemo } = fakes();
    demo.stop.mockRejectedValueOnce(new Error("stopScope failed"));
    const launchBrowser = async () => {
      throw new Error("Executable doesn't exist");
    };

    await expect(withDemo({ startDemo, launchBrowser, run: vi.fn(), signals })).rejects.toThrow(
      "Executable doesn't exist",
    );
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("stopScope failed"));
    expect(signals.listenerCount("SIGINT")).toBe(0);
  });

  it("fails the exit code when the demo can't be stopped after a successful run", async () => {
    const { demo, browser, signals, startDemo } = fakes();
    demo.stop.mockRejectedValueOnce(new Error("stopScope failed"));
    const before = process.exitCode;
    try {
      process.exitCode = undefined;
      await expect(
        withDemo({ startDemo, launchBrowser: async () => browser, run: async () => "ok", signals }),
      ).resolves.toBe("ok");
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = before;
    }
  });

  it("closes the browser before stopping the demo", async () => {
    const { demo, browser, signals, startDemo } = fakes();

    await withDemo({ startDemo, launchBrowser: async () => browser, run: async () => {}, signals });

    expect(browser.close.mock.invocationCallOrder[0]).toBeLessThan(
      demo.stop.mock.invocationCallOrder[0],
    );
  });

  it("keeps handling signals until the demo has stopped", async () => {
    const { demo, browser, signals, startDemo } = fakes();
    let finishStop!: () => void;
    let stopping!: () => void;
    const stopStarted = new Promise<void>((r) => (stopping = r));
    demo.stop.mockImplementation(() => {
      stopping();
      return new Promise<void>((r) => (finishStop = r));
    });
    let entered!: () => void;
    const running = new Promise<void>((r) => (entered = r));
    const run = () => {
      entered();
      return new Promise(() => {});
    };

    const result = withDemo({ startDemo, launchBrowser: async () => browser, run, signals });
    await running;
    signals.emit("SIGINT", "SIGINT");
    await stopStarted;

    // A second Ctrl-C mid-teardown must hit our handler, not Node's default
    // (which would kill the process and leave the demo up).
    expect(signals.listenerCount("SIGINT")).toBe(1);
    expect(() => signals.emit("SIGINT", "SIGINT")).not.toThrow();

    finishStop();
    await expect(result).rejects.toThrow("interrupted by SIGINT");
    expect(demo.stop).toHaveBeenCalledOnce();
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("aborts the run's signal on an interrupt so an abandoned step stops polling", async () => {
    const { browser, signals, startDemo } = fakes();
    let runSignal!: AbortSignal;
    let entered!: () => void;
    const running = new Promise<void>((r) => (entered = r));
    const run = (_b: unknown, _d: unknown, signal: AbortSignal) => {
      runSignal = signal;
      entered();
      return new Promise(() => {});
    };

    const result = withDemo({ startDemo, launchBrowser: async () => browser, run, signals });
    await running;
    expect(runSignal.aborted).toBe(false);
    signals.emit("SIGTERM", "SIGTERM");

    await expect(result).rejects.toThrow("interrupted by SIGTERM");
    expect(runSignal.aborted).toBe(true);
    expect(() => runSignal.throwIfAborted()).toThrow("interrupted by SIGTERM");
  });

  it("aborts the run's signal once the run is over", async () => {
    const { browser, signals, startDemo } = fakes();
    let runSignal!: AbortSignal;
    const run = async (_b: unknown, _d: unknown, signal: AbortSignal) => {
      runSignal = signal;
    };

    await withDemo({ startDemo, launchBrowser: async () => browser, run, signals });
    expect(runSignal.aborted).toBe(true);
  });

  it("propagates a startDemo failure without launching a browser", async () => {
    const { signals } = fakes();
    const launchBrowser = vi.fn();
    const startDemo = async () => {
      throw new Error("ports busy");
    };

    await expect(withDemo({ startDemo, launchBrowser, run: vi.fn(), signals })).rejects.toThrow(
      "ports busy",
    );
    expect(launchBrowser).not.toHaveBeenCalled();
  });
});
