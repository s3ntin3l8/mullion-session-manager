import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// AF_UNIX sun_path is 108 bytes on Linux (104 on macOS). Plenty of tests bind
// a socket somewhere under os.tmpdir() (hooks.sock, ssh-agent bridges, dtach
// sockets, ...), and a Mullion-hosted session exports a long TMPDIR
// (`.../sessions/<id>.tmp/...`), so the suite's tmp root alone could eat most
// of that budget and make `listen()` fail with EINVAL (or a test hang until
// its timeout) for reasons that have nothing to do with the code under test.
//
// Keep the suite-level directory short enough that the deepest socket path
// the tests build beneath it (~50 bytes, e.g.
// `mullion-opencode-gate-XXXXXX/hooks.sock`) still fits on macOS's 104.
export const SUITE_TMP_MAX_BYTES = 48;

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
