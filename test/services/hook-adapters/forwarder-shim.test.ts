import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  unlinkSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveForwarderShimPath,
  ensureForwarderShim,
  forwarderHookCommand,
  forwarderFallbackJson,
  __testing,
} from "../../../src/services/hook-adapters/forwarder-shim.js";

const REAL_SHIM_SOURCE = fileURLToPath(
  new URL("../../../src/hooks/forwarder-shim.sh", import.meta.url),
);
const REAL_FORWARDER = fileURLToPath(new URL("../../../src/hooks/forwarder.mjs", import.meta.url));

// Issue: host-global agy/Codex hook configs (~/.gemini/config/hooks.json,
// ~/.codex/hooks.json) are shared by every Mullion instance on the host —
// see forwarder-shim.ts's own header for the full incident this fixes. This
// suite is the direct regression coverage: a stable, homedir-anchored shim
// path (never MULLION_HOME/checkout-dependent), and a shim that fails open
// — correct JSON, exit 0 — for every way its real forwarder can go missing.
describe("resolveForwarderShimPath (host-stable location)", () => {
  const originalHome = process.env.HOME;
  const originalMullionHome = process.env.MULLION_HOME;
  const originalXdgConfig = process.env.XDG_CONFIG_HOME;
  const originalXdgState = process.env.XDG_STATE_HOME;

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalMullionHome === undefined) delete process.env.MULLION_HOME;
    else process.env.MULLION_HOME = originalMullionHome;
    if (originalXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdgConfig;
    if (originalXdgState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = originalXdgState;
  });

  it("is anchored under the user's home directory", () => {
    process.env.HOME = "/home/alice";
    expect(resolveForwarderShimPath()).toBe(
      path.join("/home/alice", ".mullion", "hooks", "mullion-forwarder-shim.sh"),
    );
  });

  it("does NOT change when MULLION_HOME is set — the direct anti-regression for this bug: a dev worktree and the production install must resolve to the SAME shim path", () => {
    process.env.HOME = "/home/alice";
    const withoutMullionHome = resolveForwarderShimPath();

    process.env.MULLION_HOME = "/home/alice/opt/mullion";
    const withMullionHome = resolveForwarderShimPath();

    expect(withMullionHome).toBe(withoutMullionHome);
  });

  it("does NOT honor XDG_CONFIG_HOME/XDG_STATE_HOME — those routinely differ between an interactive dev shell and the systemd --user unit running production, which would defeat the one property this design depends on", () => {
    process.env.HOME = "/home/alice";
    const withoutXdg = resolveForwarderShimPath();

    process.env.XDG_CONFIG_HOME = "/home/alice/.config";
    process.env.XDG_STATE_HOME = "/home/alice/.local/state";
    const withXdg = resolveForwarderShimPath();

    expect(withXdg).toBe(withoutXdg);
  });
});

