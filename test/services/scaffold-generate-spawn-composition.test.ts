import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as ChildProcessModule from "node:child_process";
import type { ChildProcess } from "node:child_process";

// Issue #1081 review — a mullion-reviewer pass found that
// defaultSpawnGenerationTurn's own sandbox/no-sandbox composition (the
// `isSandboxCapable()` -> `agentSandboxWritablePaths()` ->
// `ensureSandboxWritablePathsExist()` -> `wrapWithSandbox()` -> `execFile`
// chain in scaffold-generate.ts) had zero direct coverage: every existing
// test in scaffold-generate.test.ts either injects `opts.spawn` (bypassing
// defaultSpawnGenerationTurn entirely) or exercises wrapWithSandbox/
// isSandboxCapable in isolation as pure functions. Deleting the `if
// (sandboxUsable) { ... }` branch in defaultSpawnGenerationTurn and
// reverting to a bare unwrapped execFile call would leave every existing
// test green.
//
// This file closes that gap by mocking node:child_process's execFile (the
// same pattern test/routes/projects-dev-server-detect.test.ts and others
// already use in this repo) and calling the REAL, unmocked
// defaultSpawnGenerationTurn/isSandboxCapable/wrapWithSandbox — asserting
// on what actually reaches the mocked execFile, rather than re-testing any
// of those functions' own internals a second time. Deliberately a SEPARATE
// file from scaffold-generate.test.ts: mocking execFile at module scope
// here would otherwise break that file's live bwrap tests, which need a
// real subprocess.
const execFileMock = vi.fn(
  (
    file: string,
    args: readonly string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    // The capability probe's own invocation (buildBwrapSmokeTestInvocation)
    // always ends in `-- /bin/true` — distinguish it from the "main"
    // generation-turn invocation this suite is actually asserting on.
    const isSmokeProbe = args[args.length - 1] === "/bin/true";
    if (isSmokeProbe) {
      if (smokeProbeSucceeds) callback(null, "", "");
      else callback(new Error("bwrap: command not found"), "", "");
      return {} as ChildProcess;
    }
    callback(null, "generated output", "");
    return {} as ChildProcess;
  },
);

let smokeProbeSucceeds = true;

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>();
  return { ...actual, execFile: execFileMock };
});

// Imported AFTER the mock is declared (vi.mock is hoisted by vitest to the
// top of the file regardless of declaration order, so this is safe, but
// kept below for readability).
const { defaultSpawnGenerationTurn, resetSandboxCapabilityCache } =
  await import("../../src/services/scaffold-generate.js");

describe("defaultSpawnGenerationTurn — sandbox composition (issue #1081 coverage gap)", () => {
  let scratchDir: string;

  beforeEach(() => {
    resetSandboxCapabilityCache();
    execFileMock.mockClear();
    smokeProbeSucceeds = true;
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-spawn-composition-test-"));
  });

  afterEach(() => {
    resetSandboxCapabilityCache();
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it("wraps the real invocation in bwrap when the capability probe reports usable", async () => {
    smokeProbeSucceeds = true;

    const result = await defaultSpawnGenerationTurn({
      agentCommand: "claude",
      cwd: scratchDir,
      prompt: "generate scaffold content",
      timeoutMs: 5000,
    });

    expect(result).toBe("generated output");
    // First call is the capability probe (bwrap ... -- /bin/true); the
    // second is the actual generation-turn invocation, and it must be the
    // ONE that reflects defaultSpawnGenerationTurn's own wrap decision —
    // this is the exact composition the review found untested.
    expect(execFileMock).toHaveBeenCalledTimes(2);
    const [mainBin, mainArgs] = execFileMock.mock.calls[1];
    expect(mainBin).toBe("bwrap");
    expect(mainArgs).toContain("--die-with-parent");
    expect(mainArgs).toContain(scratchDir);
    // The real agent binary/prompt must still be present, appended after
    // bwrap's own flags and the `--` separator.
    expect(mainArgs).toContain("claude");
    expect(mainArgs).toContain("generate scaffold content");
  });

  it("falls back to the unwrapped invocation when the capability probe reports unusable", async () => {
    smokeProbeSucceeds = false;

    const result = await defaultSpawnGenerationTurn({
      agentCommand: "claude",
      cwd: scratchDir,
      prompt: "generate scaffold content",
      timeoutMs: 5000,
    });

    expect(result).toBe("generated output");
    expect(execFileMock).toHaveBeenCalledTimes(2);
    const [mainBin, mainArgs] = execFileMock.mock.calls[1];
    // Must be the RAW claude invocation, not bwrap-wrapped — this is the
    // branch that would silently vanish if the `if (sandboxUsable)` guard
    // in defaultSpawnGenerationTurn were ever deleted or inverted.
    expect(mainBin).toBe("claude");
    expect(mainArgs).not.toContain("bwrap");
    expect(mainArgs).not.toContain("--die-with-parent");
  });

  it("caches the capability probe across two calls — the second spawn does not re-probe", async () => {
    smokeProbeSucceeds = true;

    await defaultSpawnGenerationTurn({
      agentCommand: "claude",
      cwd: scratchDir,
      prompt: "first turn",
      timeoutMs: 5000,
    });
    execFileMock.mockClear();

    await defaultSpawnGenerationTurn({
      agentCommand: "claude",
      cwd: scratchDir,
      prompt: "second turn",
      timeoutMs: 5000,
    });

    // Only ONE call this time (the main invocation) — no repeated smoke
    // probe, confirming the process-lifetime cache genuinely prevents a
    // second real subprocess spawn per generation turn.
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0][0]).toBe("bwrap");
  });
});
