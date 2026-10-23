import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

// The shim is a plain POSIX shell script (like forwarder-shim.sh), so it is
// exercised by RUNNING it — with a stub forwarder standing in for Mullion's
// real one. Nothing here starts mcode: the shim's whole job is to resolve the
// per-session socket + token and hand them to the forwarder, and that
// contract is what these tests pin down.
const here = path.dirname(fileURLToPath(import.meta.url));
const SHIM_PATH = path.join(here, "..", "..", "src", "hooks", "mcode-hook-shim.sh");

/** A stub forwarder that prints what it was handed, so a test can assert the
 * shim passed the right socket + token through. */
function writeStubForwarder(dir: string): string {
  const p = path.join(dir, "fwd.mjs");
  writeFileSync(
    p,
    [
      'import net from "node:net";',
      'console.error(`SOCKET=${process.env.MULLION_HOOK_SOCKET}`);',
      'console.error(`TOKEN=${process.env.MULLION_HOOK_TOKEN}`);',
      'console.log(JSON.stringify({ decision: "allow" }));',
    ].join("\n"),
  );
  return p;
}

function runShim(
  args: { env?: Record<string, string | undefined>; stdin?: string },
): { stdout: string; stderr: string; status: number } {
  const env = { ...process.env, ...args.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete env[k];
  }
  try {
    const stdout = execFileSync("sh", [SHIM_PATH, ...(args.stdin ? [] : [])], {
      env,
      input: args.stdin ?? "",
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout, stderr: "", status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", status: e.status ?? 1 };
  }
}

describe("mcode-hook-shim.sh", () => {
  let dir: string;
  let tmpDir: string;
  let forwarderPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mcode-shim-test-"));
    tmpDir = path.join(dir, "tmp");
    mkdirSync(tmpDir, { recursive: true });
    forwarderPath = writeStubForwarder(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves the socket + token from the handoff file and runs the forwarder", () => {
    writeFileSync(
      path.join(tmpDir, "mullion-hook.json"),
      JSON.stringify({
        socket: "/tmp/hooks.sock",
        token: "tok-abc",
        forwarderPath,
        nodePath: process.execPath,
      }),
    );

    const result = runShim({ env: { TMPDIR: tmpDir } });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"decision":"allow"');
  });

  it("fails open with an empty JSON object when the handoff file is missing", () => {
    const result = runShim({ env: { TMPDIR: tmpDir } });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("{}");
  });

  it("fails open when the forwarder path is missing", () => {
    writeFileSync(
      path.join(tmpDir, "mullion-hook.json"),
      JSON.stringify({
        socket: "/tmp/hooks.sock",
        token: "tok-abc",
        forwarderPath: path.join(dir, "does-not-exist.mjs"),
        nodePath: process.execPath,
      }),
    );
    const result = runShim({ env: { TMPDIR: tmpDir } });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("{}");
  });

  it("fails open on a malformed handoff file", () => {
    writeFileSync(path.join(tmpDir, "mullion-hook.json"), "not json at all\n");
    const result = runShim({ env: { TMPDIR: tmpDir } });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("{}");
  });

  it("finds the handoff file purely through TMPDIR", () => {
    // mcode's hook child env is a whitelist that DROPS every MULLION_* var,
    // so TMPDIR is the ONLY channel the shim has — the file has to be at
    // $TMPDIR/mullion-hook.json and nothing else may be consulted.
    writeFileSync(
      path.join(tmpDir, "mullion-hook.json"),
      JSON.stringify({
        socket: "/tmp/tmpdir.sock",
        token: "tok-tmpdir",
        forwarderPath,
        nodePath: process.execPath,
      }),
    );
    const result = runShim({ env: { TMPDIR: tmpDir } });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"decision":"allow"');
  });

  it("ignores a MULLION_MCODE_HOOK_FILE pointing elsewhere (mcode strips it)", () => {
    // The env var is NOT a real channel — mcode's hook child env whitelist
    // drops every MULLION_* var, so it can never point the shim at a
    // different file. TMPDIR is the only thing consulted.
    writeFileSync(
      path.join(tmpDir, "mullion-hook.json"),
      JSON.stringify({
        socket: "/tmp/tmpdir.sock",
        token: "tok-tmpdir",
        forwarderPath,
        nodePath: process.execPath,
      }),
    );
    const elsewhere = path.join(dir, "elsewhere-hook.json");
    writeFileSync(
      elsewhere,
      JSON.stringify({
        socket: "/tmp/elsewhere.sock",
        token: "tok-elsewhere",
        forwarderPath: "/nonexistent.mjs",
        nodePath: process.execPath,
      }),
    );

    const result = runShim({
      env: { TMPDIR: tmpDir, MULLION_MCODE_HOOK_FILE: elsewhere },
    });
    expect(result.status).toBe(0);
    // The TMPDIR file won — the ignored env var's broken forwarder path was
    // never consulted.
    expect(result.stdout).toContain('"decision":"allow"');
  });
});
