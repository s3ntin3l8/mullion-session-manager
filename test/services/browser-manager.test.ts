import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";

// BrowserManager launches real Chromium via Playwright — CI has no browser
// available (see deploy/README.md's Playwright prerequisites), so
// chromium.launch is faked the same way test/services/pty-manager.test.ts
// fakes node-pty: hand-written Fake* classes standing in for Playwright's
// real Browser/BrowserContext/Page, with every launched instance collected
// for assertions. Never launch a real Chromium in a unit test.
const launchedBrowsers: FakeBrowser[] = [];
// Makes every FakeContext.newPage() throw while set (the open-failure tests).
let newPageError: Error | null = null;

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

  closeSpy = vi.fn(async () => {});

  async close() {
    await this.closeSpy();
  }

  async newPage() {
    if (newPageError) throw newPageError;
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

/** A project-default (legacy-mapped) target on the local host. */
const target = (projectId: number, checkoutRoot = `/work/p${projectId}`) => ({
  projectId,
  hostId: "local",
  checkoutRoot,
  legacy: true,
});

describe("BrowserManager", () => {
  let dataDir: string;
  let manager: InstanceType<typeof BrowserManager>;

  beforeEach(() => {
    newPageError = null;
    launchedBrowsers.length = 0;
    vi.mocked(chromium.launch).mockClear();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-manager-test-"));
    manager = new BrowserManager({ enabled: true, maxContexts: 2, dataDir });
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("throws on every method when disabled, without touching disk", async () => {
    const disabledDataDir = path.join(dataDir, "disabled-should-not-exist");
    const disabled = new BrowserManager({
      enabled: false,
      maxContexts: 2,
      dataDir: disabledDataDir,
    });
    expect(disabled.isEnabled()).toBe(false);
    await expect(disabled.getOrLaunch(target(1))).rejects.toThrow(/disabled/i);
    expect(fs.existsSync(disabledDataDir)).toBe(false);
  });

  it("launches headless Chromium with --no-sandbox", async () => {
    await manager.getOrLaunch(target(1));
    expect(vi.mocked(chromium.launch)).toHaveBeenCalledWith(
      expect.objectContaining({ headless: true, args: expect.arrayContaining(["--no-sandbox"]) }),
    );
  });

  it("reuses the pooled browser for the same project", async () => {
    const first = await manager.getOrLaunch(target(1));
    const second = await manager.getOrLaunch(target(1));
    expect(second).toBe(first);
    expect(launchedBrowsers).toHaveLength(1);
  });

  it("shares one Chromium process across targets, with a context each", async () => {
    const a = await manager.getOrLaunch(target(1));
    const b = await manager.getOrLaunch(target(2));
    expect(launchedBrowsers).toHaveLength(1);
    expect(manager.processCount).toBe(1);
    expect(manager.instanceCount).toBe(2);
    expect(a.browser).toBe(b.browser);
    expect(a.context).not.toBe(b.context);
    expect(a.page).not.toBe(b.page);
  });

  it("keeps cookies and downloads isolated per target", async () => {
    const withHook = new BrowserManager({
      enabled: true,
      maxContexts: 2,
      dataDir,
      loadCookies: async (id) =>
        id === 1
          ? [{ name: "s", value: "v", domain: "a.test", path: "/", httpOnly: false, secure: false }]
          : [],
    });
    const a = await withHook.getOrLaunch(target(1));
    const b = await withHook.getOrLaunch(target(2));
    expect((a.context as unknown as FakeContext).addCookiesSpy).toHaveBeenCalledTimes(1);
    expect((b.context as unknown as FakeContext).addCookiesSpy).not.toHaveBeenCalled();

    (a.page as unknown as FakePage).emit("download", new FakeDownload("a.csv"));
    (b.page as unknown as FakePage).emit("download", new FakeDownload("b.csv"));
    await vi.waitFor(() => {
      expect(a.downloads).toHaveLength(1);
      expect(b.downloads).toHaveLength(1);
    });
    expect(path.dirname(a.downloads[0].path)).not.toBe(path.dirname(b.downloads[0].path));
    await withHook.closeAll();
  });

  it("closing one target leaves the other and the process open", async () => {
    const a = await manager.getOrLaunch(target(1));
    const b = await manager.getOrLaunch(target(2));
    await manager.closeTarget(target(1));
    expect(a.closed).toBe(true);
    expect((a.context as unknown as FakeContext).closeSpy).toHaveBeenCalled();
    expect(b.closed).toBe(false);
    expect(manager.get(target(2))).toBe(b);
    expect(launchedBrowsers[0].closeSpy).not.toHaveBeenCalled();
    expect(manager.processCount).toBe(1);
  });

  it("closes the process after the last target closes and relaunches on demand", async () => {
    await manager.getOrLaunch(target(1));
    await manager.getOrLaunch(target(2));
    await manager.closeTarget(target(1));
    await manager.closeTarget(target(2));
    expect(launchedBrowsers[0].closeSpy).toHaveBeenCalled();
    expect(manager.processCount).toBe(0);
    await manager.getOrLaunch(target(1));
    expect(launchedBrowsers).toHaveLength(2);
  });

  it("gives two endpoints of one checkout separate contexts", async () => {
    const a = await manager.getOrLaunch({ ...target(1), endpoint: "http://localhost:3000" });
    const b = await manager.getOrLaunch({ ...target(1), endpoint: "http://localhost:4000" });
    expect(a).not.toBe(b);
    expect(a.context).not.toBe(b.context);
    const paths = manager as unknown as {
      storageStatePath(t: unknown): string;
      downloadsDir(t: unknown): string;
    };
    expect(paths.storageStatePath(a.target)).not.toBe(paths.storageStatePath(b.target));
    expect(paths.downloadsDir(a.target)).not.toBe(paths.downloadsDir(b.target));
    expect(launchedBrowsers).toHaveLength(1);
    // A caller with no endpoint is the legacy value, distinct from both.
    const legacy = await manager.getOrLaunch(target(1)).catch((e) => e);
    expect(String(legacy)).toMatch(/pool exhausted/i);
  });

  it("closes the context it created when a later open step throws, and does not count it (#2672)", async () => {
    await manager.getOrLaunch(target(1));
    newPageError = new Error("newPage failed");
    await expect(manager.getOrLaunch(target(2))).rejects.toThrow(/newPage failed/);
    const failed = launchedBrowsers[0].contexts[1];
    expect(failed.closeSpy).toHaveBeenCalledTimes(1);
    expect(manager.instanceCount).toBe(1);
    // The slot is free again: a third target fits under maxContexts (2).
    newPageError = null;
    await expect(manager.getOrLaunch(target(3))).resolves.toBeDefined();
    expect(manager.instanceCount).toBe(2);
  });

  it("shuts the process down when the only open attempt failed (#2672)", async () => {
    newPageError = new Error("newPage failed");
    await expect(manager.getOrLaunch(target(1))).rejects.toThrow(/newPage failed/);
    expect(launchedBrowsers[0].contexts[0].closeSpy).toHaveBeenCalled();
    expect(launchedBrowsers[0].closeSpy).toHaveBeenCalled();
    expect(manager.processCount).toBe(0);
  });

  it("makes a relaunch wait for the target's close to finish, then starts clean (#2672)", async () => {
    const first = await manager.getOrLaunch(target(1));
    const ctx = first.context as unknown as FakeContext;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    ctx.closeSpy.mockImplementation(() => gate);

    const closing = manager.closeTarget(target(1));
    await vi.waitFor(() => expect(ctx.closeSpy).toHaveBeenCalled());
    // The entry is out of the pool but still saving its storage state.
    const downloadsDir = path.join(dataDir, "downloads", "project-1");
    fs.mkdirSync(downloadsDir, { recursive: true });
    fs.writeFileSync(path.join(downloadsDir, "saving.bin"), "x");

    let relaunched = false;
    const relaunch = manager.getOrLaunch(target(1)).then((m) => {
      relaunched = true;
      return m;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(relaunched).toBe(false);
    expect(fs.existsSync(path.join(downloadsDir, "saving.bin"))).toBe(true);
    expect(launchedBrowsers[0].contexts).toHaveLength(1);

    release();
    await closing;
    const second = await relaunch;
    expect(second).not.toBe(first);
    expect(launchedBrowsers.flatMap((b) => b.contexts)).toHaveLength(2);
    expect(fs.existsSync(path.join(downloadsDir, "saving.bin"))).toBe(false);
  });

  it("counts a closing target against maxContexts until its close finishes (#2672)", async () => {
    const a = await manager.getOrLaunch(target(1));
    await manager.getOrLaunch(target(2));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    (a.context as unknown as FakeContext).closeSpy.mockImplementation(() => gate);
    const closing = manager.closeTarget(target(1));
    await vi.waitFor(() => expect(manager.instanceCount).toBe(1));
    await expect(manager.getOrLaunch(target(3))).rejects.toThrow(/pool exhausted/i);
    release();
    await closing;
    await expect(manager.getOrLaunch(target(3))).resolves.toBeDefined();
  });

  it("keeps the process up while another target is still closing (#2672)", async () => {
    const a = await manager.getOrLaunch(target(1));
    const b = await manager.getOrLaunch(target(2));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    (b.context as unknown as FakeContext).closeSpy.mockImplementation(() => gate);
    const closingB = manager.closeTarget(target(2));
    await manager.closeTarget(target(1));
    expect(a.closed).toBe(true);
    expect(launchedBrowsers[0].closeSpy).not.toHaveBeenCalled();
    release();
    await closingB;
    expect(launchedBrowsers[0].closeSpy).toHaveBeenCalled();
  });

  it("tells a holder when its target is closed, by a close or a crash (#2672)", async () => {
    const a = await manager.getOrLaunch(target(1));
    const b = await manager.getOrLaunch(target(2));
    const onA = vi.fn();
    const onB = vi.fn();
    a.onClosed(onA);
    const off = b.onClosed(onB);
    await manager.closeTarget(target(1));
    expect(onA).toHaveBeenCalledTimes(1);
    off();
    (b.browser as unknown as FakeBrowser).simulateCrash();
    expect(onB).not.toHaveBeenCalled();
    // Registering after the fact reports at once rather than never.
    const late = vi.fn();
    b.onClosed(late);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it("enforces maxContexts per process", async () => {
    await manager.getOrLaunch(target(1));
    await manager.getOrLaunch(target(2));
    await expect(manager.getOrLaunch(target(3))).rejects.toThrow(/pool exhausted/i);
    expect(launchedBrowsers).toHaveLength(1);
  });

  it("a crash closes every target, and the next request relaunches", async () => {
    const first = await manager.getOrLaunch(target(1));
    const other = await manager.getOrLaunch(target(2));
    (first.browser as unknown as FakeBrowser).simulateCrash();
    expect(first.closed).toBe(true);
    expect(other.closed).toBe(true);
    expect(manager.instanceCount).toBe(0);
    const second = await manager.getOrLaunch(target(1));
    expect(second).not.toBe(first);
    expect(second.closed).toBe(false);
    expect(launchedBrowsers).toHaveLength(2);
  });

  it("healthCheck evicts a disconnected instance lazily (no proactive relaunch)", async () => {
    const first = await manager.getOrLaunch(target(1));
    (first.browser as unknown as FakeBrowser).connected = false;
    manager.healthCheck();
    expect(manager.get(target(1))).toBeUndefined();
    expect(launchedBrowsers).toHaveLength(1); // no relaunch until next getOrLaunch
  });

  it("persists storage state and closes the browser on closeForProject", async () => {
    const managed = await manager.getOrLaunch(target(1));
    await manager.closeForProject(1);
    expect((managed.context as unknown as FakeContext).storageStateSpy).toHaveBeenCalledWith({
      path: path.join(dataDir, "project-1.json"),
    });
    expect((managed.browser as unknown as FakeBrowser).closeSpy).toHaveBeenCalled();
    expect(manager.get(target(1))).toBeUndefined();
  });

  it("closeForProject is a no-op when nothing is running for that project", async () => {
    await expect(manager.closeForProject(999)).resolves.toBeUndefined();
  });

  describe("execution targets (#2448)", () => {
    it("reuses one browser for the same target, however many sessions ask", async () => {
      const first = await manager.getOrLaunch(target(1, "/work/a"));
      const second = await manager.getOrLaunch(target(1, "/work/a"));
      expect(second).toBe(first);
      expect(launchedBrowsers).toHaveLength(1);
    });

    it("isolates two checkouts of the same project: own browser, own cookies/storage file", async () => {
      const main = await manager.getOrLaunch(target(1, "/work/main"));
      const wt = await manager.getOrLaunch({ ...target(1, "/work/wt"), legacy: false });
      expect(wt).not.toBe(main);
      expect(launchedBrowsers).toHaveLength(1);
      await manager.closeTarget(main.target);
      await manager.closeTarget(wt.target);
      const paths = [main, wt].map(
        (m) => (m.context as unknown as FakeContext).storageStateSpy.mock.calls[0]![0]!.path,
      );
      // The default target keeps the pre-target file; the other never shares it.
      expect(paths[0]).toBe(path.join(dataDir, "project-1.json"));
      expect(paths[1]).toMatch(/project-1-[0-9a-f]{16}\.json$/);
      expect(paths[1]).not.toBe(paths[0]);
    });

    it("keeps separate download directories per target", async () => {
      const a = await manager.getOrLaunch(target(1, "/work/a"));
      const b = await manager.getOrLaunch({ ...target(1, "/work/b"), legacy: false });
      expect(a).not.toBe(b);
      expect(manager.get(target(1, "/work/a"))).toBe(a);
      expect(manager.get(target(1, "/work/b"))).toBe(b);
    });

    it("closeTarget closes only that target; closeForProject closes the rest of a project's", async () => {
      const a = await manager.getOrLaunch(target(1, "/work/a"));
      const b = await manager.getOrLaunch(target(1, "/work/b"));
      await manager.closeTarget(a.target);
      expect(manager.get(a.target)).toBeUndefined();
      expect(manager.get(b.target)).toBe(b);
      const other = await manager.getOrLaunch(target(2));
      await manager.closeForProject(1);
      expect(manager.get(b.target)).toBeUndefined();
      expect(manager.get(other.target)).toBe(other);
    });
  });

  it("closeAll closes every pooled browser", async () => {
    const one = await manager.getOrLaunch(target(1));
    const two = await manager.getOrLaunch(target(2));
    await manager.closeAll();
    expect((one.browser as unknown as FakeBrowser).closeSpy).toHaveBeenCalled();
    expect((two.browser as unknown as FakeBrowser).closeSpy).toHaveBeenCalled();
    expect(manager.instanceCount).toBe(0);
  });

  it("reuses persisted storage state on relaunch after a clean close", async () => {
    await manager.getOrLaunch(target(1));
    await manager.closeForProject(1);
    await manager.getOrLaunch(target(1));
    const secondContext = launchedBrowsers[1].contexts[0];
    expect(secondContext.storageStateOptions?.storageState).toBe(
      path.join(dataDir, "project-1.json"),
    );
  });

  it("loads the legacy project-<id>.json for a default-checkout target, and only for it (#2672)", async () => {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, "project-1.json"),
      JSON.stringify({ cookies: [], origins: [] }),
    );
    await manager.getOrLaunch(target(1)); // legacy, no endpoint
    await manager.getOrLaunch({ ...target(1), endpoint: "prev-a" }); // same checkout, a preview
    const [legacy, preview] = launchedBrowsers[0].contexts;
    expect(legacy.storageStateOptions?.storageState).toBe(path.join(dataDir, "project-1.json"));
    expect(preview.storageStateOptions?.storageState).toBeUndefined();
  });

  it("does not pass storageState on first launch (nothing persisted yet)", async () => {
    await manager.getOrLaunch(target(1));
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
      const withHook = new BrowserManager({ enabled: true, maxContexts: 2, dataDir, loadCookies });

      const managed = await withHook.getOrLaunch(target(1));

      expect(loadCookies).toHaveBeenCalledWith(1);
      expect((managed.context as unknown as FakeContext).addCookiesSpy).toHaveBeenCalledWith(
        cookies,
      );
    });

    it("does not call addCookies when loadCookies returns an empty array", async () => {
      const loadCookies = vi.fn().mockResolvedValue([]);
      const withHook = new BrowserManager({ enabled: true, maxContexts: 2, dataDir, loadCookies });

      const managed = await withHook.getOrLaunch(target(1));

      expect((managed.context as unknown as FakeContext).addCookiesSpy).not.toHaveBeenCalled();
    });

    it("still launches successfully when loadCookies throws, and reports it via onCookieLoadError", async () => {
      const loadError = new Error("decrypt failed");
      const loadCookies = vi.fn().mockRejectedValue(loadError);
      const onCookieLoadError = vi.fn();
      const withHook = new BrowserManager({
        enabled: true,
        maxContexts: 2,
        dataDir,
        loadCookies,
        onCookieLoadError,
      });

      await expect(withHook.getOrLaunch(target(1))).resolves.toBeDefined();
      expect(onCookieLoadError).toHaveBeenCalledWith(1, loadError);
    });

    it("still launches successfully when loadCookies throws and no onCookieLoadError is provided", async () => {
      const loadCookies = vi.fn().mockRejectedValue(new Error("decrypt failed"));
      const withHook = new BrowserManager({ enabled: true, maxContexts: 2, dataDir, loadCookies });

      await expect(withHook.getOrLaunch(target(1))).resolves.toBeDefined();
    });

    it("never calls loadCookies when it isn't provided", async () => {
      // `manager` (the describe block's default instance) has no loadCookies
      // configured — this just confirms launching still works with none.
      const managed = await manager.getOrLaunch(target(1));
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
      const managed = await manager.getOrLaunch(target(1));
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
      const managed = await manager.getOrLaunch(target(1));
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
      const managed = await manager.getOrLaunch(target(1));
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
      const managed = await manager.getOrLaunch(target(1));
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
      const first = await manager.getOrLaunch(target(1));
      const firstPage = first.page as unknown as FakePage;
      firstPage.emit("download", new FakeDownload("stale-from-before-restart.csv"));
      await flush(() => first.downloads.length === 1);
      const staleDir = path.join(dataDir, "downloads", "project-1");
      expect(fs.readdirSync(staleDir)).toHaveLength(1);

      await manager.closeForProject(1);

      const second = await manager.getOrLaunch(target(1));
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
        maxContexts: 2,
        dataDir,
        onDownloadError,
      });
      const managed = await withHook.getOrLaunch(target(1));
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
      const managed = await manager.getOrLaunch(target(1));
      const page = managed.page as unknown as FakePage;

      page.emit("download", new FakeDownload("a.csv"));
      await flush(() => managed.downloads.length === 1);

      expect(managed.downloads).toHaveLength(1);
    });
  });
});