describe("ensureForwarderShim (install/update)", () => {
  let targetDir: string;
  let targetPath: string;

  beforeEach(() => {
    targetDir = mkdtempSync(path.join(os.tmpdir(), "mullion-shim-install-"));
    targetPath = path.join(targetDir, "nested", "mullion-forwarder-shim.sh");
  });

  afterEach(() => {
    rmSync(targetDir, { recursive: true, force: true });
  });

  it("creates the file with mode 0o755 and content identical to the packaged source", () => {
    const installed = ensureForwarderShim(REAL_SHIM_SOURCE, targetPath);
    expect(installed).toBe(targetPath);
    expect(readFileSync(targetPath, "utf8")).toBe(readFileSync(REAL_SHIM_SOURCE, "utf8"));
    // & 0o777 masks off the file-type bits stat's mode also carries.
    expect(statSync(targetPath).mode & 0o777).toBe(0o755);
  });

  it("is idempotent — a second call with identical content leaves the file untouched and doesn't throw", () => {
    ensureForwarderShim(REAL_SHIM_SOURCE, targetPath);
    const firstContent = readFileSync(targetPath, "utf8");

    expect(() => ensureForwarderShim(REAL_SHIM_SOURCE, targetPath)).not.toThrow();
    expect(readFileSync(targetPath, "utf8")).toBe(firstContent);
  });

  it("never downgrades — an on-disk shim with a NEWER version header is left untouched", () => {
    mkdirSync(path.dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, "#!/bin/sh\n# mullion-forwarder-shim v999\necho newer\n", {
      mode: 0o755,
    });

    ensureForwarderShim(REAL_SHIM_SOURCE, targetPath);

    expect(readFileSync(targetPath, "utf8")).toBe(
      "#!/bin/sh\n# mullion-forwarder-shim v999\necho newer\n",
    );
  });

  it("overwrites an on-disk shim with an OLDER or unversioned header", () => {
    mkdirSync(path.dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, "#!/bin/sh\necho garbage-from-before-versioning\n", { mode: 0o755 });

    ensureForwarderShim(REAL_SHIM_SOURCE, targetPath);

    expect(readFileSync(targetPath, "utf8")).toBe(readFileSync(REAL_SHIM_SOURCE, "utf8"));
  });

  it("parseShimVersion extracts the version header, or null when absent/malformed", () => {
    expect(__testing.parseShimVersion("#!/bin/sh\n# mullion-forwarder-shim v1\n")).toBe(1);
    expect(__testing.parseShimVersion("#!/bin/sh\n# mullion-forwarder-shim v42\n")).toBe(42);
    expect(__testing.parseShimVersion("#!/bin/sh\necho hi\n")).toBeNull();
  });
});

describe("forwarderFallbackJson", () => {
  it("is an explicit allow for agy PreToolUse — an empty/ambiguous decision may read as a denial (commit 8619182)", () => {
    expect(forwarderFallbackJson("agy", "PreToolUse")).toBe('{"decision":"allow"}');
  });

  it("is a bare {} for every other agent+kind, including agy's own other events", () => {
    expect(forwarderFallbackJson("agy", "Stop")).toBe("{}");
    expect(forwarderFallbackJson("agy", "PostToolUse")).toBe("{}");
    expect(forwarderFallbackJson("agy", "SessionStart")).toBe("{}");
    expect(forwarderFallbackJson("codex", "PermissionRequest")).toBe("{}");
    expect(forwarderFallbackJson("codex", "Stop")).toBe("{}");
  });
});

