#!/usr/bin/env node
// Round 3 (PR2) — builds `mullion-helper[.exe]`, a Node Single Executable
// Application (https://nodejs.org/api/single-executable-applications.html)
// bundling src/cli/helper-main.mjs so a laptop can run `mullion helper
// pair|run|install|uninstall` with no Node install of its own. `npm run
// build:helper-sea`; CI wires this into `.github/workflows/release-please.yml`
// (a `windows-latest` job, gated on `release_created`, mirroring
// `build-tarball`'s own shape) and into `ci-cd.yml` (a Linux smoke-test job
// that builds and probes the SAME bundle on every PR — see that job's own
// comment for what it can and can't prove from Linux).
//
// Node SEA is still explicitly experimental upstream, and `postject`
// (https://www.npmjs.com/package/postject) is still `1.0.0-alpha.6` as of
// this PR — both are the currently-recommended tools for this regardless,
// there's no stable alternative.
//
// Bundled to CJS, not ESM, even though Node 26's `--experimental-sea-config`
// itself accepts `"mainFormat": "module"`. Deliberately NOT that: with an
// ESM main, `import.meta.url` inside the bundle resolves to
// `pathToFileURL(process.execPath)` — a PLAUSIBLE-LOOKING but wrong value,
// since nothing inside a SEA has "a directory it lives in" the way a real
// file does — so a future accidental `import.meta` reference would silently
// resolve to a bogus path instead of failing anywhere. CJS output makes
// `import.meta` empty instead, and `--log-override:empty-import-meta=error`
// (below) promotes that to a hard BUILD failure — this is exactly the
// mechanism that caught src/cli/ssh-agent-helper-install.mjs's own
// `defaultScriptPath()` during development (see
// src/cli/ssh-agent-helper-default-script-path.mjs's header comment for how
// that one specific `import.meta.url` use is kept out of this bundle
// entirely, rather than merely gated at runtime).
import { build as esbuildBuild } from "esbuild";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");
const buildDir = path.join(repoRoot, "build", "helper-sea");
const entryPoint = path.join(repoRoot, "src", "cli", "helper-main.mjs");

// The one file this bundle must never inline — see its own header comment.
// A plugin's onResolve `filter`, not esbuild's plain `external:` array with
// a computed absolute path: the first attempt (`external:
// [path.join(repoRoot, "src", "cli", "ssh-agent-helper-default-script-
// path.mjs")]`) worked locally on Linux but failed on the real
// windows-latest CI runner with the exact "import.meta is not available"
// error this whole mechanism exists to prevent — esbuild's own resolved-
// path matching for `external` didn't line up with a Windows-style
// (backslash, drive-letter) absolute path the way it does with a POSIX
// one. `onResolve`'s `filter` instead matches the RAW import specifier
// TEXT as written in the source (`"./ssh-agent-helper-default-script-
// path.mjs"`, relative to ssh-agent-helper-install.mjs) — a plain string
// match with nothing OS-path-specific about it, so it can't have this
// class of platform-dependent failure at all.
const externalDefaultScriptPathPlugin = {
  name: "external-default-script-path",
  setup(build) {
    build.onResolve({ filter: /ssh-agent-helper-default-script-path\.mjs$/ }, (args) => ({
      path: args.path,
      external: true,
    }));
  },
};

const bundlePath = path.join(buildDir, "bundle.cjs");
const seaConfigPath = path.join(buildDir, "sea-config.json");
const blobPath = path.join(buildDir, "helper.blob");
const exeName = process.platform === "win32" ? "mullion-helper.exe" : "mullion-helper";
const exePath = path.join(buildDir, exeName);

// The Node SEA "sentinel fuse" — a fixed, documented constant (not a secret,
// not versioned per-Node-release), identical for every SEA anyone builds;
// postject looks for this exact byte string in the target binary to find
// where to inject the blob. https://nodejs.org/api/single-executable-
// applications.html#generating-single-executable-preparation-blobs
const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

function log(message) {
  process.stdout.write(`[build-helper-sea] ${message}\n`);
}

async function bundle() {
  fs.rmSync(buildDir, { recursive: true, force: true });
  fs.mkdirSync(buildDir, { recursive: true });
  log(`bundling ${path.relative(repoRoot, entryPoint)} -> ${path.relative(repoRoot, bundlePath)}`);
  await esbuildBuild({
    entryPoints: [entryPoint],
    outfile: bundlePath,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    // Node's own WebSocket/fetch globals (ssh-agent-bridge-mux.mjs,
    // ssh-agent-helper.mjs's renewal loop) are runtime built-ins, not
    // npm packages — nothing to bundle or externalize for those.
    logOverride: { "empty-import-meta": "error" },
    plugins: [externalDefaultScriptPathPlugin],
  });
}

