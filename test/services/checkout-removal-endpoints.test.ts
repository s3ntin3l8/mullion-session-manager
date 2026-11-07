import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { BrowserManager, type BrowserTarget } from "../../src/services/browser-manager.js";
import * as sessionBackendModule from "../../src/services/session-backend.js";
import * as sessionBrowsers from "../../src/services/session-browsers.js";
import {
  clearOrphanedCheckout,
  pruneCheckouts,
  removeListedCheckout,
} from "../../src/services/checkout-removal.js";

// Issue #2700 — a checkout's storage goes with it, including the files of
// endpoint contexts that were already stopped, and every removal variant
// releases the browsers.
type Internals = {
  storageStatePath(t: BrowserTarget): string;
  downloadsDir(t: BrowserTarget): string;
  recordEndpoint(t: BrowserTarget): void;
};

describe("forgetCheckout finds stopped endpoint contexts", () => {
  let dataDir: string;
  let manager: BrowserManager;
  const checkout = "/work/p/.mullion-worktrees/mullion-task-9";
  const base = { projectId: 4, hostId: "local", checkoutRoot: checkout, legacy: false };

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-endpoints-"));
    manager = new BrowserManager({ enabled: true, maxContexts: 2, dataDir });
  });
  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const leave = (t: BrowserTarget) => {
    const i = manager as unknown as Internals;
    fs.writeFileSync(i.storageStatePath(t), "{}");
    fs.mkdirSync(i.downloadsDir(t), { recursive: true });
    fs.writeFileSync(path.join(i.downloadsDir(t), "f.txt"), "x");
    return { file: i.storageStatePath(t), dir: i.downloadsDir(t) };
  };

  it("deletes the endpoint-keyed file and downloads of a stopped context", async () => {
    const t: BrowserTarget = { ...base, endpoint: "http://localhost:5173" };
    (manager as unknown as Internals).recordEndpoint(t);
    const { file, dir } = leave(t);
    const other = leave({ ...base, checkoutRoot: "/work/p/other" });

    await manager.forgetCheckout(4, "local", checkout);

    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(other.file)).toBe(true); // another checkout is untouched
    expect(fs.readdirSync(dataDir).filter((f) => f.endsWith(".endpoints"))).toEqual([]);
  });

  it("keeps the project default file", async () => {
    const legacy: BrowserTarget = { ...base, checkoutRoot: "/work/p", legacy: true };
    const { file } = leave(legacy);
    await manager.forgetTarget(legacy);
    expect(fs.existsSync(file)).toBe(true);
  });
});

describe("removal variants release browsers", () => {
  const app = {} as FastifyInstance;
  const ref = { projectId: 4, hostId: "local", worktreePath: "/w/a", cwd: "/w" };
  let close: ReturnType<typeof vi.spyOn>;
  const backend = {
    removeListedWorktree: vi.fn(),
    pruneWorktrees: vi.fn(),
    clearOrphanedTaskWorktree: vi.fn(),
  };

  beforeEach(() => {
    close = vi.spyOn(sessionBrowsers, "closeCheckoutBrowsers").mockResolvedValue();
    vi.spyOn(sessionBackendModule, "resolveBackend").mockReturnValue(
      backend as unknown as ReturnType<typeof sessionBackendModule.resolveBackend>,
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it("removeListedCheckout releases on removed and directory-gone, not on a refusal", async () => {
    backend.removeListedWorktree.mockResolvedValueOnce({ removed: true });
    await removeListedCheckout(app, ref);
    backend.removeListedWorktree.mockResolvedValueOnce({
      removed: false,
      reason: "directory-gone",
    });
    await removeListedCheckout(app, ref);
    expect(close).toHaveBeenCalledTimes(2);
    backend.removeListedWorktree.mockResolvedValueOnce({ removed: false, reason: "dirty" });
    await removeListedCheckout(app, ref);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("pruneCheckouts releases each removed worktree only", async () => {
    backend.pruneWorktrees.mockResolvedValue({
      removed: ["/w/a", "/w/b"],
      skipped: [{ path: "/w/c", reason: "dirty" }],
    });
    await pruneCheckouts(app, { projectId: 4, hostId: "local", cwd: "/w" }, [
      "/w/a",
      "/w/b",
      "/w/c",
    ]);
    expect(close.mock.calls.map((c: unknown[]) => c[3])).toEqual(["/w/a", "/w/b"]);
  });

  it("clearOrphanedCheckout releases only when cleared", async () => {
    backend.clearOrphanedTaskWorktree.mockResolvedValueOnce({ cleared: false, reason: "dirty" });
    await clearOrphanedCheckout(app, ref, "b");
    expect(close).not.toHaveBeenCalled();
    backend.clearOrphanedTaskWorktree.mockResolvedValueOnce({ cleared: true });
    await clearOrphanedCheckout(app, ref, "b");
    expect(close).toHaveBeenCalledWith(app, 4, "local", "/w/a");
  });
});
