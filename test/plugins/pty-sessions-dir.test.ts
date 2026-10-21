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

import { ensureSessionsDir, maxSunPathBytes } from "../../src/plugins/pty.js";
import { buildApp } from "../../src/app.js";

// A configured dir long enough to push the worst-case socket path past the
// sun_path limit, forcing the short fallback.
const configured = path.join(tmpdir(), "x".repeat(110), "sessions");
const hash = createHash("md5").update(path.resolve(configured)).digest("hex").slice(0, 8);
// Issue #1717 — the fallback lives under the platform's TEMP DIR now, not a
// hardcoded /tmp: on macOS `os.tmpdir()` is a per-user directory
// (/var/folders/.../T), which is both correct there and safer than a
// world-writable /tmp.
const fallback = path.join(tmpdir(), `ms-${hash}`);

// The longest socket name a sessions dir has to hold: a 12-digit
// session-id socket.
const LONGEST_SOCKET = "999999999999.sock";

/** A sessions dir whose longest socket path is exactly `total` bytes. */
function dirWithLongestSocket(total: number): string {
  const base = tmpdir();
  // Padding one byte at a time until the longest socket path reaches
  // `total` — computed rather than derived, so the helper cannot drift out
  // of step with the length arithmetic it is standing in for.
  for (let padding = 0; ; padding++) {
    const dir = path.join(base, "y".repeat(padding), "sessions");
    const length = Buffer.byteLength(path.join(dir, LONGEST_SOCKET), "utf8");
    if (length >= total) {
      expect(length).toBe(total);
      return dir;
    }
  }
}

/** Runs `fn` with `process.platform` reporting as `platform`. */
function withPlatform(platform: NodeJS.Platform, fn: () => void): void {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    fn();
  } finally {
    Object.defineProperty(process, "platform", { value: original, configurable: true });
  }
}

function cleanup(): void {
  rmSync(fallback, { recursive: true, force: true });
}

describe("maxSunPathBytes", () => {
  it("is 108 on Linux and 104 on macOS", () => {
    // macOS's sockaddr_un has a 104-byte sun_path; Linux's has 108. The
    // four-byte difference is the whole bug: a path in that window passes
    // the check on Linux and then fails at bind() on a Mac.
    expect(maxSunPathBytes("linux")).toBe(108);
    expect(maxSunPathBytes("darwin")).toBe(104);
  });

  it("defaults to the platform this process runs on", () => {
    expect(maxSunPathBytes()).toBe(maxSunPathBytes(process.platform));
  });
});

describe("ensureSessionsDir — platform-aware sun_path limit (issue #1717)", () => {
  it("keeps a path that fits the platform's limit", () => {
    // 103 bytes is the longest usable path on macOS (the limit counts the
    // NUL terminator), so it must be kept on BOTH platforms.
    const dir = dirWithLongestSocket(103);
    for (const platform of ["linux", "darwin"] as NodeJS.Platform[]) {
      withPlatform(platform, () => {
        expect(ensureSessionsDir(dir)).toBe(path.resolve(dir));
      });
    }
  });

  it("rejects a path that fits Linux but NOT macOS", () => {
    // 104 bytes is inside Linux's 108-byte limit and outside macOS's
    // 104-byte one (only 103 are usable). Accepting it on macOS would let
    // the path through the check and then fail at bind() — a bare EINVAL
    // with nothing pointing at the path.
    const dir = dirWithLongestSocket(104);
    withPlatform("linux", () => {
      expect(ensureSessionsDir(dir)).toBe(path.resolve(dir));
    });
    withPlatform("darwin", () => {
      expect(ensureSessionsDir(dir)).not.toBe(path.resolve(dir));
    });
  });

  it("rejects a path that fits neither platform's limit", () => {
    const dir = dirWithLongestSocket(110);
    for (const platform of ["linux", "darwin"] as NodeJS.Platform[]) {
      withPlatform(platform, () => {
        expect(ensureSessionsDir(dir)).not.toBe(path.resolve(dir));
      });
    }
  });
});

describe("ensureSessionsDir fallback hardening (finding H4)", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("keeps the stable <tmpdir>/ms-<hash> path and creates it 0700", () => {
    expect(ensureSessionsDir(configured)).toBe(fallback);
    expect(statSync(fallback).mode & 0o777).toBe(0o700);
  });

  it("puts the fallback under the platform's temp dir, not a hardcoded /tmp", () => {
    // Issue #1717 — on macOS os.tmpdir() is a per-user directory, so the
    // fallback inherits that instead of the world-writable /tmp.
    expect(ensureSessionsDir(configured).startsWith(tmpdir())).toBe(true);
  });

  it("shortens the fallback's hash when the temp dir is too long for it", () => {
    // The fallback has to fit the limit TOO: a temp dir long enough to push
    // the CONFIGURED path over the limit can push the fallback over it as
    // well — and a fallback that cannot hold a socket is worse than none.
    // The hash is shortened until the path fits, which keeps it a pure
    // function of the configured path (the socket-dir ownership check and
    // deriveInstanceId both key off it, so it must be stable).
    // A temp-dir length at which the 8-character hash does NOT fit but a
    // shorter one does: the socket path is len(tmp) + 21 + hashLen bytes, so
    // the 8-char hash needs len(tmp) <= 78 and the 0-char one len(tmp) <= 86.
    const base = tmpdir();
    const longTmp = path.join(base, "t".repeat(Math.max(0, 82 - base.length)));
    mkdirSync(longTmp, { recursive: true });
    const prev = process.env.TMPDIR;
    process.env.TMPDIR = longTmp;
    try {
      const result = ensureSessionsDir(configured);
      expect(result.startsWith(longTmp)).toBe(true);
      // The 8-character hash did not fit, so the path was shortened.
      expect(result).not.toBe(path.join(longTmp, `ms-${hash}`));
      const longest = Buffer.byteLength(path.join(result, LONGEST_SOCKET), "utf8");
      expect(longest).toBeLessThanOrEqual(maxSunPathBytes() - 1);
    } finally {
      if (prev === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prev;
      rmSync(longTmp, { recursive: true, force: true });
    }
  });

  it("fails with a clear error when NO path under the temp dir can hold a socket", () => {
    // A temp dir so long that even the shortest fallback overflows the
    // limit. The error has to say what to do about it — a bare EINVAL at
    // bind() time is what this whole check exists to prevent.
    const hopelessTmp = path.join(tmpdir(), "t".repeat(120));
    mkdirSync(hopelessTmp, { recursive: true });
    const prev = process.env.TMPDIR;
    process.env.TMPDIR = hopelessTmp;
    try {
      expect(() => ensureSessionsDir(configured)).toThrow(/set SESSIONS_DIR to a shorter path/);
    } finally {
      if (prev === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prev;
      rmSync(hopelessTmp, { recursive: true, force: true });
    }
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
