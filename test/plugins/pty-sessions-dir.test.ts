import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type * as ChildProcess from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ensureSessionsDir only touches the filesystem, but mock child_process so
// nothing in this file's import graph can ever fire a real systemd-run
// (issue #1137).
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return { ...actual, spawn: vi.fn() };
});

import { ensureSessionsDir } from "../../src/plugins/pty.js";
import { buildApp } from "../../src/app.js";

// A configured dir long enough to push the worst-case socket path past the
// 107-byte sun_path limit, forcing the /tmp/ms-<hash> fallback.
const configured = path.join(tmpdir(), "x".repeat(110), "sessions");
const hash = createHash("md5").update(path.resolve(configured)).digest("hex").slice(0, 8);
const fallback = `/tmp/ms-${hash}`;

function cleanup(): void {
  rmSync(fallback, { recursive: true, force: true });
}

describe("ensureSessionsDir /tmp fallback hardening (finding H4)", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("keeps the stable /tmp/ms-<hash> path and creates it 0700", () => {
    expect(ensureSessionsDir(configured)).toBe(fallback);
    expect(statSync(fallback).mode & 0o777).toBe(0o700);
  });

  it("tightens an existing looser directory we own to 0700 instead of refusing", () => {
    mkdirSync(fallback, { mode: 0o755 });
    chmodSync(fallback, 0o755);
    expect(ensureSessionsDir(configured)).toBe(fallback);
    expect(statSync(fallback).mode & 0o777).toBe(0o700);
  });

  it("fails loudly when the fallback is a symlink", () => {
    const target = path.join(tmpdir(), `ms-symlink-target-${process.pid}`);
    mkdirSync(target, { recursive: true });
    try {
      symlinkSync(target, fallback);
      expect(() => ensureSessionsDir(configured)).toThrow(/not a plain directory/);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("fails loudly when the directory is owned by another uid", () => {
    mkdirSync(fallback, { mode: 0o700 });
    const real = process.getuid!;
    const spy = vi.spyOn(process, "getuid").mockImplementation(() => real.call(process) + 1);
    try {
      expect(() => ensureSessionsDir(configured)).toThrow(/owned by uid/);
    } finally {
      spy.mockRestore();
    }
  });

  it("returns a short configured path untouched and creates nothing", () => {
    const short = "/tmp/ms-short-sessions-test";
    expect(ensureSessionsDir(short)).toBe(path.resolve(short));
    expect(existsSync(fallback)).toBe(false);
  });

  it("does not delete the fallback dir (live sockets/tokens) on app shutdown", async () => {
    const prev = process.env.SESSIONS_DIR;
    process.env.SESSIONS_DIR = configured;
    try {
      const app = await buildApp();
      // buildApp's ptyPlugin created the fallback dir; the old onClose
      // rmSync'd it. Nothing is written into it here — existence alone proves
      // the shutdown no longer deletes it.
      expect(existsSync(fallback)).toBe(true);
      await app.close();
      expect(existsSync(fallback)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.SESSIONS_DIR;
      else process.env.SESSIONS_DIR = prev;
    }
  });
});
