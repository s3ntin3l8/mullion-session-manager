// Issue #647 / roadmap 7.8 — scripts/self-update.sh had zero automated
// coverage before this (see the plan's own note: vitest doesn't cover
// shell). Exercises the REAL script end-to-end via execFile, with
// curl/npm/npx/systemctl shimmed on PATH (this suite never downloads
// anything or touches the host's real systemd) but every other command
// — mkdir, tar, sha256sum, the two `node -e` smoke checks, ln/mv, find —
// running for real against real temp directories, the same coverage shape
// the plan's own §5 promises: lock/status/symlink/prune logic and the
// failure paths are real; the *content* of a real npm-ci'd node_modules is
// not (that stays the live-acceptance gate documented in the PR).
//
// Linux-only: sha256sum, GNU `stat -c`, and `mv -T` (all used by the script
// itself) aren't portable to macOS/BSD.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const SELF_UPDATE_SCRIPT = fileURLToPath(new URL("../../scripts/self-update.sh", import.meta.url));

const describeOnLinux = process.platform === "linux" ? describe : describe.skip;

function writeShim(binDir: string, name: string, script: string) {
  const p = path.join(binDir, name);
  fs.writeFileSync(p, script);
  fs.chmodSync(p, 0o755);
}

// curl/npm/npx/systemctl are the only commands this script shells out to
// that would either reach the real network, run a real (slow) install, or
// touch the host's real systemd — every other command it uses (mkdir, tar,
// sha256sum, node, ln, mv, find, rm) runs for real. curl's shim resolves a
// `file://<path>` "URL" by copying that real local file — this test controls
// both the asset/checksum "URLs" it hands the script (bypassing the JSON
// schema the Fastify route separately enforces on `https://github.com/...`,
// same as the script itself never validates them).
function writeShims(binDir: string) {
  writeShim(
    binDir,
    "curl",
    `#!/usr/bin/env bash
set -euo pipefail
output=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then
    output="$arg"
  fi
  prev="$arg"
done
url="\${*: -1}"
src="\${url#file://}"
cp "$src" "$output"
`,
  );
  for (const name of ["npm", "npx", "systemctl"]) {
    writeShim(binDir, name, "#!/usr/bin/env bash\nexit 0\n");
  }
  // The script's own `export PATH="$(dirname "$NODE_EXEC_PATH"):$PATH"`
  // (needed in production, where systemd's minimal PATH means npm/node
  // aren't reliably on it — see the script's own header comment) would
  // otherwise prepend a real node install's bin/ dir — which, under nvm,
  // ALSO bundles a real npm/npx — ahead of this shim dir, defeating the
  // npm/npx shims above. Copying (not symlinking — a symlinked binary can
  // resolve its own sibling paths differently) the real node binary into
  // this same dir makes dirname(NODE_EXEC_PATH) resolve to binDir itself,
  // so the prepend is a harmless no-op duplicate and the shims stay first.
  fs.copyFileSync(process.execPath, path.join(binDir, "node"));
  fs.chmodSync(path.join(binDir, "node"), 0o755);
}

