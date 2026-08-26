// PR 32 (Wave 6) — unit tests for buildLaunchPlan(), extracted from
// Session.bootstrapMaster() in pty-manager.ts. Unlike
// test/services/pty-manager.test.ts's own integration-style coverage of the
// master bootstrap (real Session, mocked node:child_process, assertions on
// the eventual `systemd-run` call), these tests call buildLaunchPlan()
// directly with a plain input object — no node-pty, no node:child_process,
// no real Session instance — which is the whole point of this extraction:
// making this path unit-testable for the first time.
//
// ./session-env.js and ./shell-integration.js are left UNMOCKED — both are
// pure/cheap (shell-integration's zsh branch does a few tiny tmpdir writes,
// mirrored on test/services/shell-integration.test.ts's own convention) and
// using the real implementations gives genuine coverage of "buildLaunchPlan
// doesn't defeat or reorder the env scrub" rather than just asserting it
// calls a mock. ./agent-guide.js and ./hook-adapters/index.js ARE mocked:
// both already have their own dedicated test suites (agent-guide.test.ts,
// hook-adapters/index.test.ts), so here we only need to verify buildLaunchPlan
// wires them correctly — right args, right order, right propagation of their
// results into the final plan — not re-derive their own internal behavior.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HookAdapterContext } from "../../src/services/hook-adapters/types.js";

const callOrder: string[] = [];

const mockWriteSessionAgentGuide = vi.fn((..._args: unknown[]) => {
  callOrder.push("writeSessionAgentGuide");
});
vi.mock("../../src/services/agent-guide.js", () => ({
  writeSessionAgentGuide: (...args: unknown[]) => mockWriteSessionAgentGuide(...args),
}));

const mockWriteSessionBriefing = vi.fn((..._args: unknown[]) => {
  callOrder.push("writeSessionBriefing");
});
vi.mock("../../src/services/project-briefing.js", () => ({
  writeSessionBriefing: (...args: unknown[]) => mockWriteSessionBriefing(...args),
}));

const mockApplyHookAdapters = vi.fn((command: string, _ctx: HookAdapterContext) => {
  callOrder.push("applyHookAdapters");
  return { command, envAdditions: {}, matched: false, emits: [] };
});
const mockGetAdapterInitialPromptArgs = vi.fn((_command: string, _prompt: string) => null);
const mockResolveForwarderPath = vi.fn(() => "/fake/forwarder.mjs");
vi.mock("../../src/services/hook-adapters/index.js", () => ({
  applyHookAdapters: (...args: [string, HookAdapterContext]) => mockApplyHookAdapters(...args),
  getAdapterInitialPromptArgs: (...args: [string, string]) =>
    mockGetAdapterInitialPromptArgs(...args),
  resolveForwarderPath: () => mockResolveForwarderPath(),
}));

const { buildLaunchPlan } = await import("../../src/services/launch-plan.js");
const { scopeUnitName } = await import("../../src/services/session-process.js");
const { SERVER_ENV_KEYS } = await import("../../src/services/session-env.js");

