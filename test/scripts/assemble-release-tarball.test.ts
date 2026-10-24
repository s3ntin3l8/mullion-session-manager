// scripts/assemble-release-tarball.sh is the only thing that decides what
// the published release tarball contains — the workflow used to do that
// inline, so the payload's shape was only ever observable by publishing a
// release and downloading it.
//
// The shape is load-bearing in both directions:
//
//   - src/plugins/env.ts's cwd-relative defaults (FRONTEND_DIST=./frontend/dist,
//     drizzle/ via path.resolve("drizzle")) and scripts/self-update.sh both
//     resolve against the extracted release directory, so the entries must
//     keep their positions and there must be NO wrapping directory;
//   - deploy/ must be IN there. Without it, install.sh and the launchd plist
//     templates exist only in a git checkout, so a macOS install needs a
//     clone in addition to the published tarball — the gap this change
//     closes.
//
// So this suite pins the layout rather than the script's internals: it
// assembles a real tarball from a fixture tree and asserts what is and is
// not inside it.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ASSEMBLER = path.join(REPO_ROOT, "scripts", "assemble-release-tarball.sh");

const VERSION = "9.9.9";
const TARBALL = `mullion-${VERSION}.tgz`;

let tmpDir: string;
let fixture: string;
let outDir: string;

function run(cmd: string, args: string[], opts: { cwd?: string } = {}) {
  return execFileAsync(cmd, args, { cwd: opts.cwd ?? tmpDir, timeout: 30_000 });
}

/**
 * A fixture tree shaped like the repo: the assembler resolves its repo root
 * from its own location ($HERE/..), so the script is copied INTO the fixture
 * and the fixture becomes "the repo" for that run. deploy/ is the REAL
 * directory, copied verbatim — so the exclusions below are tested against
 * the files that are actually there, not against a hand-written mock that
 * could drift away from them.
 */
