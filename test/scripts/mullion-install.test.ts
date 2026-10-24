// deploy/mullion-install.sh is the clone-free entry point: it resolves the
// latest published release, downloads it, verifies its checksum, and then
// runs the deploy/install.sh that is INSIDE that release.
//
// The properties worth guarding in CI are the ones that keep it honest:
//
//   1. it never reaches the network for anything but the release itself, and
//      it verifies the download's checksum BEFORE extracting anything — a
//      tampered asset must abort the run with nothing installed;
//   2. it forwards every argument to the release's own installer verbatim,
//      so the bootstrap and the clone path install identically;
//   3. it leaves nothing behind (its temp dir is removed on every exit).
//
// The installer it hands off to is a fixture, not the real deploy/install.sh:
// this suite is about the bootstrap's contract, and running the real
// installer here would provision a host.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BOOTSTRAP = path.join(REPO_ROOT, "deploy", "mullion-install.sh");

const VERSION = "9.9.9";
const TAG = `v${VERSION}`;
const TARBALL_NAME = `mullion-${VERSION}.tgz`;
const REPO = "s3ntin3l8/mullion-session-manager";

let tmpDir: string;
let binDir: string;
let fixtureDir: string;
let outDir: string;
let scratchDir: string;
let tarballPath: string;
let checksumPath: string;
let argsFile: string;

/**
 * The curl stub serves the three calls the bootstrap makes and refuses
 * everything else, so a run that reaches for anything unexpected fails loudly
 * instead of touching the network.
 */
const CURL_STUB = `#!/usr/bin/env bash
set -euo pipefail
out=""
url=""
prev=""
for arg in "$@"; do
  case "$prev" in
    -o) out="$arg" ;;
  esac
  prev="$arg"
  case "$arg" in
    http://* | https://*) url="$arg" ;;
  esac
done
case "$url" in
  */releases/latest)
    printf '%s\\n' "$MULLION_TEST_LATEST_URL"
    ;;
  *.sha256)
    cp "$MULLION_TEST_CHECKSUM" "$out"
    ;;
  *.tgz)
    cp "$MULLION_TEST_TARBALL" "$out"
    ;;
  *)
    echo "unexpected curl invocation, refusing: $*" >&2
    exit 1
    ;;
esac
`;

/** The fixture's stand-in for the release's own deploy/install.sh. */
const FAKE_INSTALLER = `#!/usr/bin/env bash
printf '%s\\n' "$@" >"$MULLION_TEST_INSTALLER_ARGS"
exit "\${MULLION_TEST_INSTALLER_EXIT:-0}"
`;

function writeChecksum(hex: string) {
  fs.writeFileSync(checksumPath, `${hex}  ${TARBALL_NAME}\n`);
}

/** Portable sha256 — macOS ships `shasum`, not GNU's `sha256sum`. */
function sha256Of(file: string): string {
  const isDarwin = process.platform === "darwin";
  const stdout = execFileSync(
    isDarwin ? "shasum" : "sha256sum",
    isDarwin ? ["-a", "256", file] : [file],
    {
      encoding: "utf8",
    },
  );
  return stdout.split(/\s+/)[0];
}

function runBootstrap(args: string[], env: Record<string, string> = {}) {
  return execFileAsync("sh", [BOOTSTRAP, ...args], {
    timeout: 30_000,
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      TMPDIR: scratchDir,
      MULLION_TEST_LATEST_URL: `https://github.com/${REPO}/releases/tag/${TAG}`,
      MULLION_TEST_TARBALL: tarballPath,
      MULLION_TEST_CHECKSUM: checksumPath,
      MULLION_TEST_INSTALLER_ARGS: argsFile,
      ...env,
    },
  });
}