const tmpDirs: string[] = [];
function mkTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function baseSession(overrides: Partial<Parameters<typeof buildLaunchPlan>[0]> = {}) {
  return {
    id: "42",
    cwd: "/tmp/project",
    command: "bash",
    socketPath: "/tmp/sessions/42.sock",
    hookToken: "test-hook-token",
    hookSocketPath: "/tmp/sessions/hooks.sock",
    controlSocketPath: "/tmp/sessions/mullion.sock",
    sessionsDir: "/tmp/sessions",
    reviewGateEnabled: false,
    sshAuthSock: "",
    injectAgentGuide: true,
    injectProjectBriefing: true,
    skipPermissions: false,
    initialPrompt: undefined,
    ...overrides,
  };
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  callOrder.length = 0;
  mockWriteSessionAgentGuide.mockClear();
  mockWriteSessionBriefing.mockClear();
  mockApplyHookAdapters.mockClear();
  mockGetAdapterInitialPromptArgs.mockClear();
  mockResolveForwarderPath.mockClear();
  mockApplyHookAdapters.mockImplementation((command: string) => {
    callOrder.push("applyHookAdapters");
    return { command, envAdditions: {}, matched: false, emits: [] };
  });
  mockGetAdapterInitialPromptArgs.mockImplementation(() => null);
  // Force the pure "bash" shell-integration branch by default (no tmpdir
  // I/O needed) — individual tests override SHELL when they need the zsh
  // branch specifically.
  process.env.SHELL = "/bin/bash";
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("buildLaunchPlan — env scrub", () => {
  it("strips every SERVER_ENV_KEYS entry from the launched env", () => {
    process.env.DATABASE_URL = "file:/should-not-leak.db";
    process.env.PORT = "9999";
    process.env.MULLION_AUTH_TOKEN = "super-secret";
    process.env.MULLION_SSH_AUTH_SOCK = "/leaked/outer-config-value.sock";
    // The four re-injected keys (see the skip branch below) get their own
    // OUTER leaked value here too, distinct from what baseSession() passes
    // in — proves buildLaunchPlan's own injection wins over a leaked
    // process.env value, not just that the injection happens to already
    // match what process.env had.
    process.env.MULLION_HOOK_SOCKET = "/leaked/outer-hooks.sock";
    process.env.MULLION_HOOK_TOKEN = "leaked-outer-token";
    process.env.MULLION_SOCKET_PATH = "/leaked/outer-mullion.sock";
    process.env.MULLION_SESSION_ID = "leaked-outer-id";

    const plan = buildLaunchPlan(baseSession({ id: "42" }));

    for (const key of SERVER_ENV_KEYS) {
      // MULLION_HOOK_SOCKET/MULLION_HOOK_TOKEN/MULLION_SOCKET_PATH/
      // MULLION_SESSION_ID are stripped by the scrub and then deliberately
      // RE-injected by buildLaunchPlan itself (see the five-injections
      // tests below) — so they're expected to be present again, but as
      // THIS session's own value, never the leaked outer process.env one
      // the scrub was supposed to remove.
      if (
        [
          "MULLION_HOOK_SOCKET",
          "MULLION_HOOK_TOKEN",
          "MULLION_SOCKET_PATH",
          "MULLION_SESSION_ID",
        ].includes(key)
      ) {
        expect(plan.env[key]).toBeDefined();
        expect(plan.env[key]).not.toBe(process.env[key]);
        continue;
      }
      expect(plan.env[key]).toBeUndefined();
    }
    expect(plan.env.DATABASE_URL).toBeUndefined();
    expect(plan.env.PORT).toBeUndefined();
    expect(plan.env.MULLION_AUTH_TOKEN).toBeUndefined();
    expect(plan.env.MULLION_SSH_AUTH_SOCK).toBeUndefined();
  });

  it("preserves ordinary env vars the scrub doesn't own", () => {
    process.env.CUSTOM_TEST_VAR = "keep-me";
    process.env.PATH = "/usr/bin:/bin";

    const plan = buildLaunchPlan(baseSession());

    expect(plan.env.CUSTOM_TEST_VAR).toBe("keep-me");
    expect(plan.env.PATH).toBe("/usr/bin:/bin");
  });
});

describe("buildLaunchPlan — the five MULLION_* injections", () => {
  it("injects MULLION_HOOK_SOCKET from session.hookSocketPath", () => {
    const plan = buildLaunchPlan(baseSession({ hookSocketPath: "/tmp/sessions/hooks.sock" }));
    expect(plan.env.MULLION_HOOK_SOCKET).toBe("/tmp/sessions/hooks.sock");
  });

  it("injects MULLION_HOOK_TOKEN from session.hookToken", () => {
    const plan = buildLaunchPlan(baseSession({ hookToken: "abc123token" }));
    expect(plan.env.MULLION_HOOK_TOKEN).toBe("abc123token");
  });

  it("injects MULLION_SOCKET_PATH from session.controlSocketPath", () => {
    const plan = buildLaunchPlan(baseSession({ controlSocketPath: "/tmp/sessions/mullion.sock" }));
    expect(plan.env.MULLION_SOCKET_PATH).toBe("/tmp/sessions/mullion.sock");
  });

  it("injects MULLION_SESSION_ID from session.id", () => {
    const plan = buildLaunchPlan(baseSession({ id: "777" }));
    expect(plan.env.MULLION_SESSION_ID).toBe("777");
  });

  it("injects MULLION_REVIEW_GATE_ENABLED as the STRING form of session.reviewGateEnabled", () => {
    expect(
      buildLaunchPlan(baseSession({ reviewGateEnabled: true })).env.MULLION_REVIEW_GATE_ENABLED,
    ).toBe("true");
    expect(
      buildLaunchPlan(baseSession({ reviewGateEnabled: false })).env.MULLION_REVIEW_GATE_ENABLED,
    ).toBe("false");
  });

  it("an adapter's envAdditions can override the five injections — current, deliberate ordering (Object.assign runs after)", () => {
    mockApplyHookAdapters.mockImplementation((command: string) => ({
      command,
      envAdditions: { MULLION_SESSION_ID: "adapter-override" },
      matched: true,
      emits: [],
    }));

    const plan = buildLaunchPlan(baseSession({ id: "42" }));

    expect(plan.env.MULLION_SESSION_ID).toBe("adapter-override");
  });
});

describe("buildLaunchPlan — SSH_AUTH_SOCK injection", () => {
  it("injects SSH_AUTH_SOCK from session.sshAuthSock when set", () => {
    const plan = buildLaunchPlan(baseSession({ sshAuthSock: "/tmp/ssh-agent.sock" }));
    expect(plan.env.SSH_AUTH_SOCK).toBe("/tmp/ssh-agent.sock");
  });

  it("leaves an inherited SSH_AUTH_SOCK untouched when sshAuthSock is unset (feature off — no regression)", () => {
    process.env.SSH_AUTH_SOCK = "/run/user/1000/gnupg/S.gpg-agent.ssh";

    const plan = buildLaunchPlan(baseSession({ sshAuthSock: "" }));

    expect(plan.env.SSH_AUTH_SOCK).toBe("/run/user/1000/gnupg/S.gpg-agent.ssh");
  });

  it("an injected sshAuthSock wins over an inherited SSH_AUTH_SOCK", () => {
    process.env.SSH_AUTH_SOCK = "/run/user/1000/gnupg/S.gpg-agent.ssh";

    const plan = buildLaunchPlan(baseSession({ sshAuthSock: "/tmp/ssh-agent.sock" }));

    expect(plan.env.SSH_AUTH_SOCK).toBe("/tmp/ssh-agent.sock");
  });

  it("does not set SSH_AUTH_SOCK at all when unset and nothing was inherited", () => {
    delete process.env.SSH_AUTH_SOCK;

    const plan = buildLaunchPlan(baseSession({ sshAuthSock: "" }));

    expect(plan.env.SSH_AUTH_SOCK).toBeUndefined();
  });

  it("never leaks the MULLION_SSH_AUTH_SOCK config key itself into the session env", () => {
    process.env.MULLION_SSH_AUTH_SOCK = "/leaked/config-value.sock";

    const plan = buildLaunchPlan(baseSession({ sshAuthSock: "/tmp/ssh-agent.sock" }));

    expect(plan.env.MULLION_SSH_AUTH_SOCK).toBeUndefined();
  });
});

describe("buildLaunchPlan — agent guide injection", () => {
  it("calls writeSessionAgentGuide with dirname(hookSocketPath) and the session id", () => {
    buildLaunchPlan(baseSession({ hookSocketPath: "/tmp/sessions/hooks.sock", id: "99" }));

    expect(mockWriteSessionAgentGuide).toHaveBeenCalledWith("/tmp/sessions", "99");
  });

  it("writes the agent guide BEFORE applying hook adapters (issue #437c — opencode's prepareLaunch reads this file off disk)", () => {
    buildLaunchPlan(baseSession());

    expect(callOrder).toEqual([
      "writeSessionAgentGuide",
      "writeSessionBriefing",
      "applyHookAdapters",
    ]);
  });

  it("writes the agent guide unconditionally, even when injectAgentGuide is false", () => {
    buildLaunchPlan(baseSession({ injectAgentGuide: false }));

    expect(mockWriteSessionAgentGuide).toHaveBeenCalledTimes(1);
  });
});

describe("buildLaunchPlan — project briefing injection", () => {
  it("calls writeSessionBriefing with dirname(hookSocketPath), the session id, and cwd", () => {
    buildLaunchPlan(
      baseSession({
        hookSocketPath: "/tmp/sessions/hooks.sock",
        id: "99",
        cwd: "/tmp/project",
      }),
    );

    expect(mockWriteSessionBriefing).toHaveBeenCalledWith("/tmp/sessions", "99", "/tmp/project");
  });

  it("writes the briefing AFTER the guide but BEFORE applying hook adapters (same #437c ordering constraint the guide has, for the identical reason)", () => {
    buildLaunchPlan(baseSession());

    expect(callOrder).toEqual([
      "writeSessionAgentGuide",
      "writeSessionBriefing",
      "applyHookAdapters",
    ]);
  });

  it("writes the briefing unconditionally, even when injectProjectBriefing is false — mirrors the guide's own invariant (gate the injection, never the write)", () => {
    buildLaunchPlan(baseSession({ injectProjectBriefing: false }));

    expect(mockWriteSessionBriefing).toHaveBeenCalledTimes(1);
  });
});

describe("buildLaunchPlan — hook adapter wiring", () => {
  it("passes the full HookAdapterContext through to applyHookAdapters", () => {
    buildLaunchPlan(
      baseSession({
        command: "claude",
        id: "42",
        cwd: "/tmp/project",
        hookSocketPath: "/tmp/sessions/hooks.sock",
        hookToken: "tok",
        controlSocketPath: "/tmp/sessions/mullion.sock",
        reviewGateEnabled: true,
        injectAgentGuide: false,
        injectProjectBriefing: false,
        skipPermissions: true,
      }),
    );

    expect(mockApplyHookAdapters).toHaveBeenCalledWith(
      "claude",
      expect.objectContaining({
        sessionId: "42",
        sessionsDir: "/tmp/sessions",
        hookSocketPath: "/tmp/sessions/hooks.sock",
        hookToken: "tok",
        controlSocketPath: "/tmp/sessions/mullion.sock",
        forwarderPath: "/fake/forwarder.mjs",
        reviewGateEnabled: true,
        injectAgentGuide: false,
        injectProjectBriefing: false,
        cwd: "/tmp/project",
        skipPermissions: true,
      }),
    );
  });

  it("propagates matched -> hooksActive and emits -> hookEmits", () => {
    mockApplyHookAdapters.mockImplementation((command: string) => ({
      command,
      envAdditions: {},
      matched: true,
      emits: ["progress", "stop_failure"],
    }));

    const plan = buildLaunchPlan(baseSession());

    expect(plan.hooksActive).toBe(true);
    expect(plan.hookEmits).toEqual(["progress", "stop_failure"]);
  });

  it("no adapter matched -> hooksActive false, hookEmits empty", () => {
    const plan = buildLaunchPlan(baseSession());

    expect(plan.hooksActive).toBe(false);
    expect(plan.hookEmits).toEqual([]);
  });

  it("uses the adapter's commandTransform result (not the original command) as the base for the launched argv", () => {
    mockApplyHookAdapters.mockImplementation((command: string) => ({
      command: `${command} --settings /tmp/sessions/42.hooks.json`,
      envAdditions: {},
      matched: true,
      emits: [],
    }));

    const plan = buildLaunchPlan(baseSession({ command: "claude" }));

    const finalCommand = plan.argv.at(-1);
    expect(finalCommand).toBe("claude --settings /tmp/sessions/42.hooks.json");
  });
});

describe("buildLaunchPlan — skip-permissions handling", () => {
  it("off: launch command is unchanged", () => {
    const plan = buildLaunchPlan(baseSession({ command: "claude", skipPermissions: false }));
    expect(plan.argv.at(-1)).toBe("claude");
  });

  it("on, known agent: appends the agent-specific flag", () => {
    const plan = buildLaunchPlan(baseSession({ command: "claude", skipPermissions: true }));
    expect(plan.argv.at(-1)).toBe("claude --dangerously-skip-permissions");
  });

  it("on, unrecognized command: no flag to append, trimEnd() leaves no trailing space", () => {
    const plan = buildLaunchPlan(baseSession({ command: "bash", skipPermissions: true }));
    expect(plan.argv.at(-1)).toBe("bash");
  });

  it("on, agent-transformed command still matches the flag lookup (anchored on the transformed command)", () => {
    mockApplyHookAdapters.mockImplementation((command: string) => ({
      command: `${command} --settings /tmp/x.json`,
      envAdditions: {},
      matched: true,
      emits: [],
    }));

    const plan = buildLaunchPlan(baseSession({ command: "claude", skipPermissions: true }));

    expect(plan.argv.at(-1)).toBe("claude --settings /tmp/x.json --dangerously-skip-permissions");
  });

  // Task Master trial 220921 / PR #743 — agy's flag is TWO tokens, not one:
  // --dangerously-skip-permissions alone leaves agy's own sticky, global
  // "plan" execution mode in effect, which silently blocks every
  // write_to_file (including a review agent's own findings-file write).
  // See SKIP_PERMISSION_FLAGS' own doc comment for the live verification.
  it("on, agy: appends BOTH the permission flag and --mode accept-edits", () => {
    const plan = buildLaunchPlan(baseSession({ command: "agy", skipPermissions: true }));
    expect(plan.argv.at(-1)).toBe("agy --dangerously-skip-permissions --mode accept-edits");
  });
});

describe("buildLaunchPlan — initial-prompt composition", () => {
  it("undefined initialPrompt: getAdapterInitialPromptArgs is never called, command unaffected", () => {
    const plan = buildLaunchPlan(baseSession({ command: "claude", initialPrompt: undefined }));

    expect(mockGetAdapterInitialPromptArgs).not.toHaveBeenCalled();
    expect(plan.argv.at(-1)).toBe("claude");
  });

  it("empty-string initialPrompt is treated the same as undefined (falsy, no-op)", () => {
    const plan = buildLaunchPlan(baseSession({ command: "claude", initialPrompt: "" }));

    expect(mockGetAdapterInitialPromptArgs).not.toHaveBeenCalled();
    expect(plan.argv.at(-1)).toBe("claude");
  });

  it("non-empty prompt, adapter has no argv form (returns null): command unaffected, same as no prompt", () => {
    mockGetAdapterInitialPromptArgs.mockImplementation(() => null);

    const plan = buildLaunchPlan(
      baseSession({ command: "opencode", initialPrompt: "fix the bug" }),
    );

    expect(mockGetAdapterInitialPromptArgs).toHaveBeenCalledWith("opencode", "fix the bug");
    expect(plan.argv.at(-1)).toBe("opencode");
  });

  it("non-empty prompt, adapter returns argv: appended last, after skip-permissions", () => {
    mockGetAdapterInitialPromptArgs.mockImplementation(() => '"fix the bug"');

    const plan = buildLaunchPlan(
      baseSession({ command: "claude", skipPermissions: true, initialPrompt: "fix the bug" }),
    );

    expect(plan.argv.at(-1)).toBe('claude --dangerously-skip-permissions "fix the bug"');
  });

  it("matches against the ORIGINAL command, not the adapter-transformed launch command", () => {
    mockApplyHookAdapters.mockImplementation((command: string) => ({
      command: `${command} --settings /tmp/x.json`,
      envAdditions: {},
      matched: true,
      emits: [],
    }));
    mockGetAdapterInitialPromptArgs.mockImplementation(() => '"go"');

    buildLaunchPlan(baseSession({ command: "claude", initialPrompt: "go" }));

    expect(mockGetAdapterInitialPromptArgs).toHaveBeenCalledWith("claude", "go");
  });
});

describe("buildLaunchPlan — shell/unitName/argv shape", () => {
  it("resolves shell from process.env.SHELL, falling back to /bin/bash", () => {
    process.env.SHELL = "/usr/bin/zsh";
    expect(buildLaunchPlan(baseSession()).shell).toBe("/usr/bin/zsh");

    delete process.env.SHELL;
    expect(buildLaunchPlan(baseSession()).shell).toBe("/bin/bash");
  });

  it("unitName matches scopeUnitName(session.id)", () => {
    const plan = buildLaunchPlan(baseSession({ id: "123" }));
    expect(plan.unitName).toBe(scopeUnitName("123"));
  });

  it("argv is the exact systemd-run/dtach invocation bootstrapMaster used to build inline", () => {
    const plan = buildLaunchPlan(
      baseSession({ id: "55", socketPath: "/tmp/sessions/55.sock", command: "bash" }),
    );

    expect(plan.argv).toEqual([
      "--user",
      "--scope",
      "--collect",
      "-u",
      plan.unitName,
      "--",
      "dtach",
      "-n",
      "/tmp/sessions/55.sock",
      plan.shell,
      "-lc",
      "bash",
    ]);
  });
});

describe("buildLaunchPlan — shell integration (real applyShellIntegrationEnv, zsh branch)", () => {
  it("sets ZDOTDIR to a shim dir under sessionsDir and captures the prior value as MULLION_USER_ZDOTDIR", () => {
    const sessionsDir = mkTmpDir("launch-plan-zsh-");
    process.env.SHELL = "/bin/zsh";
    process.env.HOME = "/home/real-user";
    delete process.env.ZDOTDIR;

    const plan = buildLaunchPlan(baseSession({ sessionsDir }));

    expect(plan.env.MULLION_USER_ZDOTDIR).toBe("/home/real-user");
    expect(plan.env.ZDOTDIR).toBe(path.join(sessionsDir, "shell-integration", "zsh"));
  });

  it("bash: injects the OSC 7 PROMPT_COMMAND snippet instead of touching ZDOTDIR", () => {
    process.env.SHELL = "/bin/bash";
    delete process.env.PROMPT_COMMAND;
    // The real host shell running this test suite may itself have ZDOTDIR
    // set (e.g. a zsh dev shell) — buildSessionEnv() deliberately doesn't
    // strip it (see session-env.ts's own doc comment), so scrub that
    // pre-existing leak here too, or this assertion would be testing the
    // dev host's shell rather than applyShellIntegrationEnv's bash branch.
    delete process.env.ZDOTDIR;

    const plan = buildLaunchPlan(baseSession());

    expect(plan.env.ZDOTDIR).toBeUndefined();
    expect(plan.env.PROMPT_COMMAND).toEqual(expect.stringContaining("\\033]7;"));
  });
});
