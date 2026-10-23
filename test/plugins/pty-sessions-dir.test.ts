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

import { ensureSessionsDir, maxSunPathBytes, resolveSessionsDirs } from "../../src/plugins/pty.js";
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

/**
 * The bytes the fallback path adds on top of the temp dir it lives in: the
 * separator, `ms-`, the 8-hex-char hash, the separator, and the longest
 * socket name the sessions dir has to hold.
 *
 * The fallback's socket path is therefore `len(tmp) + FALLBACK_OVERHEAD`
 * bytes, and it fits the platform's budget iff that is within
 * `maxSunPathBytes(platform) - 1` (the limit counts the NUL terminator, so
 * the usable path is one byte shorter than it).
 */
const FALLBACK_OVERHEAD = 1 + 3 + 8 + 1 + LONGEST_SOCKET.length;

/** The longest temp dir (in bytes) whose fallback still fits the platform. */
function maxFittingTmpBytes(platform: NodeJS.Platform): number {
  return maxSunPathBytes(platform) - 1 - FALLBACK_OVERHEAD;
}

/**
 * A temp dir path of EXACTLY `bytes` bytes, for exercising the sun_path
 * budget at its boundary.
 *
 * The temp dir's own length is what decides whether the fallback fits, so the
 * fixture has to hit an exact size rather than merely a long one. The name is
 * padded to the requested length and the result is asserted, so the helper
 * cannot drift out of step with the arithmetic it stands in for.
 */
