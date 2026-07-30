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

  addCookiesSpy = vi.fn(async (_cookies: unknown[]) => {});

  async newPage() {
    return new FakePage();
  }

  async addCookies(cookies: unknown[]) {
    return this.addCookiesSpy(cookies);
  }

  async storageState(opts?: { path: string }) {
    return this.storageStateSpy(opts);
  }
}

class FakePage extends EventEmitter {}

// Issue #381 (3.10) — a fake Playwright `Download`: implements exactly the
// surface BrowserManager's page.on("download") handler calls
// (suggestedFilename/url/saveAs). saveAs actually writes bytes to the given
// path (mirroring FakeContext.storageStateSpy's own "real enough to exercise
// real fs logic" precedent above), so eviction's file-deletion and the
// route layer's file-reading can both be tested against a real file on
// disk, not just a spy call.
class FakeDownload {
  constructor(
    private readonly filename: string,
    private readonly urlValue = "http://example.com/file",
    private readonly contents = Buffer.from("fake download contents"),
  ) {}

  saveAsSpy = vi.fn(async (destPath: string) => {
    fs.writeFileSync(destPath, this.contents);
  });

  suggestedFilename() {
    return this.filename;
  }

  url() {
    return this.urlValue;
  }

  async saveAs(destPath: string) {
    return this.saveAsSpy(destPath);
  }
}

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

  describe("loadCookies hook (issue #184)", () => {
    it("applies cookies returned by loadCookies to the context on launch", async () => {
      const cookies = [
        {
          name: "sid",
          value: "abc",
          domain: "example.com",
          path: "/",
          httpOnly: true,
          secure: true,
        },
      ];
      const loadCookies = vi.fn().mockResolvedValue(cookies);
      const withHook = new BrowserManager({ enabled: true, maxInstances: 2, dataDir, loadCookies });

      const managed = await withHook.getOrLaunch(1);

      expect(loadCookies).toHaveBeenCalledWith(1);
      expect((managed.context as unknown as FakeContext).addCookiesSpy).toHaveBeenCalledWith(
        cookies,
      );
    });

    it("does not call addCookies when loadCookies returns an empty array", async () => {
      const loadCookies = vi.fn().mockResolvedValue([]);
      const withHook = new BrowserManager({ enabled: true, maxInstances: 2, dataDir, loadCookies });

      const managed = await withHook.getOrLaunch(1);

      expect((managed.context as unknown as FakeContext).addCookiesSpy).not.toHaveBeenCalled();
    });

    it("still launches successfully when loadCookies throws, and reports it via onCookieLoadError", async () => {
      const loadError = new Error("decrypt failed");
      const loadCookies = vi.fn().mockRejectedValue(loadError);
      const onCookieLoadError = vi.fn();
      const withHook = new BrowserManager({
        enabled: true,
        maxInstances: 2,
        dataDir,
        loadCookies,
        onCookieLoadError,
      });

      await expect(withHook.getOrLaunch(1)).resolves.toBeDefined();
      expect(onCookieLoadError).toHaveBeenCalledWith(1, loadError);
    });

    it("still launches successfully when loadCookies throws and no onCookieLoadError is provided", async () => {
      const loadCookies = vi.fn().mockRejectedValue(new Error("decrypt failed"));
      const withHook = new BrowserManager({ enabled: true, maxInstances: 2, dataDir, loadCookies });

      await expect(withHook.getOrLaunch(1)).resolves.toBeDefined();
    });

    it("never calls loadCookies when it isn't provided", async () => {
      // `manager` (the describe block's default instance) has no loadCookies
      // configured — this just confirms launching still works with none.
      const managed = await manager.getOrLaunch(1);
      expect((managed.context as unknown as FakeContext).addCookiesSpy).not.toHaveBeenCalled();
    });
  });

  describe("downloads buffer (issue #381, 3.10)", () => {
    /** Waits for the async page.on("download") handler (which awaits
     * saveAs/stat/eviction's own rm internally) to actually reach the given
     * state, polling rather than a single fixed sleep — a blind setTimeout
     * is exactly the kind of thing that's usually "enough" but flakes under
     * load (e.g. the eviction test below, whose handler chain — mkdir,
     * write, stat, splice, unlink — needs to fully settle for EVERY one of
     * 51 emitted downloads before its final on-disk assertion). */
    async function flush(predicate: () => boolean = () => true, timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs;
      while (!predicate() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    it("saves a completed download and records it in managed.downloads", async () => {
      const managed = await manager.getOrLaunch(1);
      const page = managed.page as unknown as FakePage;
      const download = new FakeDownload("report.csv");

      page.emit("download", download);
      await flush(() => managed.downloads.length === 1);

      expect(managed.downloads).toHaveLength(1);
      const entry = managed.downloads[0];
      expect(entry.filename).toBe("report.csv");
      expect(entry.url).toBe("http://example.com/file");
      expect(entry.size).toBe(Buffer.from("fake download contents").length);
      expect(fs.existsSync(entry.path)).toBe(true);
      expect(entry.path).toContain(path.join("downloads", "project-1"));
    });

    it("sanitizes a suggestedFilename containing path separators and '..' traversal, never escaping the intended directory", async () => {
      const managed = await manager.getOrLaunch(1);
      const page = managed.page as unknown as FakePage;
      const download = new FakeDownload("../../../etc/passwd");

      page.emit("download", download);
      await flush(() => managed.downloads.length === 1);

      expect(managed.downloads).toHaveLength(1);
      const entry = managed.downloads[0];
      const expectedDir = path.join(dataDir, "downloads", "project-1");
      expect(path.resolve(entry.path).startsWith(path.resolve(expectedDir) + path.sep)).toBe(true);
      expect(entry.filename).not.toContain("..");
      expect(entry.filename).not.toContain("/");
    });

    it("sanitizes backslashes too (Windows-style traversal), not just forward slashes", async () => {
      const managed = await manager.getOrLaunch(1);
      const page = managed.page as unknown as FakePage;
      const download = new FakeDownload("..\\..\\windows\\system32\\evil.exe");

      page.emit("download", download);
      await flush(() => managed.downloads.length === 1);

      const entry = managed.downloads[0];
      const expectedDir = path.join(dataDir, "downloads", "project-1");
      expect(path.resolve(entry.path).startsWith(path.resolve(expectedDir) + path.sep)).toBe(true);
      expect(entry.filename).not.toContain("..");
      expect(entry.filename).not.toContain("\\");
    });

    it("evicts the oldest entries beyond the 50-entry cap and deletes their files", async () => {
      const managed = await manager.getOrLaunch(1);
      const page = managed.page as unknown as FakePage;
      const dir = path.join(dataDir, "downloads", "project-1");

      // Emit one at a time, polling for that download's own entry to land
      // before firing the next — NOT a per-iteration fixed sleep (flaky:
      // the handler's mkdir/saveAs/stat/push/evict-and-unlink chain doing
      // real, if tiny, disk I/O 51 times over won't reliably fit inside an
      // arbitrary constant), and not fire-all-then-wait-once either (with
      // no ordering guarantee between concurrently in-flight handlers, the
      // "file-0 was the one evicted" assertion below would be racy).
      for (let i = 0; i < 51; i++) {
        page.emit("download", new FakeDownload(`file-${i}.txt`));
        await flush(() => managed.downloads.at(-1)?.filename === `file-${i}.txt`);
      }
      // The in-memory splice (eviction) happens synchronously right after
      // that last push, but the evicted entry's own file deletion is a
      // separate awaited `rm()` after it — wait for the on-disk state to
      // actually settle too before asserting against it below.
      await flush(() => fs.readdirSync(dir).length === 50);

      expect(managed.downloads).toHaveLength(50);
      // The oldest (file-0) was evicted — its file must be deleted from disk,
      // not just dropped from the in-memory list.
      expect(managed.downloads.some((d) => d.filename === "file-0.txt")).toBe(false);
      expect(managed.downloads.some((d) => d.filename === "file-50.txt")).toBe(true);

      const remainingFiles = fs.readdirSync(dir);
      expect(remainingFiles).toHaveLength(50);
      expect(remainingFiles.some((f) => f.endsWith("file-0.txt"))).toBe(false);
    });

    it("sweeps a project's stale downloads directory on a fresh relaunch, not just within one launch's own eviction (independent review finding)", async () => {
      // The 50-entry eviction test above only bounds growth WITHIN one
      // launch's lifetime — its `downloads` array is a closure variable
      // that has no memory of files a PRIOR instance saved for this same
      // project. Simulates the restart/relaunch case (redeploy, this
      // project's browser closed and reopened, a crash-triggered
      // relaunch): a file saved before close() must not survive an
      // unrelated fresh launch finding it still on disk with nothing
      // tracking it anymore.
      const first = await manager.getOrLaunch(1);
      const firstPage = first.page as unknown as FakePage;
      firstPage.emit("download", new FakeDownload("stale-from-before-restart.csv"));
      await flush(() => first.downloads.length === 1);
      const staleDir = path.join(dataDir, "downloads", "project-1");
      expect(fs.readdirSync(staleDir)).toHaveLength(1);

      await manager.closeForProject(1);

      const second = await manager.getOrLaunch(1);
      expect(second).not.toBe(first);
      expect(second.downloads).toHaveLength(0);
      // The directory itself may or may not still exist (rm -rf then a
      // fresh mkdir on the next real download), but it must not still
      // contain the stale file from before the restart.
      const remaining = fs.existsSync(staleDir) ? fs.readdirSync(staleDir) : [];
      expect(remaining).toHaveLength(0);
    });

    it("reports a saveAs failure via onDownloadError instead of throwing out of the event handler", async () => {
      const onDownloadError = vi.fn();
      const withHook = new BrowserManager({
        enabled: true,
        maxInstances: 2,
        dataDir,
        onDownloadError,
      });
      const managed = await withHook.getOrLaunch(1);
      const page = managed.page as unknown as FakePage;
      const download = new FakeDownload("report.csv");
      const saveError = new Error("disk full");
      download.saveAsSpy.mockRejectedValueOnce(saveError);

      page.emit("download", download);
      await flush(() => onDownloadError.mock.calls.length > 0);

      expect(onDownloadError).toHaveBeenCalledWith(1, saveError);
      expect(managed.downloads).toHaveLength(0);
    });

    it("still records a completed download when no onDownloadError is provided", async () => {
      // `manager` (the describe block's default instance) has no
      // onDownloadError configured — confirms the happy path doesn't depend
      // on that hook being wired.
      const managed = await manager.getOrLaunch(1);
      const page = managed.page as unknown as FakePage;

      page.emit("download", new FakeDownload("a.csv"));
      await flush(() => managed.downloads.length === 1);

      expect(managed.downloads).toHaveLength(1);
    });
  });
});
