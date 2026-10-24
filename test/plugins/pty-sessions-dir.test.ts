import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";
import type * as ChildProcess from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

// ensureSessionsDir only touches the filesystem, but mock child_process so
// nothing in this file's import graph can ever fire a real systemd-run
// (issue #1137).
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return { ...actual, spawn: vi.fn() };
});

import Fastify from "fastify";
import {
  ensureSessionsDir,
  maxSunPathBytes,
  ptyPlugin,
  resolveSessionsDirs,
} from "../../src/plugins/pty.js";
import { envPlugin } from "../../src/plugins/env.js";
import { dbPlugin } from "../../src/plugins/db.js";
import { buildApp } from "../../src/app.js";

// A configured dir long enough to push the worst-case socket path past the
// sun_path limit, forcing the short fallback.
const configured = path.join(tmpdir(), "x".repeat(110), "sessions");
// The temp dir as it was when this file loaded — the tests below change
// TMPDIR to exercise the budget's boundary, and the scratch home must not
// follow it (a long TMPDIR would push the home root itself over the limit).
const TEST_TMPDIR = tmpdir();
const hash = createHash("md5").update(path.resolve(configured)).digest("hex").slice(0, 8);
// Issue #1762 — the fallback lives under the PER-USER home directory
// (~/.mullion/sessions), not under the platform's temp dir: the temp dir is
// a function of TMPDIR, so a fallback rooted there moves — and re-derives
// this instance's scope namespace — whenever TMPDIR changes.
const FALLBACK_SUBDIR = path.join(".mullion", "sessions");

/** The fallback dir for the configured path, under a given home directory. */
function fallbackUnder(home: string): string {
  return path.join(home, FALLBACK_SUBDIR, `ms-${hash}`);
}

/**
 * A fresh, empty install root (MULLION_HOME) for the history tests.
 *
 * The name is short on purpose, like the scratch home's above: it is only
 * ever a parent of the trail file here, but a long name would make the
 * assertions about absolute paths noisier than they need to be.
 */
function makeInstallRoot(): string {
  const home = mkdtempSync(path.join(TEST_TMPDIR, "mi-"));
  installRoots.push(home);
  return home;
}

/** The install roots made by makeInstallRoot, removed after each test. */
const installRoots: string[] = [];

afterEach(() => {
  while (installRoots.length > 0) {
    rmSync(installRoots.pop() as string, { recursive: true, force: true });
  }
});

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

/**
 * Runs `fn` with HOME pointed at a scratch directory.
 *
 * `os.homedir()` reads $HOME on POSIX, so this is how the tests steer the
 * fallback's per-user root without touching the real home directory (which
 * holds this repo's own ~/.mullion state). The scratch home is removed
 * afterwards, so a test that creates the fallback dir inside it leaves
 * nothing behind.
 */