function buildFixture() {
  fs.mkdirSync(path.join(fixture, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(fixture, "dist"), { recursive: true });
  fs.mkdirSync(path.join(fixture, "frontend", "dist"), { recursive: true });
  fs.mkdirSync(path.join(fixture, "drizzle"), { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  fs.copyFileSync(ASSEMBLER, path.join(fixture, "scripts", "assemble-release-tarball.sh"));
  fs.writeFileSync(path.join(fixture, "scripts", "portable.sh"), "# portable helpers\n");
  fs.writeFileSync(path.join(fixture, "dist", "index.js"), "// backend\n");
  fs.writeFileSync(path.join(fixture, "frontend", "dist", "index.html"), "<html></html>\n");
  fs.writeFileSync(path.join(fixture, "drizzle", "0000_init.sql"), "SELECT 1;\n");
  fs.writeFileSync(path.join(fixture, "package.json"), '{"name":"mullion"}\n');
  fs.writeFileSync(path.join(fixture, "package-lock.json"), '{"lockfileVersion":3}\n');

  fs.cpSync(path.join(REPO_ROOT, "deploy"), path.join(fixture, "deploy"), { recursive: true });

  // macOS's Finder metadata: gitignored, so it never reaches the repository,
  // but `cp -R` copies the working tree — a developer who has merely browsed
  // deploy/ in Finder has one there. It must not ship.
  fs.writeFileSync(path.join(fixture, "deploy", ".DS_Store"), "finder junk\n");
}

function tarballEntries(): string[] {
  const stdout = execFileSync("tar", ["-tzf", path.join(outDir, TARBALL)], {
    encoding: "utf8",
  });
  return stdout.split("\n").filter((line) => line.length > 0);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-assemble-"));
  fixture = path.join(tmpDir, "fixture");
  outDir = path.join(tmpDir, "out");
  buildFixture();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("scripts/assemble-release-tarball.sh", () => {
  it("produces the tarball and its checksum", async () => {
    await run("bash", [
      path.join(fixture, "scripts", "assemble-release-tarball.sh"),
      VERSION,
      outDir,
    ]);

    expect(fs.existsSync(path.join(outDir, TARBALL))).toBe(true);
    expect(fs.existsSync(path.join(outDir, `${TARBALL}.sha256`))).toBe(true);

    // The checksum must be in the standard sha256sum format ("<hex>  <file>",
    // two spaces) so `sha256sum -c` / `shasum -a 256 -c` can read it — both
    // deploy/install.sh and scripts/self-update.sh consume it that way.
    const checksum = fs.readFileSync(path.join(outDir, `${TARBALL}.sha256`), "utf8");
    expect(checksum).toMatch(/^[0-9a-f]{64} {2}mullion-9\.9\.9\.tgz\n?$/);
  });

  it("keeps the payload's root layout — no wrapping directory", async () => {
    await run("bash", [
      path.join(fixture, "scripts", "assemble-release-tarball.sh"),
      VERSION,
      outDir,
    ]);

    const entries = tarballEntries();
    // Everything is relative to the tarball's root ("./"), never nested one
    // level deeper — `tar -czf x.tgz staging/` would produce exactly that
    // mistake, and self-update.sh's `tar -xzf ... -C "$RELEASE_DIR"` would
    // then land the payload in releases/<version>/staging/.
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.startsWith("./")).toBe(true);
      expect(entry.startsWith("./staging/")).toBe(false);
    }
  });

  it("carries the runtime payload the app and the updater resolve against", async () => {
    await run("bash", [
      path.join(fixture, "scripts", "assemble-release-tarball.sh"),
      VERSION,
      outDir,
    ]);

    const entries = new Set(tarballEntries());
    for (const expected of [
      "./dist/index.js",
      "./frontend/dist/index.html",
      "./drizzle/0000_init.sql",
      "./scripts/portable.sh",
      "./package.json",
      "./package-lock.json",
    ]) {
      expect(entries.has(expected)).toBe(true);
    }
  });

  it("carries the installer, so a macOS install needs no clone", async () => {
    await run("bash", [
      path.join(fixture, "scripts", "assemble-release-tarball.sh"),
      VERSION,
      outDir,
    ]);

    const entries = new Set(tarballEntries());
    for (const expected of [
      "./deploy/install.sh",
      "./deploy/mullion-install.sh",
      "./deploy/launchd/com.mullion.primary.plist",
      "./deploy/launchd/com.mullion.agent.plist",
      "./deploy/mullion.service",
      "./deploy/mullion-agent.service",
      "./deploy/README.md",
    ]) {
      expect(entries.has(expected)).toBe(true);
    }
  });

  it("excludes the reverse-proxy examples and the retired macOS installer leftovers", async () => {
    await run("bash", [
      path.join(fixture, "scripts", "assemble-release-tarball.sh"),
      VERSION,
      outDir,
    ]);

    const entries = tarballEntries();
    // The installer never reads these — they are operator documentation.
    expect(entries).not.toContain("./deploy/traefik-dynamic.yml");
    expect(entries).not.toContain("./deploy/authentik-middleware-example.yml");
    // deploy/macos/ held the retired Helper installers' .pkg builder and
    // postinstall (removed in #1207); only an orphaned logo PNG was left.
    expect(entries.filter((e) => e.startsWith("./deploy/macos/"))).toEqual([]);
  });

  it("keeps macOS's Finder metadata out of the payload", async () => {
    await run("bash", [
      path.join(fixture, "scripts", "assemble-release-tarball.sh"),
      VERSION,
      outDir,
    ]);

    expect(tarballEntries().filter((e) => e.endsWith(".DS_Store"))).toEqual([]);
  });

  it("preserves the installer's executable bit", async () => {
    await run("bash", [
      path.join(fixture, "scripts", "assemble-release-tarball.sh"),
      VERSION,
      outDir,
    ]);

    const extractDir = path.join(tmpDir, "extracted");
    fs.mkdirSync(extractDir, { recursive: true });
    await run("tar", ["-xzf", path.join(outDir, TARBALL), "-C", extractDir]);

    const mode = fs.statSync(path.join(extractDir, "deploy", "install.sh")).mode;
    expect(mode & 0o111).not.toBe(0);
  });

  it("produces a payload whose installer resolves its own ../scripts/portable.sh", async () => {
    // The relative layout is what makes the extracted payload self-sufficient:
    // install.sh sources $SCRIPT_DIR/../scripts/portable.sh and reads
    // $SCRIPT_DIR/launchd/*.plist. If the archive nested anything one level
    // deeper, both would break — silently, at install time on a Mac.
    await run("bash", [
      path.join(fixture, "scripts", "assemble-release-tarball.sh"),
      VERSION,
      outDir,
    ]);

    const extractDir = path.join(tmpDir, "extracted");
    fs.mkdirSync(extractDir, { recursive: true });
    await run("tar", ["-xzf", path.join(outDir, TARBALL), "-C", extractDir]);

    // `install.sh --help` reaches its own usage output only if portable.sh
    // resolved — the source line is above the argument parsing, so a missing
    // sibling script aborts the run before anything is printed.
    const { stdout, stderr } = await run("bash", [
      path.join(extractDir, "deploy", "install.sh"),
      "--help",
    ]);
    expect(`${stdout}${stderr}`).toContain("usage: deploy/install.sh");
  });

  it("refuses a version that could escape the output directory", async () => {
    await expect(
      run("bash", [
        path.join(fixture, "scripts", "assemble-release-tarball.sh"),
        "../../etc/passwd",
        outDir,
      ]),
    ).rejects.toThrow(/invalid version/);
  });

  it("refuses to run before the build outputs exist", async () => {
    fs.rmSync(path.join(fixture, "dist"), { recursive: true, force: true });
    await expect(
      run("bash", [path.join(fixture, "scripts", "assemble-release-tarball.sh"), VERSION, outDir]),
    ).rejects.toThrow(/missing 'dist'/);
  });
});
