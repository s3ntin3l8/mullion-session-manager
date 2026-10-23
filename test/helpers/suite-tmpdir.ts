import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { maxSunPathBytes } from "../../src/cli/sun-path.mjs";

// AF_UNIX sun_path is 108 bytes on Linux (104 on macOS). Plenty of tests bind
// a socket somewhere under os.tmpdir() (hooks.sock, ssh-agent bridges, dtach
// sockets, ...), and a Mullion-hosted session exports a long TMPDIR
// (`.../sessions/<id>.tmp/...`), so the suite's tmp root alone could eat most
// of that budget and make `listen()` fail with EINVAL (or a test hang until
// its timeout) for reasons that have nothing to do with the code under test.
//
// Keep the suite-level directory short enough that the deepest socket path
// the tests build beneath it still fits on the TIGHTEST platform we support —
// macOS's 104, four bytes under Linux's 108. A path that passes the check on
// Linux and then fails at `bind()` on macOS is a failure that is silent until
// a socket is actually created, and then is a bare EINVAL with nothing
// pointing at the path.
//
// The budget is DERIVED, not guessed: the platform limit comes from the one
// shared implementation (src/cli/sun-path.mjs — the same module the backend's
// own guard and the demo script read), and the depth below the root comes
// from the deepest socket path the suite actually builds under it. The
// off-by-one for the NUL terminator lives in that shared module too, so it
// cannot be got wrong here.
//
// macOS is the tightest platform, so the budget is the same everywhere: the
// suite has to pass on the platform with the smallest limit, not the one the
// test happens to run on.
const TIGHTEST_PLATFORM = "darwin";

/**
 * The bytes the deepest socket path adds BELOW the suite's temp root: the
 * path separator, plus the temp dir the test creates under the root, plus
 * the socket it binds inside that.
 *
 * The separator is part of it. The root and the path below it are joined
 * with one "/", so a root of N bytes and a relative path of 57 bytes make a
 * socket path of N + 1 + 57 — counting only the relative path is how the
 * budget came to be one byte too generous, which is the very window this
 * rule exists to close.
 *
 * The deepest socket the suite actually BINDS today is
 * "mullion-mcp-client-malformed-XXXXXX/hooks.sock"
 * (test/mcp/client.test.ts:215) — 29 + 6 + 1 + 10 = 46 below the root, 47
 * with the separator. (The opencode adapter's own suite puts a socket PATH
 * into a context object; it opens no socket, so it is not a bound path.)
 *
 * A test that binds a deeper socket path beneath the root has to raise
 * this constant, and the "deepest socket path fits" test in
 * suite-tmpdir.test.ts is what proves the two still agree.
 */
export const SUITE_DEEPEST_SOCKET_PATH_BYTES =
  1 + Buffer.byteLength(path.join("mullion-mcp-client-malformed-XXXXXX", "hooks.sock"), "utf8");

/**
 * The most bytes the suite's temp ROOT may take.
 *
 * The root plus the deepest path below it has to fit the platform's usable
 * sun_path length (the limit less one, for the NUL terminator).
 */
export const SUITE_TMP_MAX_BYTES =
  maxSunPathBytes(TIGHTEST_PLATFORM) - 1 - SUITE_DEEPEST_SOCKET_PATH_BYTES;

const MKDTEMP_SUFFIX_BYTES = 6;

/**
 * Create the suite-level temp directory. Uses `base` (normally os.tmpdir())
 * when the resulting path is short enough, otherwise a short directory under
 * `fallbackRoot` (/tmp). mkdtemp creates it 0700, so the world-writable
 * fallback root is not a hijack risk.
 */
export function createSuiteTmpDir(
  base: string = os.tmpdir(),
  prefix: string = "mullion-test-suite-",
  fallbackRoot: string = "/tmp",
): string {
  const projected = Buffer.byteLength(path.join(base, prefix), "utf8") + MKDTEMP_SUFFIX_BYTES;
  if (projected <= SUITE_TMP_MAX_BYTES) return fs.mkdtempSync(path.join(base, prefix));
  return fs.mkdtempSync(path.join(fallbackRoot, "mst-"));
}