// Builds a minimal, real .tgz release the script can actually extract and
// verify: dist/server.js (existence-only gate), dist/app.js (a real,
// side-effect-free ESM module — the script `await import()`s it for real
// under the real Node running this test), and fake but real-enough
// node_modules/{better-sqlite3,node-pty} packages so `require()` resolves
// without needing the real native addons.
async function buildFakeRelease(
  version: string,
  opts: { includeServerJs?: boolean } = {},
): Promise<{ tarballPath: string; checksumPath: string }> {
  const { includeServerJs = true } = opts;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "self-update-release-src-"));
  try {
    fs.mkdirSync(path.join(workDir, "dist"), { recursive: true });
    if (includeServerJs) {
      fs.writeFileSync(path.join(workDir, "dist", "server.js"), "// fake server\n");
    }
    fs.writeFileSync(path.join(workDir, "dist", "app.js"), "export const ok = true;\n");
    for (const pkg of ["better-sqlite3", "node-pty"]) {
      const pkgDir = path.join(workDir, "node_modules", pkg);
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(
        path.join(pkgDir, "package.json"),
        JSON.stringify({ name: pkg, main: "index.js" }),
      );
      fs.writeFileSync(path.join(pkgDir, "index.js"), "module.exports = {};\n");
    }

    const tarballDir = fs.mkdtempSync(path.join(os.tmpdir(), "self-update-tarballs-"));
    const tarballName = `mullion-${version}.tgz`;
    const tarballPath = path.join(tarballDir, tarballName);
    await execFileAsync("tar", ["-czf", tarballPath, "-C", workDir, "."]);

    const hash = crypto.createHash("sha256").update(fs.readFileSync(tarballPath)).digest("hex");
    const checksumPath = path.join(tarballDir, `${tarballName}.sha256`);
    fs.writeFileSync(checksumPath, `${hash}  ${tarballName}\n`);

    return { tarballPath, checksumPath };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

describeOnLinux("scripts/self-update.sh", () => {
  let mullionHome: string;
  let binDir: string;

  beforeEach(() => {
    mullionHome = fs.mkdtempSync(path.join(os.tmpdir(), "self-update-test-home-"));
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), "self-update-test-bin-"));
    writeShims(binDir);
  });

  afterEach(() => {
    fs.rmSync(mullionHome, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  function readStatus(): { phase: string; version?: string; error?: string } {
    return JSON.parse(fs.readFileSync(path.join(mullionHome, ".update-status.json"), "utf8"));
  }

  function runScript(opts: {
    version: string;
    assetUrl: string;
    checksumUrl: string;
    unitName?: string;
  }) {
    return execFileAsync(
      "bash",
      [
        SELF_UPDATE_SCRIPT,
        opts.version,
        opts.assetUrl,
        opts.checksumUrl,
        mullionHome,
        path.join(binDir, "node"),
        opts.unitName ?? "fake-mullion.service",
      ],
      {
        cwd: mullionHome,
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
        timeout: 20_000,
      },
    );
  }

  it("downloads, verifies, installs, and flips current on a successful update", async () => {
    const { tarballPath, checksumPath } = await buildFakeRelease("9.9.9");

    await runScript({
      version: "9.9.9",
      assetUrl: `file://${tarballPath}`,
      checksumUrl: `file://${checksumPath}`,
    });

    expect(readStatus()).toMatchObject({ phase: "done", version: "9.9.9" });
    expect(fs.readlinkSync(path.join(mullionHome, "current"))).toBe(
      path.join(mullionHome, "releases", "9.9.9"),
    );
    expect(fs.existsSync(path.join(mullionHome, "releases", "9.9.9", "dist", "server.js"))).toBe(
      true,
    );
  });

  it("leaves current untouched when checksum verification fails", async () => {
    const { tarballPath, checksumPath } = await buildFakeRelease("9.9.8");
    // Corrupt the checksum file's hash (same filename, wrong hex) — the
    // script's sha256sum -c must reject this before ever extracting.
    fs.writeFileSync(checksumPath, `${"0".repeat(64)}  mullion-9.9.8.tgz\n`);

    await expect(
      runScript({
        version: "9.9.8",
        assetUrl: `file://${tarballPath}`,
        checksumUrl: `file://${checksumPath}`,
      }),
    ).rejects.toThrow();

    expect(readStatus()).toMatchObject({ phase: "failed" });
    expect(fs.existsSync(path.join(mullionHome, "current"))).toBe(false);
  });

  it("leaves current untouched when dist/server.js is missing after extraction (verify gate)", async () => {
    const { tarballPath, checksumPath } = await buildFakeRelease("9.9.7", {
      includeServerJs: false,
    });

    await expect(
      runScript({
        version: "9.9.7",
        assetUrl: `file://${tarballPath}`,
        checksumUrl: `file://${checksumPath}`,
      }),
    ).rejects.toThrow();

    const status = readStatus();
    expect(status.phase).toBe("failed");
    expect(status.error).toMatch(/dist\/server\.js/);
    expect(fs.existsSync(path.join(mullionHome, "current"))).toBe(false);
    // The partial release dir is cleaned up on this failure path too.
    expect(fs.existsSync(path.join(mullionHome, "releases", "9.9.7"))).toBe(false);
  });

  it("refuses to run when a fresh update lock is already held", async () => {
    fs.mkdirSync(path.join(mullionHome, ".update.lock"));
    const { tarballPath, checksumPath } = await buildFakeRelease("9.9.6");

    await expect(
      runScript({
        version: "9.9.6",
        assetUrl: `file://${tarballPath}`,
        checksumUrl: `file://${checksumPath}`,
      }),
    ).rejects.toThrow();

    // acquire_lock fails before write_status("downloading") is ever
    // called — no status file, no releases dir, from THIS run.
    expect(fs.existsSync(path.join(mullionHome, ".update-status.json"))).toBe(false);
    expect(fs.existsSync(path.join(mullionHome, "releases"))).toBe(false);
  });

  it("recovers from a stale lock left by a crashed prior run", async () => {
    const lockDir = path.join(mullionHome, ".update.lock");
    fs.mkdirSync(lockDir);
    // Older than STALE_LOCK_SECONDS (2400s, post-#647 correction) — must be
    // treated as abandoned, not a genuinely running update.
    const staleTime = new Date(Date.now() - 3000 * 1000);
    fs.utimesSync(lockDir, staleTime, staleTime);
    const { tarballPath, checksumPath } = await buildFakeRelease("9.9.5");

    await runScript({
      version: "9.9.5",
      assetUrl: `file://${tarballPath}`,
      checksumUrl: `file://${checksumPath}`,
    });

    expect(readStatus()).toMatchObject({ phase: "done", version: "9.9.5" });
  });

  it("keeps only the newest 3 releases, protecting whatever `current` points at", async () => {
    const releasesDir = path.join(mullionHome, "releases");
    fs.mkdirSync(releasesDir, { recursive: true });
    for (const oldVersion of ["0.0.1", "0.0.2", "0.0.3"]) {
      fs.mkdirSync(path.join(releasesDir, oldVersion));
    }
    const { tarballPath, checksumPath } = await buildFakeRelease("9.9.4");

    await runScript({
      version: "9.9.4",
      assetUrl: `file://${tarballPath}`,
      checksumUrl: `file://${checksumPath}`,
    });

    const remaining = fs.readdirSync(releasesDir).sort();
    expect(remaining).toEqual(["0.0.2", "0.0.3", "9.9.4"]);
    expect(fs.readlinkSync(path.join(mullionHome, "current"))).toBe(
      path.join(releasesDir, "9.9.4"),
    );
  });
});
