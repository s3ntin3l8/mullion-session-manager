import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CACHE_DIR_IDS,
  inspectCacheStorage,
  pruneCacheStorage,
  sanitizeCacheDirIds,
} from "../../src/services/cache-storage.js";

let base: string;
let root: string;

async function fill(dir: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, dir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
}

const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false,
  );

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "cache-storage-test-"));
  root = path.join(base, ".cache");
  await fs.mkdir(root);
});
afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

describe("cache-storage", () => {
  it("sanitizes ids to the allowlist, once each", () => {
    expect(sanitizeCacheDirIds(["pip", "../etc", "pip", "huggingface", 7])).toEqual([
      "huggingface",
      "pip",
    ]);
    expect(sanitizeCacheDirIds("pip")).toEqual([]);
    expect(CACHE_DIR_IDS).toContain("ms-playwright");
  });

  it("reports sizes for existing caches and exists:false for the rest", async () => {
    await fill("pip", { "a/blob": "x".repeat(5000) });
    const status = await inspectCacheStorage({ cacheRoot: root });
    const pip = status.caches.find((c) => c.id === "pip");
    expect(pip).toMatchObject({ exists: true });
    expect(pip!.bytes).toBeGreaterThanOrEqual(5000);
    expect(status.caches.find((c) => c.id === "go-build")).toMatchObject({
      exists: false,
      bytes: 0,
    });
  });

  it("empties only the selected caches, keeps their directories, and ignores unknown ids", async () => {
    await fill("pip", { "a/blob": "x".repeat(4000), top: "y" });
    await fill("huggingface", { "m/w": "z".repeat(4000) });
    await fill("not-allowlisted", { keep: "k" });
    const result = await pruneCacheStorage(["pip", "not-allowlisted", "../.."], {
      cacheRoot: root,
    });
    expect(await exists(path.join(root, "pip"))).toBe(true);
    expect(await fs.readdir(path.join(root, "pip"))).toEqual([]);
    expect(await exists(path.join(root, "huggingface", "m", "w"))).toBe(true);
    expect(await exists(path.join(root, "not-allowlisted", "keep"))).toBe(true);
    expect(result.reclaimedBytes).toBeGreaterThanOrEqual(4000);
    expect(result.output).toContain("pip");
    expect(result.error).toBeUndefined();
  });

  it("does nothing when no caches are selected or a selected one is missing", async () => {
    await fill("pip", { f: "x" });
    expect(await pruneCacheStorage([], { cacheRoot: root })).toMatchObject({
      reclaimedBytes: 0,
      output: "Cleaned 0 caches.",
    });
    expect(await pruneCacheStorage(["go-build"], { cacheRoot: root })).toMatchObject({
      reclaimedBytes: 0,
    });
    expect(await exists(path.join(root, "pip", "f"))).toBe(true);
  });

  it("does not reach through a symlinked cache dir", async () => {
    const elsewhere = path.join(base, "data-disk");
    await fs.mkdir(elsewhere);
    await fs.writeFile(path.join(elsewhere, "precious"), "p");
    await fs.symlink(elsewhere, path.join(root, "huggingface"));
    const status = await inspectCacheStorage({ cacheRoot: root });
    expect(status.caches.find((c) => c.id === "huggingface")?.exists).toBe(false);
    await pruneCacheStorage(["huggingface"], { cacheRoot: root });
    expect(await exists(path.join(elsewhere, "precious"))).toBe(true);
  });

  it("reports entries it cannot remove and still cleans the rest", async () => {
    await fill("pip", { "locked/f": "x", "free/f": "y" });
    const locked = path.join(root, "pip", "locked");
    await fs.chmod(locked, 0o500);
    try {
      const result = await pruneCacheStorage(["pip"], { cacheRoot: root });
      expect(await exists(path.join(root, "pip", "free"))).toBe(false);
      if (process.getuid?.() !== 0) expect(result.error).toContain("pip/locked");
    } finally {
      await fs.chmod(locked, 0o700);
    }
  });

  it("reports an unreadable cache dir without failing or losing earlier work", async () => {
    await fill("huggingface", { "m/w": "z".repeat(3000) });
    await fill("pip", { f: "x" });
    const pip = path.join(root, "pip");
    await fs.chmod(pip, 0o000);
    try {
      const result = await pruneCacheStorage(["huggingface", "pip"], { cacheRoot: root });
      expect(await fs.readdir(path.join(root, "huggingface"))).toEqual([]);
      expect(result.reclaimedBytes).toBeGreaterThanOrEqual(3000);
      if (process.getuid?.() !== 0) expect(result.error).toContain("pip");
    } finally {
      await fs.chmod(pip, 0o700);
    }
  });

  it("rejects a concurrent prune", async () => {
    await fill(
      "pip",
      Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`d${String(i)}/f`, "x"])),
    );
    const first = pruneCacheStorage(["pip"], { cacheRoot: root });
    await expect(pruneCacheStorage(["pip"], { cacheRoot: root })).rejects.toThrow(
      "CACHE_PRUNE_IN_PROGRESS",
    );
    await first;
  });
});
