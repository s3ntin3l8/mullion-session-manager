// Issue #1804 — node-pty's prebuilt `spawn-helper` ships without the
// executable bit, so on macOS every session spawn fails with "posix_spawnp
// failed." This exercises scripts/fix-node-pty-helper.mjs (the postinstall
// step that fixes it) against per-test fixture directories — precedent:
// test/scripts/check-scaffold-region-sync.test.ts, which drives its script
// through execFile the same way.
//
// The script takes the package root as an optional argument, so these tests
// never touch this repo's own node_modules.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const SCRIPT = fileURLToPath(new URL("../../scripts/fix-node-pty-helper.mjs", import.meta.url));

describe("fix-node-pty-helper.mjs", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "node-pty-helper-test-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Creates node_modules/node-pty/prebuilds/<platform>/{pty.node,spawn-helper}. */
  function seedPrebuild(platform: string, helperMode: number): string {
    const dir = path.join(root, "node_modules", "node-pty", "prebuilds", platform);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "pty.node"), "not really a native module");
    const helper = path.join(dir, "spawn-helper");
    fs.writeFileSync(helper, "not really a binary");
    fs.chmodSync(helper, helperMode);
    return helper;
  }

  function execBits(file: string): number {
    return fs.statSync(file).mode & 0o777;
  }

  it("makes a non-executable spawn-helper executable", async () => {
    const helper = seedPrebuild("darwin-arm64", 0o644);
    expect(execBits(helper)).toBe(0o644);

    await execFileAsync(process.execPath, [SCRIPT, root]);

    expect(execBits(helper)).toBe(0o755);
  });

  it("fixes every prebuilt platform, not just the first", async () => {
    const arm = seedPrebuild("darwin-arm64", 0o644);
    const intel = seedPrebuild("darwin-x64", 0o600);

    await execFileAsync(process.execPath, [SCRIPT, root]);

    expect(execBits(arm)).toBe(0o755);
    expect(execBits(intel)).toBe(0o755);
  });

  it("leaves an already-executable spawn-helper alone (idempotent)", async () => {
    const helper = seedPrebuild("darwin-arm64", 0o755);

    const { stdout } = await execFileAsync(process.execPath, [SCRIPT, root]);

    expect(execBits(helper)).toBe(0o755);
    // Nothing was changed, so nothing is reported.
    expect(stdout).not.toContain("spawn-helper");
  });

  it("is a no-op when node-pty is not installed at all", async () => {
    // No node-pty in the tree.
    await expect(execFileAsync(process.execPath, [SCRIPT, root])).resolves.toBeTruthy();

    // node-pty is installed, but with no prebuilds directory.
    fs.mkdirSync(path.join(root, "node_modules", "node-pty"), { recursive: true });
    await expect(execFileAsync(process.execPath, [SCRIPT, root])).resolves.toBeTruthy();
  });

  it("fixes the darwin-only prebuild tree that a Linux install really has", async () => {
    // npm extracts the WHOLE node-pty tarball on every platform, so a Linux
    // install has prebuilds/darwin-arm64 and prebuilds/darwin-x64 at 644 —
    // they are simply never exec'd there. The script still chmods them
    // (harmless), and this is the path that actually runs on Linux.
    const arm = seedPrebuild("darwin-arm64", 0o644);
    const intel = seedPrebuild("darwin-x64", 0o644);

    const { stdout } = await execFileAsync(process.execPath, [SCRIPT, root]);

    expect(execBits(arm)).toBe(0o755);
    expect(execBits(intel)).toBe(0o755);
    expect(stdout).toContain("made 2 spawn-helper executable");
  });

  it("leaves a helper that is already executable by its owner alone", async () => {
    // 0o744 is executable enough for posix_spawnp — widening it to 0o755
    // would hand group/other the exec bit for nothing.
    const helper = seedPrebuild("darwin-arm64", 0o744);

    const { stdout } = await execFileAsync(process.execPath, [SCRIPT, root]);

    expect(execBits(helper)).toBe(0o744);
    expect(stdout).not.toContain("spawn-helper");
  });

  it("does not touch pty.node (a dlopen'd module needs no executable bit)", async () => {
    seedPrebuild("darwin-arm64", 0o644);
    const ptyNode = path.join(
      root,
      "node_modules",
      "node-pty",
      "prebuilds",
      "darwin-arm64",
      "pty.node",
    );
    fs.chmodSync(ptyNode, 0o644);

    await execFileAsync(process.execPath, [SCRIPT, root]);

    expect(execBits(ptyNode)).toBe(0o644);
  });

  it("is wired into the package's postinstall", () => {
    const pkg = JSON.parse(
      fs.readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
    ) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.postinstall).toContain("fix-node-pty-helper.mjs");
  });
});
