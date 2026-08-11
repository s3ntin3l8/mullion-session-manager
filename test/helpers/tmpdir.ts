import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// The suite's ~106 `fs.mkdtempSync(path.join(os.tmpdir(), "some-prefix-"))`
// call sites are inconsistent about cleanup: some `fs.rmSync(dir, {
// recursive: true, force: true })` the directory at the end of the test
// (e.g. test/routes/projects.test.ts, throughout), others just leave it for
// the OS's own tmp reaper. Neither is a bug — both are common in this
// suite — so this helper deliberately does NOT auto-register cleanup; it
// only wraps the `mkdtempSync` call itself, and callers keep doing
// whichever of the two things the surrounding test already does.
export function uniqueDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
