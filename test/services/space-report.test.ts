import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectSpaceReport, type SpaceEntry } from "../../src/services/space-report.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "space-report-test-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function put(rel: string, kib: number) {
  const full = path.join(root, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, Buffer.alloc(kib * 1024, 1));
}

const names = (entries: SpaceEntry[] | undefined) =>
  (entries ?? []).map((e) => path.relative(root, e.path));

describe("space report", () => {
  it("lists the biggest entries by size, nested, with sizes adding up", async () => {
    await put("big/a/blob", 800);
    await put("big/b/blob", 100);
    await put("medium/blob", 300);
    await put("small.bin", 200);
    const report = await inspectSpaceReport({ root });
    expect(report.available).toBe(true);
    expect(names(report.entries)).toEqual(["big", "medium", "small.bin"]);
    const [big] = report.entries;
    expect(big.isDirectory).toBe(true);
    expect(names(big.children)).toEqual(["big/a", "big/b"]);
    expect(big.bytes).toBeGreaterThanOrEqual(900 * 1024);
    expect(report.scannedBytes).toBeGreaterThanOrEqual(1400 * 1024);
    // A file has no children.
    expect(report.entries[2].children).toBeUndefined();
    expect(report.filesystemUsedBytes).toBeGreaterThan(0);
    expect(report.outsideBytes).toBeGreaterThanOrEqual(0);
  });

  it("stops listing below the depth limit but still counts what is there", async () => {
    await put("a/b/c/deep/blob", 500);
    const report = await inspectSpaceReport({ root, depth: 2 });
    const [a] = report.entries;
    const [b] = a.children!;
    expect(b.path).toBe(path.join(root, "a", "b"));
    expect(b.children).toBeUndefined();
    expect(b.bytes).toBeGreaterThanOrEqual(500 * 1024);
  });

  it("keeps only the top entries by size", async () => {
    await put("one/blob", 900);
    await put("two/blob", 800);
    await put("three/blob", 700);
    const report = await inspectSpaceReport({ root, top: 2 });
    expect(names(report.entries)).toEqual(["one", "two"]);
  });

  it("still lists the biggest children when every one is a tiny share of a big parent", async () => {
    for (let i = 0; i < 150; i++) await put(`cache/d${String(i).padStart(3, "0")}/f`, 4);
    const report = await inspectSpaceReport({ root });
    const [cache] = report.entries;
    expect(cache.children).toHaveLength(8);
  });

  it("stops at its entry cap and says every figure is a lower bound", async () => {
    for (let i = 0; i < 30; i++) await put(`d${String(i)}/f`, 8);
    const capped = await inspectSpaceReport({ root, entryCap: 10 });
    expect(capped).toMatchObject({ available: true, truncated: true });
    const full = await inspectSpaceReport({ root });
    expect(capped.scannedBytes).toBeLessThan(full.scannedBytes);
    // What the walk never reached lands in the "outside" figure, an upper bound.
    // Asserted from each report alone: comparing two statfs readings of a shared
    // tmpdir would flake whenever another test writes between them.
    for (const report of [capped, full]) {
      expect(report.outsideBytes).toBe(
        Math.max(0, report.filesystemUsedBytes - report.scannedBytes),
      );
    }
    expect(full.truncated).toBe(false);
  });

  it("doesn't follow symlinks out of the tree", async () => {
    const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), "space-report-elsewhere-"));
    try {
      await fs.writeFile(path.join(elsewhere, "huge"), Buffer.alloc(2 * 1024 * 1024));
      await fs.symlink(elsewhere, path.join(root, "link"));
      await put("real/blob", 200);
      const report = await inspectSpaceReport({ root });
      expect(report.scannedBytes).toBeLessThan(1024 * 1024);
      expect(names(report.entries)).not.toContain("link/huge");
    } finally {
      await fs.rm(elsewhere, { recursive: true, force: true });
    }
  });

  it("tags the entries a cleanup source already owns, at any level", async () => {
    await put(".cache/uv/blob", 500);
    await put(".cache/other/blob", 400);
    await put(".local/share/opencode/opencode.db", 800);
    const report = await inspectSpaceReport({
      root,
      covered: [
        { path: path.join(root, ".cache", "uv"), label: "uv" },
        { path: path.join(root, ".local", "share", "opencode"), label: "opencode database" },
      ],
    });
    const cache = report.entries.find((e) => e.path === path.join(root, ".cache"))!;
    expect(cache.coveredBy).toBeUndefined();
    expect(cache.children!.find((c) => c.path.endsWith("uv"))?.coveredBy).toBe("uv");
    expect(cache.children!.find((c) => c.path.endsWith("other"))?.coveredBy).toBeUndefined();
    const share = report.entries.find((e) => e.path === path.join(root, ".local"))!;
    const opencode = share.children![0].children![0];
    expect(opencode).toMatchObject({ coveredBy: "opencode database" });
  });

  it("counts directories it can't read instead of failing", async () => {
    if (process.getuid?.() === 0) return; // root reads everything
    await put("ok/blob", 300);
    await put("locked/blob", 300);
    const locked = path.join(root, "locked");
    await fs.chmod(locked, 0o000);
    try {
      const report = await inspectSpaceReport({ root });
      expect(report.available).toBe(true);
      expect(report.unreadableEntries).toBe(1);
      expect(names(report.entries)).toContain("ok");
    } finally {
      await fs.chmod(locked, 0o700);
    }
  });

  it("reports an empty directory as empty, and a missing or non-directory root as unavailable", async () => {
    expect(await inspectSpaceReport({ root })).toMatchObject({ available: true, entries: [] });
    const missing = await inspectSpaceReport({ root: path.join(root, "nope") });
    expect(missing).toMatchObject({ available: false, entries: [] });
    expect(missing.error).toBeTruthy();
    await put("file", 4);
    const notDir = await inspectSpaceReport({ root: path.join(root, "file") });
    expect(notDir).toMatchObject({
      available: false,
      error: expect.stringContaining("not a directory"),
    });
  });
});
