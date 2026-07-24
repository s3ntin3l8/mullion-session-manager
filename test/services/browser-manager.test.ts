import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";

// BrowserManager launches real Chromium via Playwright — CI has no browser
// available (see deploy/README.md's Playwright prerequisites), so
// chromium.launch is faked the same way test/services/pty-manager.test.ts
// fakes node-pty: hand-written Fake* classes standing in for Playwright's
// real Browser/BrowserContext/Page, with every launched instance collected
// for assertions. Never launch a real Chromium in a unit test.
const launchedBrowsers: FakeBrowser[] = [];

class FakeContext {
  storageStateOptions?: { storageState?: string };
  // Mimics Playwright's real behavior closely enough for the manager's own
  // existsSync(storageStatePath) check to see a real file: writes a small
  // JSON blob to the given path rather than just recording that it was
  // called, so the "reuses persisted storage state" test below exercises
  // the manager's actual disk-based reuse logic, not a mocked no-op.
  storageStateSpy = vi.fn(async (opts?: { path: string }) => {
    if (opts?.path) {
      fs.mkdirSync(path.dirname(opts.path), { recursive: true });
      fs.writeFileSync(opts.path, JSON.stringify({ cookies: [], origins: [] }));
    }
    return { cookies: [], origins: [] };
  });

  constructor(options?: { storageState?: string }) {
    this.storageStateOptions = options;
  }

  async newPage() {
    return new FakePage();
  }

  async storageState(opts?: { path: string }) {
    return this.storageStateSpy(opts);
  }
}

class FakePage {}

class FakeBrowser extends EventEmitter {
  connected = true;
  contexts: FakeContext[] = [];
  closeSpy = vi.fn(async () => {
    this.connected = false;
  });

  isConnected() {
    return this.connected;
  }

  async newContext(options?: { storageState?: string }) {
    const context = new FakeContext(options);
    this.contexts.push(context);
    return context;
  }

  async close() {
    await this.closeSpy();
  }

  /** Test helper: simulate the Chromium process crashing (not a deliberate
   * close()) — fires 'disconnected' the same way Playwright's real Browser
   * does on an unexpected exit. */
  simulateCrash() {
    this.connected = false;
    this.emit("disconnected");
  }
}

vi.mock("playwright", () => ({
  chromium: {
    launch: vi.fn(async () => {
      const browser = new FakeBrowser();
      launchedBrowsers.push(browser);
      return browser;
    }),
  },
}));

const { BrowserManager } = await import("../../src/services/browser-manager.js");
const { chromium } = await import("playwright");

describe("BrowserManager", () => {
  let dataDir: string;
  let manager: InstanceType<typeof BrowserManager>;

  beforeEach(() => {
    launchedBrowsers.length = 0;
    vi.mocked(chromium.launch).mockClear();
    dataDir = path.join(
      os.tmpdir(),
      `browser-manager-test-${crypto.randomBytes(4).toString("hex")}`,
    );
    manager = new BrowserManager({ enabled: true, maxInstances: 2, dataDir });
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("throws on every method when disabled, without touching disk", async () => {
    const disabledDataDir = path.join(dataDir, "disabled-should-not-exist");
    const disabled = new BrowserManager({
      enabled: false,
      maxInstances: 2,
      dataDir: disabledDataDir,
    });
    expect(disabled.isEnabled()).toBe(false);
    await expect(disabled.getOrLaunch(1)).rejects.toThrow(/disabled/i);
    expect(fs.existsSync(disabledDataDir)).toBe(false);
  });

  it("launches headless Chromium with --no-sandbox", async () => {
    await manager.getOrLaunch(1);
    expect(vi.mocked(chromium.launch)).toHaveBeenCalledWith(
      expect.objectContaining({ headless: true, args: expect.arrayContaining(["--no-sandbox"]) }),
    );
  });

  it("reuses the pooled browser for the same project", async () => {
    const first = await manager.getOrLaunch(1);
    const second = await manager.getOrLaunch(1);
    expect(second).toBe(first);
    expect(launchedBrowsers).toHaveLength(1);
  });

  it("launches separate instances per project", async () => {
    await manager.getOrLaunch(1);
    await manager.getOrLaunch(2);
    expect(launchedBrowsers).toHaveLength(2);
    expect(manager.instanceCount).toBe(2);
  });

  it("enforces maxInstances", async () => {
    await manager.getOrLaunch(1);
    await manager.getOrLaunch(2);
    await expect(manager.getOrLaunch(3)).rejects.toThrow(/pool exhausted/i);
    expect(launchedBrowsers).toHaveLength(2);
  });

  it("auto-restarts (relaunches) after a crash", async () => {
    const first = await manager.getOrLaunch(1);
    (first.browser as unknown as FakeBrowser).simulateCrash();
    const second = await manager.getOrLaunch(1);
    expect(second).not.toBe(first);
    expect(launchedBrowsers).toHaveLength(2);
  });

  it("healthCheck evicts a disconnected instance lazily (no proactive relaunch)", async () => {
    const first = await manager.getOrLaunch(1);
    (first.browser as unknown as FakeBrowser).connected = false;
    manager.healthCheck();
    expect(manager.get(1)).toBeUndefined();
    expect(launchedBrowsers).toHaveLength(1); // no relaunch until next getOrLaunch
  });

  it("persists storage state and closes the browser on closeForProject", async () => {
    const managed = await manager.getOrLaunch(1);
    await manager.closeForProject(1);
    expect((managed.context as unknown as FakeContext).storageStateSpy).toHaveBeenCalledWith({
      path: path.join(dataDir, "project-1.json"),
    });
    expect((managed.browser as unknown as FakeBrowser).closeSpy).toHaveBeenCalled();
    expect(manager.get(1)).toBeUndefined();
  });

  it("closeForProject is a no-op when nothing is running for that project", async () => {
    await expect(manager.closeForProject(999)).resolves.toBeUndefined();
  });

  it("closeAll closes every pooled browser", async () => {
    const one = await manager.getOrLaunch(1);
    const two = await manager.getOrLaunch(2);
    await manager.closeAll();
    expect((one.browser as unknown as FakeBrowser).closeSpy).toHaveBeenCalled();
    expect((two.browser as unknown as FakeBrowser).closeSpy).toHaveBeenCalled();
    expect(manager.instanceCount).toBe(0);
  });

  it("reuses persisted storage state on relaunch after a clean close", async () => {
    await manager.getOrLaunch(1);
    await manager.closeForProject(1);
    await manager.getOrLaunch(1);
    const secondContext = launchedBrowsers[1].contexts[0];
    expect(secondContext.storageStateOptions?.storageState).toBe(
      path.join(dataDir, "project-1.json"),
    );
  });

  it("does not pass storageState on first launch (nothing persisted yet)", async () => {
    await manager.getOrLaunch(1);
    expect(launchedBrowsers[0].contexts[0].storageStateOptions?.storageState).toBeUndefined();
  });
});
