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

    expect(run).toHaveBeenCalledWith(browser, demo);
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

  it("closes a browser whose launch lands after a SIGTERM", async () => {
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
    await expect(result).rejects.toThrow("interrupted by SIGTERM");
    expect(demo.stop).toHaveBeenCalledOnce();

    land(browser);
    await vi.waitFor(() => expect(browser.close).toHaveBeenCalledOnce());
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