function withHome<T>(fn: (home: string) => T): T {
  // The scratch home's name is short ON PURPOSE: the fallback root is
  // `<home>/.mullion/sessions/ms-<hash>`, and the whole path has to fit the
  // platform's sun_path budget for the fallback to land under the home dir
  // at all — a long scratch name would push the home root itself over the
  // limit, and the fallback would land in the POSIX last resort instead.
  const home = path.join(TEST_TMPDIR, `mh-${randomBytes(4).toString("hex")}`);
  mkdirSync(home, { recursive: true });
  // A precondition, so an environment with an unusually long TMPDIR reports
  // as such instead of masquerading as a fallback-resolution failure.
  const root = path.join(home, FALLBACK_SUBDIR, `ms-${hash}`);
  expect(Buffer.byteLength(path.join(root, LONGEST_SOCKET), "utf8")).toBeLessThanOrEqual(
    maxSunPathBytes() - 1,
  );
  const prev = process.env.HOME;
  process.env.HOME = home;
  const restore = (): void => {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
  };
  const result = fn(home);
  // An async callback must keep the scratch home until it is DONE with it —
  // removing it under a running callback would delete the fallback dir the
  // callback is asserting about.
  if (result instanceof Promise) return result.finally(restore) as T;
  restore();
  return result;
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
      // A TMPDIR of its own, so the #1748 compat root and the pre-#1748 one
      // are two DIFFERENT paths and the assertions below cannot pass by
      // accident.
      const tmp = path.join(tmpdir(), `compat-${randomBytes(4).toString("hex")}`);
      mkdirSync(tmp, { recursive: true });
      const prev = process.env.TMPDIR;
      process.env.TMPDIR = tmp;
      try {
        withHome((home) => {
          const dirs = resolveSessionsDirs(configured);
          expect(dirs.current).toBe(fallbackUnder(home));
          expect(dirs.owned).toContain(fallbackUnder(home));
          expect(dirs.owned).toContain(path.join(tmp, `ms-${hash}`));
          expect(dirs.owned).toContain(path.join("/tmp", `ms-${hash}`));
        });
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

// Issue #1771 — the HISTORY: the trail of dirs this install has resolved,
// kept in the install root (MULLION_HOME). The compat roots above can only
// name what an earlier RELEASE would have used for the same configured
// path, so they cannot name the dir an operator moved SESSIONS_DIR away
// from, nor the fallback a changed TMPDIR produced.
describe("resolveSessionsDirs — the sessions-dir HISTORY (issue #1771)", () => {
  it("records the resolved dir in the install root's trail", () => {
    const home = makeInstallRoot();
    const short = path.join(tmpdir(), "ms-history-sessions-test");
    const dirs = resolveSessionsDirs(short, { mullionHome: home });
    const written = JSON.parse(readFileSync(path.join(home, "sessions-dirs.json"), "utf8")) as {
      dirs: string[];
    };
    expect(written.dirs).toContain(path.resolve(short));
    expect(dirs.current).toBe(path.resolve(short));
  });

  it("owns a dir an EARLIER run resolved, even though this run resolves elsewhere", () => {
    // The case the issue is about: the sessions dir moved (an operator moved
    // SESSIONS_DIR, or TMPDIR's value changed between runs). The scope's
    // socket sits in the OLD dir, which no derivation can name — only the
    // trail can.
    const home = makeInstallRoot();
    const moved = path.join(tmpdir(), "ms-moved-sessions-dir");
    writeFileSync(path.join(home, "sessions-dirs.json"), JSON.stringify({ dirs: [moved] }));
    const short = path.join(tmpdir(), "ms-history-sessions-test-2");
    const dirs = resolveSessionsDirs(short, { mullionHome: home });
    expect(dirs.owned).toContain(moved);
  });

  it("owns only the current dir, the compat roots and the trail — nothing else", () => {
    // Issue #1137 — the owned set may only name dirs this instance itself
    // created. The trail is the only thing that may widen it, and the trail
    // holds nothing but resolved dirs. So every dir in the set is either the
    // one this run resolved, one an earlier run recorded, or a compat root:
    // a fallback-shaped name (`ms-<8 hex>`) derived from THIS configured
    // path's own hash.
    const home = makeInstallRoot();
    const recorded = path.join(tmpdir(), "ms-recorded-dir");
    writeFileSync(path.join(home, "sessions-dirs.json"), JSON.stringify({ dirs: [recorded] }));
    const short = path.join(tmpdir(), "ms-history-sessions-test-3");
    const dirs = resolveSessionsDirs(short, { mullionHome: home });
    expect(dirs.owned).toContain(path.resolve(short));
    expect(dirs.owned).toContain(recorded);
    for (const dir of dirs.owned) {
      const isCurrent = dir === path.resolve(short);
      const isRecorded = dir === recorded;
      const isCompatRoot = /^ms-[0-9a-f]{8}$/.test(path.basename(dir));
      expect(isCurrent || isRecorded || isCompatRoot).toBe(true);
    }
  });

  it("changes nothing when there is no install root (a dev checkout)", () => {
    // MULLION_HOME is empty in a dev checkout: there is no trail, so the
    // result is exactly today's.
    const short = path.join(tmpdir(), "ms-history-sessions-test-4");
    const withoutHome = resolveSessionsDirs(short);
    const withEmptyHome = resolveSessionsDirs(short, { mullionHome: makeInstallRoot() });
    expect(withoutHome.current).toBe(withEmptyHome.current);
    expect(withoutHome.owned).toEqual(withEmptyHome.owned);
    expect(withoutHome.historyWarning).toBeUndefined();
  });

  it("ignores a corrupt trail file and still resolves", () => {
    // Never fatal: the boot continues with the dirs the resolver can
    // derive, and the operator is told why the trail is incomplete.
    const home = makeInstallRoot();
    writeFileSync(path.join(home, "sessions-dirs.json"), "{not json");
    const short = path.join(tmpdir(), "ms-history-sessions-test-5");
    const dirs = resolveSessionsDirs(short, { mullionHome: home });
    expect(dirs.current).toBe(path.resolve(short));
    expect(dirs.owned).toContain(path.resolve(short));
    expect(dirs.historyWarning).toMatch(/not readable JSON/);
  });
});

describe("ensureSessionsDir fallback hardening (finding H4)", () => {
  it("creates the per-user fallback dir 0700", () => {
    withHome((home) => {
      const fallback = fallbackUnder(home);
      expect(ensureSessionsDir(configured)).toBe(fallback);
      expect(statSync(fallback).mode & 0o777).toBe(0o700);
    });
  });

  it("puts the fallback under the per-user home dir, not under the temp dir", () => {
    // Issue #1762 — the temp dir is a function of TMPDIR, so a fallback
    // rooted there moves (and re-derives this instance's scope namespace)
    // whenever TMPDIR changes; the per-user home dir does not move. This is
    // also what makes the fallback fit on a host whose TMPDIR is too long
    // to hold it (#1762).
    withHome((home) => {
      const result = ensureSessionsDir(configured);
      expect(result).toBe(fallbackUnder(home));
      expect(result).not.toBe(path.join(tmpdir(), `ms-${hash}`));
    });
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
        withHome((home) => {
          const result = ensureSessionsDir(configured);
          // The name is the FULL hash of the resolved configured path — exactly
          // 8 hex chars, no truncation, on BOTH platforms.
          expect(result).toBe(fallbackUnder(home));
          const longest = Buffer.byteLength(path.join(result, LONGEST_SOCKET), "utf8");
          expect(longest).toBeLessThanOrEqual(maxSunPathBytes(platform) - 1);
        });
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
        withHome((home) => {
          const other = path.join(home, "u".repeat(110), "sessions");
          const otherHash = createHash("md5").update(path.resolve(other)).digest("hex").slice(0, 8);
          // A precondition, so a fixture collision reports as such instead of
          // masquerading as a distinctness failure.
          expect(otherHash).not.toBe(hash);
          const a = ensureSessionsDir(configured);
          const b = ensureSessionsDir(other);
          expect(a).not.toBe(b);
          expect(a).toBe(fallbackUnder(home));
          expect(b).toBe(path.join(home, FALLBACK_SUBDIR, `ms-${otherHash}`));
        });
      });
    }
  });

  it("does not fail when the temp dir is too long to hold the fallback (#1762)", () => {
    // The regression #1762 was filed for: with the fallback under the temp
    // dir, a TMPDIR long enough to overflow the sun_path budget pushed the
    // FALLBACK over it as well — and the app then refused to start, on a
    // host that had been running fine before the limit was made
    // platform-aware. The per-user root does not depend on TMPDIR at all, so
    // this is now a non-event: the same TMPDIR that used to be fatal
    // resolves to the same fallback as any other.
    for (const platform of ["linux", "darwin"] as NodeJS.Platform[]) {
      withPlatform(platform, () => {
        // One byte past the longest temp dir whose fallback used to fit.
        const tmp = tmpDirOfLength(maxFittingTmpBytes(platform) + 1, "over");
        mkdirSync(tmp, { recursive: true });
        const prev = process.env.TMPDIR;
        process.env.TMPDIR = tmp;
        try {
          withHome((home) => {
            expect(ensureSessionsDir(configured)).toBe(fallbackUnder(home));
          });
        } finally {
          if (prev === undefined) delete process.env.TMPDIR;
          else process.env.TMPDIR = prev;
          rmSync(tmp, { recursive: true, force: true });
        }
      });
    }
  });

  it("falls back to the POSIX last resort when the home dir cannot be determined", () => {
    // The per-user root is the rule; /tmp is the safety net for the
    // pathological case where the home directory cannot be determined at all.
    // The fallback STILL has to fit, or the app would not start — which is
    // the whole point of the net.
    const spy = vi.spyOn(os, "homedir").mockReturnValue("");
    const lastResort = path.join("/tmp", `ms-${hash}`);
    try {
      expect(ensureSessionsDir(configured)).toBe(lastResort);
      const longest = Buffer.byteLength(path.join(lastResort, LONGEST_SOCKET), "utf8");
      expect(longest).toBeLessThanOrEqual(maxSunPathBytes() - 1);
    } finally {
      spy.mockRestore();
      rmSync(lastResort, { recursive: true, force: true });
    }
  });

  it("fails with a clear error when no root can hold the fallback", () => {
    // The fallback has to fit the limit TOO, and a fallback that cannot hold
    // a socket is worse than none. The error has to say what to do about it
    // — a bare EINVAL at bind() time is what this whole check exists to
    // prevent — and to name the levers that are actually available.
    //
    // Reachable only where neither root exists: on Windows there is no
    // POSIX /tmp, so an undeterminable home directory leaves no root at all.
    const spy = vi.spyOn(os, "homedir").mockReturnValue("");
    try {
      withPlatform("win32", () => {
        expect(() => ensureSessionsDir(configured)).toThrow(/set SESSIONS_DIR to a shorter path/);
        expect(() => ensureSessionsDir(configured)).toThrow(/point HOME at a shorter/);
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("tightens an existing looser directory we own to 0700 instead of refusing", () => {
    withHome((home) => {
      const fallback = fallbackUnder(home);
      mkdirSync(path.dirname(fallback), { recursive: true });
      mkdirSync(fallback, { mode: 0o755 });
      chmodSync(fallback, 0o755);
      expect(ensureSessionsDir(configured)).toBe(fallback);
      expect(statSync(fallback).mode & 0o777).toBe(0o700);
    });
  });

  it("never follows a symlinked fallback dir — it moves on to the next root", () => {
    // The refusal stays a refusal (the symlink is not followed, and the dir
    // it points at is never used), but it is no longer FATAL: the resolver
    // tries the next root, because refusing to start over a symlinked
    // fallback is exactly the failure mode #1762 is about.
    const lastResort = path.join("/tmp", `ms-${hash}`);
    withHome((home) => {
      const fallback = fallbackUnder(home);
      const target = path.join(TEST_TMPDIR, `ms-symlink-target-${process.pid}`);
      mkdirSync(target, { recursive: true });
      mkdirSync(path.dirname(fallback), { recursive: true });
      try {
        symlinkSync(target, fallback);
        expect(ensureSessionsDir(configured)).not.toBe(fallback);
        expect(ensureSessionsDir(configured)).toBe(lastResort);
      } finally {
        rmSync(target, { recursive: true, force: true });
        rmSync(lastResort, { recursive: true, force: true });
      }
    });
  });

  it("never uses a fallback dir owned by another uid, and says so when no root is left", () => {
    // The uid refusal applies to EVERY root, so with the uid mocked there is
    // no usable root at all: the resolver refuses to start — and says why,
    // rather than failing with a bare EACCES from the mkdir.
    withHome((home) => {
      mkdirSync(path.dirname(fallbackUnder(home)), { recursive: true });
      mkdirSync(fallbackUnder(home), { mode: 0o700 });
      const real = process.getuid!;
      const spy = vi.spyOn(process, "getuid").mockImplementation(() => real.call(process) + 1);
      try {
        expect(() => ensureSessionsDir(configured)).toThrow(/owned by uid/);
      } finally {
        spy.mockRestore();
      }
    });
  });

  it("falls through to the last resort when the home root cannot be created (#1762)", () => {
    // The regression the review found: a home directory the app cannot write
    // (a container running as a UID that does not own $HOME, an unmounted NFS
    // home, a read-only home) booted fine under the temp-dir root and would
    // NOT after the per-user root — the mkdir failure escaped the root
    // selection instead of moving on to the last resort.
    const lastResort = path.join("/tmp", `ms-${hash}`);
    // A directory the current user can read and traverse but NOT write.
    const unwritable = path.join(TEST_TMPDIR, `unwritable-${process.pid}`);
    mkdirSync(unwritable, { recursive: true });
    chmodSync(unwritable, 0o500);
    const prev = process.env.HOME;
    process.env.HOME = unwritable;
    try {
      expect(ensureSessionsDir(configured)).toBe(lastResort);
      // And the skip is never silent: the caller logs the root it passed
      // over and why, so the operator learns the sessions moved.
      const dirs = resolveSessionsDirs(configured);
      expect(dirs.skipped.map((skip) => skip.root)).toContain(
        path.join(unwritable, ".mullion", "sessions", `ms-${hash}`),
      );
      expect(dirs.skipped[0]?.reason).toMatch(/EACCES|permission denied/i);
    } finally {
      if (prev === undefined) delete process.env.HOME;
      else process.env.HOME = prev;
      chmodSync(unwritable, 0o700);
      rmSync(unwritable, { recursive: true, force: true });
      rmSync(lastResort, { recursive: true, force: true });
    }
  });

  it("returns a short configured path untouched and creates nothing", () => {
    withHome((home) => {
      const short = "/tmp/ms-short-sessions-test";
      expect(ensureSessionsDir(short)).toBe(path.resolve(short));
      expect(existsSync(fallbackUnder(home))).toBe(false);
    });
  });

  it("warns at boot when a fallback root was skipped", async () => {
    // The reporting half: the plugin logs the root it passed over AND why,
    // so a planted symlink (or an unwritable home) is visible to the
    // operator instead of quietly relocating the sessions to /tmp.
    const unwritable = path.join(TEST_TMPDIR, `unwritable-${process.pid}`);
    mkdirSync(unwritable, { recursive: true });
    chmodSync(unwritable, 0o500);
    const prevHome = process.env.HOME;
    const prevSessions = process.env.SESSIONS_DIR;
    process.env.HOME = unwritable;
    process.env.SESSIONS_DIR = configured;
    try {
      // A bare Fastify rather than buildApp(): the warning is emitted while
      // the pty plugin REGISTERS, so the spy has to be in place before that —
      // and registering the three plugins by hand keeps the test light (no
      // server, no control socket) while still booting the real plugin.
      const app = Fastify({ logger: { level: "warn" } });
      const warn = vi.spyOn(app.log, "warn");
      await app.register(envPlugin);
      await app.register(dbPlugin);
      await app.register(ptyPlugin);
      await app.ready();
      const reported = warn.mock.calls.filter((call) =>
        /fallback root unusable/.test(String(call[1])),
      );
      expect(reported.length).toBeGreaterThan(0);
      // WHICH root was skipped (not the last resort, which was used) and WHY
      // — root alone does not tell an operator why the sessions moved.
      expect(reported[0]?.[0]).toMatchObject({
        root: path.join(unwritable, ".mullion", "sessions", `ms-${hash}`),
        reason: expect.stringMatching(/EACCES|permission denied/i),
      });
      await app.close();
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevSessions === undefined) delete process.env.SESSIONS_DIR;
      else process.env.SESSIONS_DIR = prevSessions;
      chmodSync(unwritable, 0o700);
      rmSync(unwritable, { recursive: true, force: true });
      rmSync(path.join("/tmp", `ms-${hash}`), { recursive: true, force: true });
    }
  });

  it("does not delete the fallback dir (live sockets/tokens) on app shutdown", async () => {
    await withHome(async (home) => {
      const fallback = fallbackUnder(home);
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
});
