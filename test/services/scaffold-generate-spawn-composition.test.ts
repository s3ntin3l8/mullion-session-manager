import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
const {
  buildInvocation,
  defaultSpawnGenerationTurn,
  resetSandboxCapabilityCache,
  scaffoldGenerateBaseDir,
} = await import("../../src/services/scaffold-generate.js");

describe("defaultSpawnGenerationTurn — sandbox composition (issue #1081 coverage gap)", () => {
  let scratchDir: string;

  beforeEach(() => {
    resetSandboxCapabilityCache();
    execFileMock.mockClear();
    smokeProbeSucceeds = true;
    // Under scaffoldGenerateBaseDir(): defaultSpawnGenerationTurn refuses
    // any cwd outside it (CodeQL #303 containment).
    fs.mkdirSync(scaffoldGenerateBaseDir(), { recursive: true });
    scratchDir = fs.mkdtempSync(path.join(scaffoldGenerateBaseDir(), "spawn-composition-test-"));
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

  // Issue #2430 — an open, silent stdin pipe makes `claude -p` wait 3 s and
  // print a "no stdin data received" warning on every turn.
  it("closes the child's stdin so the agent never waits for input", async () => {
    const end = vi.fn();
    execFileMock.mockImplementationOnce((_f, _a, _o, cb) => {
      cb(null, "", ""); // the capability probe
      return {} as ChildProcess;
    });
    execFileMock.mockImplementationOnce((_f, _a, _o, cb) => {
      cb(null, "generated output", "");
      return { stdin: { end } } as unknown as ChildProcess;
    });
    await defaultSpawnGenerationTurn({
      agentCommand: "claude",
      cwd: scratchDir,
      prompt: "p",
      timeoutMs: 5000,
    });
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("reports the exit code and the stdout tail of a failed turn, not just the stderr warning", async () => {
    execFileMock.mockImplementationOnce((_f, _a, _o, cb) => {
      cb(null, "", "");
      return {} as ChildProcess;
    });
    execFileMock.mockImplementationOnce((_f, _a, _o, cb) => {
      const err = Object.assign(new Error("Command failed: bwrap …"), { code: 1 });
      cb(
        err,
        "Not logged in · Please run /login\n",
        "Warning: no stdin data received in 3s, proceeding without it.\n",
      );
      return {} as ChildProcess;
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      defaultSpawnGenerationTurn({
        agentCommand: "claude",
        cwd: scratchDir,
        prompt: "p",
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/exit code 1.*Not logged in/s);
  });

  // CodeQL js/log-injection: agent output reaches the log, so it is flattened.
  it("logs a failed turn on one line even when the agent's output has line breaks", async () => {
    execFileMock.mockImplementationOnce((_f, _a, _o, cb) => {
      cb(null, "", "");
      return {} as ChildProcess;
    });
    execFileMock.mockImplementationOnce((_f, _a, _o, cb) => {
      cb(
        Object.assign(new Error("x"), { code: 1 }),
        "line one\nFAKE LOG ENTRY\r\nmore",
        "err\nline",
      );
      return {} as ChildProcess;
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      defaultSpawnGenerationTurn({
        agentCommand: "claude",
        cwd: scratchDir,
        prompt: "p",
        timeoutMs: 5000,
      }),
    ).rejects.toThrow();
    const logged = warn.mock.calls.find((c) => String(c[0]).includes("generation turn failed"));
    expect(logged).toBeDefined();
    for (const arg of logged!) expect(String(arg)).not.toMatch(/[\r\n]/);
  });

  // Issue #2472 — codex's own bwrap sandbox cannot start inside Mullion's.
  describe("codex inside and outside Mullion's sandbox (issue #2472)", () => {
    const mockTurn = (out: string, errOut: string) => {
      execFileMock.mockImplementationOnce((_f, _a, _o, cb) => {
        cb(null, "", "");
        return {} as ChildProcess;
      });
      execFileMock.mockImplementationOnce((_f, _a, _o, cb) => {
        cb(null, out, errOut);
        return {} as ChildProcess;
      });
    };
    const runCodex = () =>
      defaultSpawnGenerationTurn({
        agentCommand: "codex",
        cwd: scratchDir,
        prompt: "p",
        timeoutMs: 5000,
      });

    it("pins the codex argv for the sandboxed and unsandboxed cases", () => {
      expect(buildInvocation("codex", "p")).toEqual({
        bin: "codex",
        args: ["exec", "--sandbox", "read-only", "--", "p"],
      });
      expect(buildInvocation("codex", "p", { sandboxed: true })).toEqual({
        bin: "codex",
        args: ["exec", "--sandbox", "danger-full-access", "--", "p"],
      });
      expect(buildInvocation("claude", "p", { sandboxed: true })).toEqual(
        buildInvocation("claude", "p"),
      );
    });

    it("drops codex's own sandbox when wrapped in bwrap, keeps it when not", async () => {
      await defaultSpawnGenerationTurn({
        agentCommand: "codex",
        cwd: scratchDir,
        prompt: "p",
        timeoutMs: 5000,
      });
      expect(execFileMock.mock.calls[1][1]).toEqual(expect.arrayContaining(["danger-full-access"]));

      resetSandboxCapabilityCache();
      execFileMock.mockClear();
      await defaultSpawnGenerationTurn({
        agentCommand: "codex",
        cwd: scratchDir,
        prompt: "p",
        timeoutMs: 5000,
        sandbox: false,
      });
      const [bin, args] = execFileMock.mock.calls[0];
      expect(bin).toBe("codex");
      expect(args).toEqual(["exec", "--sandbox", "read-only", "--", "p"]);
    });

    it.each([
      "tool failed: error building bubblewrap command: Read-only file system",
      "filesystem-restricted execution requires bubblewrap to isolate sockets",
    ])("rejects an exit-0 codex turn whose tools could not start: %s", async (errOut) => {
      mockTurn("", errOut);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await expect(runCodex()).rejects.toThrow(/could not read the repository/);
      expect(warn).toHaveBeenCalledWith(expect.any(String), "codex");
    });

    it("keeps an answer that merely quotes the error on stdout", async () => {
      mockTurn("the skill says: error building bubblewrap command", "");
      await expect(runCodex()).resolves.toContain("error building bubblewrap command");
    });

    it("uses read-only when bwrap was requested but the probe says unusable", async () => {
      smokeProbeSucceeds = false;
      await runCodex();
      expect(execFileMock.mock.calls[1][0]).toBe("codex");
      expect(execFileMock.mock.calls[1][1]).toEqual(["exec", "--sandbox", "read-only", "--", "p"]);
    });
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

  // Issue #1131 — the call-site contract: defaultSpawnGenerationTurn must
  // spread both dirs and files from agentSandboxWritablePaths into the
  // flat string[] that wrapWithSandbox receives, producing --bind-try
  // entries for every listed path. With the fake HOME fix, paths are
  // relative to a disposable HOME inside the scratch worktree, not the
  // operator's real HOME.
  it("spreads both dirs and files into the bwrap arg list (issue #1131)", async () => {
    smokeProbeSucceeds = true;

    await defaultSpawnGenerationTurn({
      agentCommand: "codex",
      cwd: scratchDir,
      prompt: "test narrowed binds",
      timeoutMs: 5000,
    });

    expect(execFileMock).toHaveBeenCalledTimes(2);
    const [mainBin, mainArgs] = execFileMock.mock.calls[1];
    expect(mainBin).toBe("bwrap");

    // The fake HOME is <scratchDir>/.agent-home — defaultSpawnGenerationTurn
    // creates it, seeds it, and passes it to wrapWithSandbox which adds
    // --bind <fakeHome> <fakeHome> and --setenv HOME <fakeHome>.
    const fakeHome = path.join(scratchDir, ".agent-home");
    expect(mainArgs).toContain(fakeHome);
    expect(mainArgs).toContain("--setenv");
    const homeIdx = mainArgs.indexOf("HOME");
    expect(mainArgs[homeIdx + 1]).toBe(fakeHome);

    // Every path from agentSandboxWritablePaths("codex", fakeHome) must
    // appear as a --bind-try source in the bwrap args.
    const { agentSandboxWritablePaths } = await import("../../src/services/scaffold-generate.js");
    const { dirs, files } = agentSandboxWritablePaths("codex", fakeHome);
    const allPaths = [...dirs, ...files];
    const bindTrySources = mainArgs.filter((_, i) => mainArgs[i - 1] === "--bind-try");
    for (const p of allPaths) {
      expect(bindTrySources).toContain(p);
    }
  });
});
