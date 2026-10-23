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
 * path separator, plus the path below the root.
 *
 * The separator is part of it. The root and the path below it are joined
 * with one "/", so a root of N bytes and a relative path of R bytes make a
 * socket path of N + 1 + R — counting only the relative path is how the
 * budget came to be a byte too generous, which is the very window this
 * rule exists to close.
 *
 * There are TWO shapes, and the deeper one is the socket bound **directly**
 * under the root — not one inside a temp dir the test creates:
 *
 *   1. `<root>/<name>.sock` — the longest is ssh-agent-socket.test.ts's
 *      `ssh-agent-socket-test-<pid>-deadline-cleared.sock`.
 *   2. `<root>/<prefix>-XXXXXX/<name>.sock` — the longest bound one is
 *      mcp/client.test.ts's `mullion-mcp-client-malformed-XXXXXX/hooks.sock`.
 *      (opencode.test.ts's `agents.<name>` path is LONGER but is never
 *      bound — it only puts a socket path into a context object.)
 *
 * The pid is counted at seven digits — Linux's default `pid_max` is
 * 4194304, so a pid is up to seven characters — and the mkdtemp suffix at
 * six. Both shapes are computed here rather than hand-counted, so the
 * constant cannot drift from either one.
 *
 * A test that binds a deeper socket path beneath the root has to raise
 * this constant, and the "deepest socket path fits" test in
 * suite-tmpdir.test.ts is what proves the two still agree.
 */
const SEVEN_DIGIT_PID = "1234567";

const DIRECT_SOCKET_NAME = `ssh-agent-socket-test-${SEVEN_DIGIT_PID}-deadline-cleared.sock`;

const NESTED_SOCKET_PATH = path.join("mullion-mcp-client-malformed-XXXXXX", "hooks.sock");

export const SUITE_DEEPEST_SOCKET_PATH_BYTES = Math.max(
  // The separator between the root and the path below it.
  1 + Buffer.byteLength(DIRECT_SOCKET_NAME, "utf8"),
  1 + Buffer.byteLength(NESTED_SOCKET_PATH, "utf8"),
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
