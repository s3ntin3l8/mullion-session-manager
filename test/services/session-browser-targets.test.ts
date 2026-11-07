import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Issue #2672 — an agent keeps a session's browser target across its own
// restart. A "restart" here is a fresh module instance (empty memory) pointed
// at the same directory.
const target = { projectId: 4, hostId: "h1", checkoutRoot: "/work/a", legacy: false };
const known = { get: () => ({}) };
const unknown = { get: () => undefined };

describe("session browser targets", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-targets-"));
    vi.resetModules();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const load = () => import("../../src/services/session-browser-targets.js");

  it("restores a target, endpoint included, after the agent restarts", async () => {
    const before = await load();
    const withEndpoint = { ...target, endpoint: "slug-1" };
    before.rememberSessionBrowserTarget(known, "10", withEndpoint, dir);
    vi.resetModules();
    const after = await load();
    expect(after.sessionBrowserTarget("10", dir)).toEqual(withEndpoint);
    expect(after.sessionBrowserTarget("11", dir)).toBeNull();
  });

  it("keeps the old memory-only behaviour without a directory", async () => {
    const mod = await load();
    mod.rememberSessionBrowserTarget(known, "10", target);
    mod.rememberSessionBrowserTarget(unknown, "11", target);
    expect(mod.sessionBrowserTarget("10")).toBeNull(); // pruned: its session is gone
    expect(mod.sessionBrowserTarget("11")).toEqual(target);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("does not prune a persisted target of a session the restarted PTY manager has not re-registered yet", async () => {
    const before = await load();
    before.rememberSessionBrowserTarget(known, "10", target, dir);
    vi.resetModules();
    const after = await load();
    after.rememberSessionBrowserTarget(unknown, "11", { ...target, projectId: 5 }, dir);
    expect(after.sessionBrowserTarget("10", dir)).toEqual(target);
  });

  it("forgets a terminated session, on disk too", async () => {
    const before = await load();
    before.rememberSessionBrowserTarget(known, "10", target, dir);
    before.forgetSessionBrowserTarget("10", dir);
    vi.resetModules();
    expect((await load()).sessionBrowserTarget("10", dir)).toBeNull();
  });

  it("drops entries for unknown sessions after the stale window", async () => {
    const mod = await load();
    mod.rememberSessionBrowserTarget(known, "10", target, dir);
    const file = path.join(dir, "browser-targets.json");
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    stored["10"].savedAt = Date.now() - 31 * 24 * 60 * 60 * 1000;
    fs.writeFileSync(file, JSON.stringify(stored));
    vi.resetModules();
    const fresh = await load();
    fresh.rememberSessionBrowserTarget(unknown, "11", target, dir);
    expect(fresh.sessionBrowserTarget("10", dir)).toBeNull();
  });

  it("keeps a session's target past the stale window while the session is seen alive (#2688)", async () => {
    const mod = await load();
    mod.rememberSessionBrowserTarget(known, "10", target, dir);
    const file = path.join(dir, "browser-targets.json");
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    stored["10"].savedAt = Date.now() - 31 * 24 * 60 * 60 * 1000;
    fs.writeFileSync(file, JSON.stringify(stored));
    vi.resetModules();
    const fresh = await load();
    // After the restart the PTY manager does not know the session yet, but the
    // primary's status poll sees it alive and refreshes the entry.
    fresh.sessionBrowserTarget("10", dir);
    fresh.touchSessionBrowserTarget("10", dir);
    fresh.rememberSessionBrowserTarget(unknown, "11", target, dir); // any other spawn prunes
    expect(fresh.sessionBrowserTarget("10", dir)).toEqual(target);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))["10"].savedAt).toBeGreaterThan(
      Date.now() - 60_000,
    );
  });

  it("ignores a corrupt or malformed state file", async () => {
    const file = path.join(dir, "browser-targets.json");
    fs.writeFileSync(file, "{not json");
    expect((await load()).sessionBrowserTarget("10", dir)).toBeNull();
    vi.resetModules();
    fs.writeFileSync(file, JSON.stringify({ "10": { target: { projectId: "x" }, savedAt: 1 } }));
    expect((await load()).sessionBrowserTarget("10", dir)).toBeNull();
  });
});