/** Runs a command expected to fail, and hands back what it printed. */
async function failureOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code };
  }
  throw new Error("expected the command to fail, but it succeeded");
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-bootstrap-"));
  binDir = path.join(tmpDir, "bin");
  fixtureDir = path.join(tmpDir, "fixture");
  outDir = path.join(tmpDir, "out");
  scratchDir = path.join(tmpDir, "scratch");
  tarballPath = path.join(outDir, TARBALL_NAME);
  checksumPath = path.join(outDir, `${TARBALL_NAME}.sha256`);
  argsFile = path.join(tmpDir, "installer-args.txt");

  for (const dir of [binDir, fixtureDir, outDir, scratchDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // The fixture release: a payload whose deploy/install.sh records the
  // arguments it was handed.
  fs.mkdirSync(path.join(fixtureDir, "deploy"), { recursive: true });
  fs.mkdirSync(path.join(fixtureDir, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(fixtureDir, "deploy", "install.sh"), FAKE_INSTALLER);
  fs.writeFileSync(path.join(fixtureDir, "scripts", "portable.sh"), "# portable helpers\n");

  execFileSync("tar", ["-czf", tarballPath, "-C", fixtureDir, "."]);
  writeChecksum(sha256Of(tarballPath));

  fs.writeFileSync(path.join(binDir, "curl"), CURL_STUB, { mode: 0o755 });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("deploy/mullion-install.sh", () => {
  it("runs the release's own installer with the arguments forwarded verbatim", async () => {
    const { stdout } = await runBootstrap(["--role", "agent", "/tmp/mullion-home"]);

    expect(fs.existsSync(argsFile)).toBe(true);
    const forwarded = fs
      .readFileSync(argsFile, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(forwarded).toEqual(["--role", "agent", "/tmp/mullion-home"]);

    // It reports what it resolved, so an operator can see which release they
    // got and where it is going before the installer starts.
    expect(stdout).toContain(TAG);
    expect(stdout).toContain("/tmp/mullion-home");
  });

  it("propagates the installer's exit status", async () => {
    const failure = await failureOf(
      runBootstrap(["/tmp/mullion-home"], { MULLION_TEST_INSTALLER_EXIT: "3" }),
    );

    expect(failure.code).toBe(3);
    expect(failure.stderr).toContain("exited with status 3");
  });

  it("fails closed on a checksum mismatch, installing nothing", async () => {
    writeChecksum("0".repeat(64));

    const failure = await failureOf(runBootstrap(["/tmp/mullion-home"]));

    expect(failure.code).not.toBe(0);
    expect(failure.stderr).toContain("checksum verification FAILED");
    // Nothing was extracted, so the installer never ran.
    expect(fs.existsSync(argsFile)).toBe(false);
  });

  it("refuses a release that carries no installer", async () => {
    fs.rmSync(path.join(fixtureDir, "deploy", "install.sh"));
    execFileSync("tar", ["-czf", tarballPath, "-C", fixtureDir, "."]);
    writeChecksum(sha256Of(tarballPath));

    const failure = await failureOf(runBootstrap(["/tmp/mullion-home"]));

    expect(failure.code).not.toBe(0);
    expect(failure.stderr).toContain("does not contain deploy/install.sh");
    expect(fs.existsSync(argsFile)).toBe(false);
  });

  it("refuses when the latest release cannot be resolved", async () => {
    const failure = await failureOf(
      runBootstrap(["/tmp/mullion-home"], {
        MULLION_TEST_LATEST_URL: "https://github.com/s3ntin3l8/mullion-session-manager/releases",
      }),
    );

    expect(failure.code).not.toBe(0);
    expect(failure.stderr).toContain("could not resolve the latest release");
    expect(fs.existsSync(argsFile)).toBe(false);
  });

  it("removes its temp directory on every exit path", async () => {
    await runBootstrap(["/tmp/mullion-home"]);
    expect(fs.readdirSync(scratchDir)).toEqual([]);

    // ...and on the failure path too.
    writeChecksum("0".repeat(64));
    await failureOf(runBootstrap(["/tmp/mullion-home"]));
    expect(fs.readdirSync(scratchDir)).toEqual([]);
  });

  it("prints usage for --help and installs nothing", async () => {
    const { stdout } = await runBootstrap(["--help"]);

    expect(stdout).toContain("usage: mullion-install.sh");
    expect(fs.existsSync(argsFile)).toBe(false);
  });

  it("refuses a missing install root before any network call", async () => {
    // `--role` consumes the next argument as its value, so this leaves no
    // install root behind. install.sh would reject it too — but only after
    // this script resolved a release and pulled ~9 MB, so the diagnosis
    // belongs here.
    const failure = await failureOf(runBootstrap(["--role", "/tmp/mullion-home"]));

    expect(failure.code).not.toBe(0);
    expect(failure.stderr).toContain("no install root given");
    expect(failure.stdout).toContain("usage: mullion-install.sh");
    expect(fs.existsSync(argsFile)).toBe(false);
  });
});
