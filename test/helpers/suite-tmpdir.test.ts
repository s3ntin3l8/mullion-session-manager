import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSuiteTmpDir, SUITE_TMP_MAX_BYTES } from "./suite-tmpdir.js";

const SUN_PATH_MAX = 104; // macOS; Linux allows 108
const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("createSuiteTmpDir", () => {
  it("falls back to a short directory when the base is too long for a socket path", () => {
    const longBase = path.join(os.tmpdir(), "x".repeat(80));
    fs.mkdirSync(longBase, { recursive: true });
    made.push(longBase);
    const dir = createSuiteTmpDir(longBase);
    made.push(dir);
    expect(dir.startsWith(longBase)).toBe(false);
    expect(Buffer.byteLength(dir)).toBeLessThanOrEqual(SUITE_TMP_MAX_BYTES);
    expect(fs.statSync(dir).isDirectory()).toBe(true);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("stays under the given base when it is short enough", () => {
    const shortBase = fs.mkdtempSync(path.join(os.tmpdir(), "b-"));
    made.push(shortBase);
    // Only meaningful when the host tmpdir itself is short; otherwise the
    // projected path exceeds the budget and the fallback is the right answer.
    if (Buffer.byteLength(path.join(shortBase, "mullion-test-suite-")) + 6 > SUITE_TMP_MAX_BYTES) {
      return;
    }
    const dir = createSuiteTmpDir(shortBase);
    made.push(dir);
    expect(path.dirname(dir)).toBe(shortBase);
  });

  it("the suite's own os.tmpdir() leaves room for the deepest socket path tests build", () => {
    // global-setup points TMPDIR at the suite dir; a socket under it must fit
    // regardless of how long the invoking shell's TMPDIR was.
    const deepest = path.join(os.tmpdir(), "mullion-opencode-gate-XXXXXX", "hooks.sock");
    expect(Buffer.byteLength(deepest)).toBeLessThanOrEqual(SUN_PATH_MAX - 1);
  });
});
