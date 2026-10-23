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
 * The deepest socket path the suite builds BENEATH its temp root: a temp dir
 * the test creates under os.tmpdir() (which global-setup points at the suite
 * root), plus the socket it binds inside it.
 *
 * The deepest one the suite builds today is
 * "mullion-opencode-workflow-conventions-XXXXXX/mullion.sock"
 * (test/services/hook-adapters/opencode.test.ts) — 38 + 6 + 1 + 12 = 57
 * bytes. A test that builds a deeper socket path beneath the root has to
 * raise this constant, and the "deepest socket path fits" test in
 * suite-tmpdir.test.ts is what proves the two still agree.
 */
export const SUITE_DEEPEST_SOCKET_PATH_BYTES = Buffer.byteLength(
  path.join("mullion-opencode-workflow-conventions-XXXXXX", "mullion.sock"),
  "utf8",
);

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
