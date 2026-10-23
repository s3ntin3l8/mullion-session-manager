// The `sockaddr_un.sun_path` limit, in bytes, and the socket paths a
// sessions directory has to hold.
//
// Plain ESM on purpose: `src/cli` is copied into `dist/` verbatim (see
// package.json's "build"), and this rule is needed by three consumers that
// cannot all be TypeScript — the compiled backend (src/plugins/pty.ts), a
// plain-ESM script (scripts/demo/env.mjs) and the test suite's temp-dir
// helper (test/helpers/suite-tmpdir.ts). The types live in sun-path.d.mts,
// the same arrangement src/cli/review-protocol.mjs uses.
//
// ONE implementation, deliberately. The rule was copied into three places
// before this module existed, and each copy was a place the platform table
// could drift: a platform added on one side and not the other failed at
// `bind()` with a bare EINVAL and nothing pointing at the path. The demo's
// copy was guarded by a test that compared the two tables, which catches
// drift but only after the fact; a shared module makes the divergence
// impossible to express.
import path from "node:path";

/**
 * The `sockaddr_un.sun_path` limit, in bytes, for the platforms whose limit
 * differs from the default.
 *
 * Linux allows 108; macOS allows 104. The four-byte difference is exactly
 * the size of the window in which a path passes the check on Linux and then
 * fails at `bind()` on macOS — a failure that is silent until a socket is
 * actually created, and then is a bare EINVAL with nothing pointing at the
 * path.
 *
 * A Map, not a plain object: an object literal inherits `Object.prototype`'s
 * keys, so an arbitrary platform string like "constructor" would return a
 * function rather than the default.
 */
export const SUN_PATH_BYTES_BY_PLATFORM = new Map([["darwin", 104]]);

/** The `sun_path` limit for every platform not listed in the table above. */
export const DEFAULT_SUN_PATH_BYTES = 108;

/**
 * The `sockaddr_un.sun_path` limit, in bytes, for a given platform.
 *
 * Platform-parameterised so the limit can be exercised for a platform other
 * than the one the test happens to run on.
 */
export function maxSunPathBytes(platform = process.platform) {
  return SUN_PATH_BYTES_BY_PLATFORM.get(platform) ?? DEFAULT_SUN_PATH_BYTES;
}

/**
 * The socket names a sessions dir has to hold: the hooks socket, the control
 * socket, and a session-id socket (the longest of the three).
 *
 * The session-id case is a 12-digit id plus ".sock" — the id is always that
 * long, so the name is a constant rather than something to measure at
 * runtime.
 */
export const SESSIONS_DIR_SOCKET_NAMES = ["hooks.sock", "mullion.sock", "999999999999.sock"];

/**
 * The length of the longest socket path a sessions dir will have to hold.
 *
 * `hooks.sock`, the control socket `mullion.sock`, and a 12-digit
 * session-id socket all live in it, and the session-id case is the longest
 * of the three.
 */
export function longestSocketPath(dir) {
  return Math.max(
    ...SESSIONS_DIR_SOCKET_NAMES.map((name) => Buffer.byteLength(path.join(dir, name), "utf8")),
  );
}

/**
 * Whether a directory can hold a socket on this platform.
 *
 * The limit counts the NUL terminator, so the usable path is one byte
 * shorter than it — that off-by-one lives here, once, rather than at each
 * call site that compares against the limit.
 */
export function fitsSunPath(dir, platform = process.platform) {
  return longestSocketPath(dir) <= maxSunPathBytes(platform) - 1;
}