function writeSeaConfig() {
  // Deliberately NOT setting `mainFormat` (defaults to "commonjs", matching
  // the bundle's own --format=cjs above) — see this file's header comment.
  // `useCodeCache`/`useSnapshot` are both left off: they're startup-latency
  // optimizations, not correctness-relevant, and this binary's own startup
  // cost is irrelevant next to the network round trips `run`/`pair` do.
  const config = {
    main: bundlePath,
    output: blobPath,
    disableExperimentalSEAWarning: true,
  };
  fs.writeFileSync(seaConfigPath, JSON.stringify(config, null, 2));
}

function generateBlob() {
  log("generating SEA blob");
  execFileSync(process.execPath, ["--experimental-sea-config", seaConfigPath], {
    stdio: "inherit",
  });
}

function copyNodeBinary() {
  // process.execPath, NOT `node` resolved through the shell/PATH — a dev
  // machine's `node` can be an nvm shim or another wrapper script, not the
  // real ELF/PE/Mach-O binary postject needs (confirmed empirically:
  // postject rejects a shim with "Executable must be a supported format").
  log(`copying node binary (${process.execPath}) -> ${path.relative(repoRoot, exePath)}`);
  fs.copyFileSync(process.execPath, exePath);
  if (process.platform !== "win32") fs.chmodSync(exePath, 0o755);
}

function removeWindowsSignature() {
  if (process.platform !== "win32") return;
  // The official node.exe is Authenticode-signed; postject's own docs note
  // injecting into a signed PE can fail or produce a binary whose signature
  // no longer verifies (it wasn't Mullion's own signature to begin with —
  // this is a copy of the stock Node build). `signtool remove /s` strips
  // it first. Best-effort: if signtool isn't on PATH or the binary was
  // already unsigned, this is a no-op failure, not a build failure — most
  // of the actual injection step below has its own real error handling.
  try {
    execFileSync("signtool", ["remove", "/s", exePath], { stdio: "inherit" });
  } catch (err) {
    log(`signtool remove skipped (non-fatal): ${err.message}`);
  }
}

function injectBlob() {
  log("injecting SEA blob via postject");
  const postjectBin = path.join(
    repoRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "postject.cmd" : "postject",
  );
  const args = [exePath, "NODE_SEA_BLOB", blobPath, "--sentinel-fuse", SEA_FUSE];
  // macOS would also need --macho-segment-name NODE_SEA — not reachable
  // from this Windows-only build (process.platform is the actual OS this
  // script runs ON, which for the shipping artifact is always win32 per
  // the windows-latest CI job — see that job's own comment), so left
  // unimplemented rather than guessed at.
  if (process.platform === "darwin") {
    args.push("--macho-segment-name", "NODE_SEA");
  }
  // `shell: true` on win32 ONLY (confirmed necessary against the real
  // windows-latest CI runner, not guessed): npm's own `.bin/` wrapper for
  // a package's bin entry is a `.cmd` shim on Windows, not a real PE
  // executable, and Node's `spawnSync`/`execFileSync` cannot invoke a
  // `.cmd`/`.bat` file directly without a shell in between — it fails with
  // EINVAL (this exact error, on this exact line, is what CI surfaced
  // before this fix). POSIX's `postject` bin is a real file with a `#!`
  // shebang, which spawns directly just fine — `shell: true` there would
  // be an unnecessary (if likely harmless) behavior change, so this stays
  // platform-scoped rather than unconditional.
  execFileSync(postjectBin, args, { stdio: "inherit", shell: process.platform === "win32" });
}

async function main() {
  await bundle();
  writeSeaConfig();
  generateBlob();
  copyNodeBinary();
  removeWindowsSignature();
  injectBlob();
  log(`built ${path.relative(repoRoot, exePath)}`);
  // Deliberately no smoke test here — a build script's job is producing
  // the artifact, not verifying it. The CI workflows that invoke this
  // (ci-cd.yml's Linux job, release-please.yml's windows-latest job) run
  // their own explicit probe steps against ${exePath} afterward, so a
  // failure shows up as its own named CI step, not buried inside "build
  // the exe."
}

main().catch((err) => {
  process.stderr.write(`[build-helper-sea] ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