function tmpDirOfLength(bytes: number, tag: string): string {
  const base = tmpdir();
  // "<base>/<tag>/<padding>" — one separator either side of the tag.
  const overhead = base.length + 1 + tag.length + 1;
  const padding = "t".repeat(Math.max(0, bytes - overhead));
  const dir = path.join(base, tag, padding);
  expect(Buffer.byteLength(dir, "utf8")).toBe(bytes);
  return dir;
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

describe("resolveSessionsDirs — the sessions dir and the OWNERSHIP set (issue #1770)", () => {
  it("keeps a configured dir that fits, and owns it", () => {
    const short = path.join(tmpdir(), "ms-short-sessions-test");
    const dirs = resolveSessionsDirs(short);
    expect(dirs.current).toBe(path.resolve(short));
    expect(dirs.owned).toContain(path.resolve(short));
  });

  it("puts the fallback AND every compat root in the ownership set", () => {
    // The compat roots are the dirs a scope created before the fallback root
    // moved still lives in: the same `ms-<hash>` name under every root this
    // repo has shipped. They stay OWNED so such a scope keeps being this
    // instance's own (alive, and stoppable) instead of an orphan the
    // reconciler reads as "dead".
    withPlatform("linux", () => {
      const tmp = tmpDirOfLength(maxFittingTmpBytes("linux"), "owned");
      mkdirSync(tmp, { recursive: true });
      const prev = process.env.TMPDIR;
      process.env.TMPDIR = tmp;
      try {
        const dirs = resolveSessionsDirs(configured);
        expect(dirs.current).toBe(path.join(tmp, `ms-${hash}`));
        expect(dirs.owned).toContain(path.join(tmp, `ms-${hash}`));
        expect(dirs.owned).toContain(path.join("/tmp", `ms-${hash}`));
      } finally {
        if (prev === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = prev;
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  it("derives the compat roots from the CONFIGURED path's hash, never from the dir's basename", () => {
    // A configured dir that happens to be NAMED like a fallback dir must not
    // make this instance claim ownership of that name under another root —
    // that dir may belong to a different project. The compat roots are keyed
    // by the configured path's own hash, so they never collide by name.
    const lookalike = path.join(tmpdir(), "ms-1234abcd");
    const ownHash = createHash("md5").update(path.resolve(lookalike)).digest("hex").slice(0, 8);
    const dirs = resolveSessionsDirs(lookalike);
    expect(dirs.owned).not.toContain(path.join("/tmp", "ms-1234abcd"));
    expect(dirs.owned).toContain(path.join("/tmp", `ms-${ownHash}`));
  });

  it("resolves every owned dir to an absolute path", () => {
    const dirs = resolveSessionsDirs(configured);
    for (const dir of dirs.owned) expect(path.isAbsolute(dir)).toBe(true);
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

  it("uses the FULL 8-hex-char hash for the fallback name, never a shortened one", () => {
    // The fallback's name is what makes it distinct per configured path, and
    // that distinctness is load-bearing: deriveInstanceId (session-process.ts)
    // hashes the resolved sessions dir to namespace this instance's systemd
    // scopes, so two projects sharing one fallback dir would share one scope
    // namespace and could stop each other's scopes. Shortening the hash to
    // squeeze the path into a shrinking budget trades that away — at 2 hex
    // chars there are only 256 buckets, and at 0 the name is the SAME for
    // every configured path (a certain collision, not a probable one).
    //
    // So the name is fixed at the same 32 bits deriveInstanceId itself uses,
    // and the path shape does not depend on how long the temp dir is.
    for (const platform of ["linux", "darwin"] as NodeJS.Platform[]) {
      withPlatform(platform, () => {
        // The longest temp dir whose fallback still fits: at exactly the
        // boundary, the name still has to come out whole.
        const tmp = tmpDirOfLength(maxFittingTmpBytes(platform), "fit");
        mkdirSync(tmp, { recursive: true });
        const prev = process.env.TMPDIR;
        process.env.TMPDIR = tmp;
        try {
          const result = ensureSessionsDir(configured);
          // The name is the FULL hash of the resolved configured path — exactly
          // 8 hex chars, no truncation, on BOTH platforms.
          expect(result).toBe(path.join(tmp, `ms-${hash}`));
          const longest = Buffer.byteLength(path.join(result, LONGEST_SOCKET), "utf8");
          expect(longest).toBe(maxSunPathBytes(platform) - 1);
        } finally {
          if (prev === undefined) delete process.env.TMPDIR;
          else process.env.TMPDIR = prev;
          rmSync(tmp, { recursive: true, force: true });
        }
      });
    }
  });

  it("resolves two DISTINCT configured paths to two DISTINCT fallbacks", () => {
    // The property the `len = 0` rung destroyed: at a temp-dir length where
    // the hash was shortened to nothing, EVERY configured path resolved to the
    // same `<tmp>/ms-` directory — one sessions dir, one deriveInstanceId, one
    // systemd scope namespace shared by unrelated projects. This asserts the
    // exact expected path per input, so a future re-introduction of
    // truncation fails loudly rather than merely "differing".
    for (const platform of ["linux", "darwin"] as NodeJS.Platform[]) {
      withPlatform(platform, () => {
        const tmp = tmpDirOfLength(maxFittingTmpBytes(platform), "dist");
        mkdirSync(tmp, { recursive: true });
        const prev = process.env.TMPDIR;
        process.env.TMPDIR = tmp;
        try {
          const other = path.join(tmp, "u".repeat(110), "sessions");
          const otherHash = createHash("md5").update(path.resolve(other)).digest("hex").slice(0, 8);
          // A precondition, so a fixture collision reports as such instead of
          // masquerading as a distinctness failure.
          expect(otherHash).not.toBe(hash);
          const a = ensureSessionsDir(configured);
          const b = ensureSessionsDir(other);
          expect(a).not.toBe(b);
          expect(a).toBe(path.join(tmp, `ms-${hash}`));
          expect(b).toBe(path.join(tmp, `ms-${otherHash}`));
        } finally {
          if (prev === undefined) delete process.env.TMPDIR;
          else process.env.TMPDIR = prev;
          rmSync(tmp, { recursive: true, force: true });
        }
      });
    }
  });

  it("fails with a clear error when the fallback itself does not fit", () => {
    // The fallback has to fit the limit TOO: it lives under the platform's
    // temp dir, and a temp dir long enough to push the CONFIGURED path over
    // the limit can push the fallback over it as well — and a fallback that
    // cannot hold a socket is worse than none. The error has to say what to
    // do about it — a bare EINVAL at bind() time is what this whole check
    // exists to prevent — and to name BOTH levers: the temp dir is what
    // overflowed here, not just SESSIONS_DIR.
    for (const platform of ["linux", "darwin"] as NodeJS.Platform[]) {
      withPlatform(platform, () => {
        // One byte past the longest temp dir that still fits.
        const tmp = tmpDirOfLength(maxFittingTmpBytes(platform) + 1, "over");
        mkdirSync(tmp, { recursive: true });
        const prev = process.env.TMPDIR;
        process.env.TMPDIR = tmp;
        try {
          expect(() => ensureSessionsDir(configured)).toThrow(/set SESSIONS_DIR to a shorter path/);
          expect(() => ensureSessionsDir(configured)).toThrow(/point TMPDIR at a shorter/);
        } finally {
          if (prev === undefined) delete process.env.TMPDIR;
          else process.env.TMPDIR = prev;
          rmSync(tmp, { recursive: true, force: true });
        }
      });
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
