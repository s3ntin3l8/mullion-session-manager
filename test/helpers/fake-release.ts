// A minimal, real .tgz release (plus its .sha256) for the update script to
// extract and verify. Shared by test/scripts/self-update.test.ts (the Linux
// shim suite) and self-update-windows.test.ts (the real thing, in Git Bash).
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Builds a minimal, real .tgz release the script can actually extract and
// verify: dist/server.js (existence-only gate), dist/app.js (a real,
// side-effect-free ESM module — the script `await import()`s it for real
// under the real Node running this test), and fake but real-enough
// node_modules/{better-sqlite3,node-pty} packages so `require()` resolves
// without needing the real native addons.
export async function buildFakeRelease(
  version: string,
  opts: { includeServerJs?: boolean; extraFiles?: Record<string, string> } = {},
): Promise<{ tarballPath: string; checksumPath: string }> {
  const { includeServerJs = true, extraFiles = {} } = opts;
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
      // self-update.sh's smoke check opens an in-memory better-sqlite3 DB
      // (its binding only loads in the constructor, #2066), so that stub must
      // be constructible and closable; node-pty's is only require()d.
      fs.writeFileSync(
        path.join(pkgDir, "index.js"),
        pkg === "better-sqlite3"
          ? "module.exports = class Database { close() {} };\n"
          : "module.exports = {};\n",
      );
    }

    // Anything else the release should carry (relative path -> contents): the
    // Windows tests add scripts/windows-launcher.mjs and the deploy/windows scripts.
    for (const [relative, contents] of Object.entries(extraFiles)) {
      const target = path.join(workDir, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
    }

    const tarballDir = fs.mkdtempSync(path.join(os.tmpdir(), "self-update-tarballs-"));
    const tarballName = `mullion-${version}.tgz`;
    const tarballPath = path.join(tarballDir, tarballName);
    // A RELATIVE archive name, run from its directory: GNU tar (Git Bash's, and
    // the one first on PATH there) reads an absolute Windows path as host:path
    // — "Cannot connect to D: resolve failed" — for the archive only, not for -C.
    await execFileAsync("tar", ["-czf", tarballName, "-C", workDir, "."], { cwd: tarballDir });

    const hash = crypto.createHash("sha256").update(fs.readFileSync(tarballPath)).digest("hex");
    const checksumPath = path.join(tarballDir, `${tarballName}.sha256`);
    fs.writeFileSync(checksumPath, `${hash}  ${tarballName}\n`);

    return { tarballPath, checksumPath };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
