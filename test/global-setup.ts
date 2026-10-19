// Tripwire for issues #1602 and #1649: a test that runs `git init` /
// `git config` against the real checkout (e.g. via a GIT_DIR leaked from the
// pre-push hook) silently rewrote its .git/config — `core.bare = true`, then
// `user.name = Test`. Snapshot the identity/core keys before the run and fail
// it if they differ afterwards, so the leak surfaces the moment it happens
// instead of weeks of mis-authored commits later. The git index gets the same
// check (a leaked GIT_DIR once emptied a worktree's index on pre-push). Logic
// and known limits:
// test/helpers/checkout-config.ts.
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import {
  assertConfigUnchanged,
  assertIndexIntact,
  resolveConfigPath,
  snapshotConfig,
  snapshotIndex,
  type IndexSnapshot,
} from "./helpers/checkout-config.js";

const ROOT = path.resolve(__dirname, "..");

let configPath: string | null = null;
let before = "";
let indexBefore: IndexSnapshot | null = null;
let suiteTmpDir: string | null = null;
let origTmpDir: string | undefined;
let origTemp: string | undefined;
let origTmp: string | undefined;

export function setup(): void {
  configPath = resolveConfigPath(ROOT);
  if (configPath) before = snapshotConfig(configPath);
  indexBefore = snapshotIndex(ROOT);

  // Snapshot caller process environment so teardown() can cleanly restore it
  origTmpDir = process.env.TMPDIR;
  origTemp = process.env.TEMP;
  origTmp = process.env.TMP;

  // Issue #1681 — Sandboxes all test runs using os.tmpdir() / process.env.TMPDIR
  // into a single suite-level temporary directory. Guarantees that even if tests
  // fail, throw, or timeout before their local afterEach/afterAll cleanup runs,
  // the entire run's temporary files are cleaned up in teardown().
  suiteTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-test-suite-"));
  process.env.TMPDIR = suiteTmpDir;
  process.env.TEMP = suiteTmpDir;
  process.env.TMP = suiteTmpDir;
}

export function teardown(): void {
  try {
    // Run both checks and report everything: one leak usually does both.
    const errors: string[] = [];
    for (const check of [
      () => configPath && assertConfigUnchanged(configPath, before),
      () => assertIndexIntact(ROOT, indexBefore),
    ]) {
      try {
        check();
      } catch (err) {
        errors.push((err as Error).message);
      }
    }
    if (errors.length > 0) throw new Error(errors.join("\n\n"));
  } finally {
    // Restore original temp environment variables
    if (origTmpDir !== undefined) process.env.TMPDIR = origTmpDir;
    else delete process.env.TMPDIR;
    if (origTemp !== undefined) process.env.TEMP = origTemp;
    else delete process.env.TEMP;
    if (origTmp !== undefined) process.env.TMP = origTmp;
    else delete process.env.TMP;

    if (suiteTmpDir) {
      try {
        fs.rmSync(suiteTmpDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
    }
  }
}