// Behavioral tests: the shim ACTUALLY EXECUTED under `sh`, not just its
// generated command string inspected — this is the layer that must hold at
// runtime, on the host, for a real agy/Codex hook invocation.
describe("forwarder-shim.sh — real sh execution, fail-open behavior", () => {
  let scratchDir: string;

  beforeEach(() => {
    scratchDir = mkdtempSync(path.join(os.tmpdir(), "mullion-shim-exec-"));
  });

  afterEach(() => {
    rmSync(scratchDir, { recursive: true, force: true });
  });

  function runShim(args: string[], env: Record<string, string | undefined>): string {
    return execFileSync("sh", [REAL_SHIM_SOURCE, ...args], {
      input: "",
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
  }

  it("MULLION_FORWARDER_PATH unset — fails open with the explicit allow for agy PreToolUse", () => {
    const out = runShim(["agy", "PreToolUse"], { MULLION_FORWARDER_PATH: undefined });
    expect(out).toBe('{"decision":"allow"}\n');
  });

  it("MULLION_FORWARDER_PATH unset — fails open with {} for every other kind", () => {
    expect(runShim(["agy", "Stop"], { MULLION_FORWARDER_PATH: undefined })).toBe("{}\n");
    expect(runShim(["codex", "Stop"], { MULLION_FORWARDER_PATH: undefined })).toBe("{}\n");
  });

  it("MULLION_FORWARDER_PATH points at a nonexistent file (the exact reported incident: a removed .wt/<slug> worktree) — fails open, never a module-not-found crash", () => {
    const out = runShim(["agy", "PreToolUse"], {
      MULLION_FORWARDER_PATH: path.join(scratchDir, "does-not-exist", "forwarder.mjs"),
    });
    expect(out).toBe('{"decision":"allow"}\n');
  });

  it("MULLION_FORWARDER_NODE points at a nonexistent binary and PATH has no node — fails open", () => {
    // Use an absolute /bin/sh so Node's own subprocess resolution doesn't
    // depend on PATH — only the shim's internal `command -v` lookup should
    // be affected by the stripped-down PATH below.
    const out = execFileSync("/bin/sh", [REAL_SHIM_SOURCE, "agy", "PostToolUse"], {
      input: "",
      encoding: "utf8",
      env: {
        MULLION_FORWARDER_PATH: REAL_FORWARDER,
        MULLION_FORWARDER_NODE: path.join(scratchDir, "no-such-node"),
        PATH: scratchDir, // deliberately empty of any real `node`
      },
    });
    expect(out).toBe("{}\n");
  });

  it("happy path — the real forwarder.mjs runs and its own stdout passes through unchanged", () => {
    // No MULLION_HOOK_SOCKET/TOKEN — forwarder.mjs's own fail-open path
    // (main()'s finally) is what actually produces the output here; this
    // proves the shim doesn't mangle a real forwarder invocation.
    const out = runShim(["agy", "PreToolUse"], {
      MULLION_FORWARDER_PATH: REAL_FORWARDER,
      MULLION_FORWARDER_NODE: process.execPath,
      MULLION_HOOK_SOCKET: undefined,
      MULLION_HOOK_TOKEN: undefined,
    });
    expect(out).toBe('{"decision":"allow"}\n');
  });

  it("a forwarder that prints valid JSON and THEN exits non-zero still yields exit 0 with that JSON — the shim must never propagate a crash's exit status (would reintroduce the original hard-block bug)", () => {
    const crashingForwarder = path.join(scratchDir, "crashing-forwarder.mjs");
    writeFileSync(
      crashingForwarder,
      `console.log(JSON.stringify({decision:"allow"}));\nprocess.exitCode = 1;\n`,
    );
    const out = execFileSync(
      "sh",
      ["-c", `${REAL_SHIM_SOURCE} agy PreToolUse; printf 'exit=%s\\n' "$?"`],
      {
        input: "",
        encoding: "utf8",
        env: {
          ...process.env,
          MULLION_FORWARDER_PATH: crashingForwarder,
          MULLION_FORWARDER_NODE: process.execPath,
        },
      },
    );
    expect(out).toBe('{"decision":"allow"}\nexit=0\n');
  });

  it("a forwarder killed before it prints anything (empty stdout, exit 0) still gets the explicit agy PreToolUse fallback — an empty line would be ambiguous (commit 8619182)", () => {
    const silentForwarder = path.join(scratchDir, "silent-forwarder.mjs");
    writeFileSync(silentForwarder, `process.exit(0);\n`);
    const out = runShim(["agy", "PreToolUse"], {
      MULLION_FORWARDER_PATH: silentForwarder,
      MULLION_FORWARDER_NODE: process.execPath,
    });
    expect(out).toBe('{"decision":"allow"}\n');
  });

  it("a forwarder that prints MORE than one line (unexpected — forwarder.mjs's own finally always emits exactly one) is rejected as malformed, never printed verbatim (Hermes review, PR #861)", () => {
    const multiLineForwarder = path.join(scratchDir, "multiline-forwarder.mjs");
    writeFileSync(
      multiLineForwarder,
      `console.log(JSON.stringify({real: "content", should: "not print"}));\nconsole.log("{}");\n`,
    );
    // agy Stop, not agy PreToolUse — its fallback ({}) is visually
    // distinct from the real (rejected) first line, so a pass here proves
    // the guard actually fired rather than coincidentally matching.
    const out = runShim(["agy", "Stop"], {
      MULLION_FORWARDER_PATH: multiLineForwarder,
      MULLION_FORWARDER_NODE: process.execPath,
    });
    expect(out).toBe("{}\n");
  });

  it("stdin passes straight through to the real forwarder", () => {
    const echoStdin = path.join(scratchDir, "echo-stdin-forwarder.mjs");
    writeFileSync(
      echoStdin,
      `let data = "";\nprocess.stdin.on("data", (c) => { data += c; });\nprocess.stdin.on("end", () => { console.log(JSON.stringify({ echoed: data })); });\n`,
    );
    const out = execFileSync("sh", [REAL_SHIM_SOURCE, "codex", "Stop"], {
      input: "hello-from-stdin",
      encoding: "utf8",
      env: {
        ...process.env,
        MULLION_FORWARDER_PATH: echoStdin,
        MULLION_FORWARDER_NODE: process.execPath,
      },
    });
    expect(JSON.parse(out)).toEqual({ echoed: "hello-from-stdin" });
  });
});

// Layer 3 — the `|| printf` guard baked into the COMMAND STRING itself,
// covering the one failure mode the shim can't cover: the shim file being
// missing, not executable, or `sh` failing to exec it at all.
describe("forwarderHookCommand — layer-3 fail-open guard", () => {
  let scratchDir: string;
  let shimPath: string;

  beforeEach(() => {
    scratchDir = mkdtempSync(path.join(os.tmpdir(), "mullion-shim-guard-"));
    shimPath = path.join(scratchDir, "mullion-forwarder-shim.sh");
    writeFileSync(shimPath, readFileSync(REAL_SHIM_SOURCE, "utf8"), { mode: 0o755 });
  });

  afterEach(() => {
    rmSync(scratchDir, { recursive: true, force: true });
  });

  it("the shim missing entirely — command string's own guard fails open (agy PreToolUse)", () => {
    unlinkSync(shimPath);
    const cmd = forwarderHookCommand("agy", "PreToolUse", shimPath);
    const out = execFileSync("sh", ["-c", cmd], { input: "", encoding: "utf8" });
    expect(out).toBe('{"decision":"allow"}\n');
  });

  it("the shim present but not executable — command string's own guard fails open (codex Stop)", () => {
    chmodSync(shimPath, 0o644);
    const cmd = forwarderHookCommand("codex", "Stop", shimPath);
    const out = execFileSync("sh", ["-c", cmd], { input: "", encoding: "utf8" });
    expect(out).toBe("{}\n");
  });

  it("exit status is always 0 through the full guarded command, even when the shim is missing", () => {
    unlinkSync(shimPath);
    const cmd = forwarderHookCommand("agy", "Stop", shimPath);
    const out = execFileSync("sh", ["-c", `${cmd}; printf 'exit=%s\\n' "$?"`], {
      input: "",
      encoding: "utf8",
    });
    expect(out).toBe("{}\nexit=0\n");
  });
});

// Drift guard: forwarder.mjs's own main() fallback (forwarder.mjs:107-123)
// and the shim's `_mullion_fallback()` must produce byte-identical output
// for the same argv — nothing enforces that at compile time, so this test
// is the only thing that would catch the two silently diverging in a
// future edit to either file.
describe("forwarder.mjs vs. shim fallback — drift guard", () => {
  function runRealForwarderFallback(agent: string, kind: string): string {
    return execFileSync(process.execPath, [REAL_FORWARDER, agent, kind], {
      input: "{}",
      encoding: "utf8",
      env: { ...process.env, MULLION_HOOK_SOCKET: undefined, MULLION_HOOK_TOKEN: undefined },
    });
  }

  function runShimFallback(agent: string, kind: string): string {
    return execFileSync("sh", [REAL_SHIM_SOURCE, agent, kind], {
      input: "",
      encoding: "utf8",
      env: { ...process.env, MULLION_FORWARDER_PATH: undefined },
    });
  }

  it("agy PreToolUse", () => {
    expect(runShimFallback("agy", "PreToolUse")).toBe(
      runRealForwarderFallback("agy", "PreToolUse"),
    );
  });

  it("agy Stop", () => {
    expect(runShimFallback("agy", "Stop")).toBe(runRealForwarderFallback("agy", "Stop"));
  });

  it("codex Stop", () => {
    expect(runShimFallback("codex", "Stop")).toBe(runRealForwarderFallback("codex", "Stop"));
  });

  it("codex PermissionRequest — the one Codex kind where the fallback is a real decision (issue #264's blocking gate), not just an observation", () => {
    expect(runShimFallback("codex", "PermissionRequest")).toBe(
      runRealForwarderFallback("codex", "PermissionRequest"),
    );
  });
});
