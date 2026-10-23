import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { maxSunPathBytes } from "../../src/cli/sun-path.mjs";
import {
  createSuiteTmpDir,
  SUITE_DEEPEST_SOCKET_PATH_BYTES,
  SUITE_TMP_MAX_BYTES,
} from "./suite-tmpdir.js";

// macOS is the tightest platform the suite supports (104; Linux allows 108),
// so the budget is derived against it. Read from the shared implementation
// rather than hardcoded here, so a platform added to that table cannot leave
// this test's copy of the number behind.
const SUN_PATH_MAX = maxSunPathBytes("darwin");
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

  it("keeps the deepest socket path tests build beneath it within sun_path, whatever the base", () => {
    const longBase = path.join(os.tmpdir(), "x".repeat(80));
    fs.mkdirSync(longBase, { recursive: true });
    made.push(longBase);
    const suite = createSuiteTmpDir(longBase);
    made.push(suite);
    // The deepest socket path the suite binds beneath its root today — the
    // one SUITE_DEEPEST_SOCKET_PATH_BYTES names. If a test grows a deeper
    // one, this is the test that says so.
    const deepest = path.join(suite, "ssh-agent-socket-test-1234567-deadline-cleared.sock");
    expect(Buffer.byteLength(deepest)).toBeLessThanOrEqual(SUN_PATH_MAX - 1);
  });

  it("leaves room for the deepest socket path at the LONGEST root it allows", () => {
    // The case the derivation can get wrong: the budget is a bound on the
    // ROOT, and the socket path is the root JOINED to the path below it. A
    // budget derived from the path below the root alone forgets the
    // separator, and the error only shows at a root of exactly the maximum
    // length — which is why the /tmp-fallback case above cannot catch it.
    //
    // So build a base whose projected root is EXACTLY the budget, and check
    // the deepest socket path still fits.
    const prefix = "mullion-test-suite-";
    const mkdtempSuffixBytes = 6;
    // byteLength(base) + separator + prefix + mkdtemp suffix == the budget.
    const wantBaseBytes =
      SUITE_TMP_MAX_BYTES - 1 - Buffer.byteLength(prefix, "utf8") - mkdtempSuffixBytes;
    // A SHORT base root, not os.tmpdir(): global-setup points os.tmpdir() at
    // the suite's own temp root, which is already most of the budget, so a
    // base built under it could not be long enough to reach the maximum.
    const baseRoot = "/tmp";
    const nameBytes = wantBaseBytes - Buffer.byteLength(baseRoot, "utf8") - 1;
    const base = path.join(baseRoot, "b".repeat(Math.max(nameBytes, 1)));
    fs.mkdirSync(base, { recursive: true });
    made.push(base);
    // The base really is the length the budget is derived against.
    expect(Buffer.byteLength(path.join(base, prefix)) + mkdtempSuffixBytes).toBe(
      SUITE_TMP_MAX_BYTES,
    );

    const suite = createSuiteTmpDir(base);
    made.push(suite);
    // The root really is at the maximum the budget allows — and it was NOT
    // the /tmp fallback (which is short and would hide the arithmetic).
    expect(path.dirname(suite)).toBe(base);
    expect(Buffer.byteLength(suite)).toBe(SUITE_TMP_MAX_BYTES);
    // And the deepest socket path beneath it still fits macOS's sun_path.
    const deepest = path.join(suite, "ssh-agent-socket-test-1234567-deadline-cleared.sock");
    expect(Buffer.byteLength(deepest)).toBeLessThanOrEqual(SUN_PATH_MAX - 1);
  });

  it("derives the budget from the shared platform limit, not a magic number", () => {
    // The budget is the tightest platform's usable sun_path length minus the
    // deepest path the suite builds beneath the root. If the two drift apart,
    // the root is either shorter than it needs to be (a wasted fallback on
    // every run) or longer than the deepest socket can afford (an EINVAL on
    // macOS that Linux never sees).
    expect(SUITE_TMP_MAX_BYTES).toBe(SUN_PATH_MAX - 1 - SUITE_DEEPEST_SOCKET_PATH_BYTES);
    // The derivation must leave the deepest path fitting exactly, and it is
    // derived against macOS rather than the host platform — the suite has to
    // pass on the tightest platform, not the one the test runs on.
    expect(SUITE_TMP_MAX_BYTES + SUITE_DEEPEST_SOCKET_PATH_BYTES).toBeLessThanOrEqual(
      maxSunPathBytes("darwin") - 1,
    );
    expect(SUITE_TMP_MAX_BYTES).toBeLessThanOrEqual(maxSunPathBytes("linux") - 1);
  });

  it("the suite's own os.tmpdir() (set by global-setup) leaves room for the same socket path", () => {
    // Pins the wiring too: global-setup must point TMPDIR at the suite dir,
    // so a long TMPDIR in the invoking shell cannot leak through.
    const deepest = path.join(os.tmpdir(), "mullion-opencode-gate-XXXXXX", "hooks.sock");
    expect(Buffer.byteLength(deepest)).toBeLessThanOrEqual(SUN_PATH_MAX - 1);
  });
});
