// Tripwire for issues #1602 and #1649: a test that runs `git init` /
// `git config` against the real checkout (e.g. via a GIT_DIR leaked from the
// pre-push hook) silently rewrote its .git/config — `core.bare = true`, then
// `user.name = Test`. Snapshot the identity/core keys before the run and fail
// it if they differ afterwards, so the leak surfaces the moment it happens
// instead of weeks of mis-authored commits later. Logic and known limits:
// test/helpers/checkout-config.ts.
import path from "node:path";
import {
  assertConfigUnchanged,
  resolveConfigPath,
  snapshotConfig,
} from "./helpers/checkout-config.js";

const ROOT = path.resolve(__dirname, "..");

let configPath: string | null = null;
let before = "";

export function setup(): void {
  configPath = resolveConfigPath(ROOT);
  if (configPath) before = snapshotConfig(configPath);
}

export function teardown(): void {
  if (configPath) assertConfigUnchanged(configPath, before);
}
