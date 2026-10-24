// Issue #1801 — scripts/macos-launchd-check.sh is the only way the macOS
// launchd deployment can be checked without a full install, so two things
// about it are worth guarding in CI (which runs Linux, where the script
// itself refuses to run):
//
//   1. it must refuse cleanly on a non-macOS host, with a clear message
//      rather than a confusing failure — that is what the Linux CI run of
//      this file exercises;
//   2. its HEADER's numbered list and its BODY's sections must not drift
//      apart. The drift was real: the header promised "the installer
//      refuses a role switch (one role per install root)" while the body
//      had no such check, so a checklist item (#1794's) was silently
//      uncovered. The body also drifted the other way — the platform-branch
//      check the header listed was a SKIP in the body.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const SCRIPT = fileURLToPath(new URL("../../scripts/macos-launchd-check.sh", import.meta.url));
const SOURCE = fs.readFileSync(SCRIPT, "utf8");

describe("scripts/macos-launchd-check.sh", () => {
  it("refuses to run on a non-macOS host, with a clear message", async () => {
    // The Linux CI runner is exactly this case: the script needs launchd.
    let failed = false;
    let output = "";
    try {
      await execFileAsync("bash", [SCRIPT], { timeout: 20_000 });
    } catch (err) {
      failed = true;
      const e = err as { code?: number; stdout?: string; stderr?: string };
      output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
      expect(e.code).toBe(2);
    }
    // On a macOS host the script runs for real, so this assertion only holds
    // where the script refused — which is what CI does.
    if (failed) {
      expect(output).toContain("this check only makes sense on macOS");
    } else {
      expect(process.platform).toBe("darwin");
    }
  });

  it("lists the same numbered sections in its header and its body", () => {
    // The header's list: `#   1. …`, `#   2. …`, … (continuation lines do
    // not match, so each entry is counted once).
    const headerNumbers = [...SOURCE.matchAll(/^#\s+(\d+)\.\s/gm)].map((m) => Number(m[1]));
    // The body's sections: `echo "=== 1. … ==="`.
    const bodyNumbers = [...SOURCE.matchAll(/^echo "=== (\d+)\./gm)].map((m) => Number(m[1]));

    expect(headerNumbers.length).toBeGreaterThan(0);
    expect(bodyNumbers.length).toBeGreaterThan(0);
    // Same sections, same order — a header that promises a check the body
    // does not perform (or the other way round) is the drift this guards.
    expect(headerNumbers).toEqual(bodyNumbers);
  });

  it("never writes through a symlink when it creates the uname shim", () => {
    // The earlier version symlinked /usr/bin/uname into the sandbox and then
    // wrote the shim THROUGH that symlink, which macOS refuses (SIP) — so
    // the shim never existed and the check ran against the real platform.
    // The shim must be created as a real file.
    const writes = SOURCE.match(/cat >"\$SBX_BIN\/uname"/g) ?? [];
    expect(writes.length).toBe(1);
    // …and the symlink it would have written through must be removed first.
    expect(SOURCE).toMatch(/rm -f "\$SBX_BIN\/uname"/);
  });

  it("sandbox the installer: a temp HOME and a PATH without /bin", () => {
    // PATH="$SBX_BIN" alone is what makes launchctl (which lives in /bin)
    // genuinely unreachable — a PATH that still contained the real /bin
    // could never prove the refusal.
    expect(SOURCE).toMatch(/PATH="\$SBX_BIN" HOME="\$SBX_HOME"/);
    // …and the HOME must be the sandbox's, never the real one.
    expect(SOURCE).not.toMatch(/PATH="\$SBX_BIN:\$PATH"/);
  });
});
