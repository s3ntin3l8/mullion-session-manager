// Hook adapter integration at spawn (issue #174) — the real spawn seam, the argv each agent gets, and Session.hookEmits (issue #351).
//
// Split out of the former test/services/pty-manager.test.ts (issue #3277) —
// that file sat at the file-size ratchet's ceiling, so a change here could no
// longer land next to the tests it belongs with. The shared mock preamble and
// helpers live in test/helpers/pty-manager-harness.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  bundleSyncMock,
  cgroupInventoryMock,
  childProcessMock,
  createPtyManagerFixture,
  destroyPtyManagerFixture,
  nodePtyMock,
  resetPtyManagerMocks,
  waitForSpawn,
} from "../helpers/pty-manager-harness.js";
import { spawn as spawnChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildAgentGuideBlock, sessionAgentGuidePath } from "../../src/services/agent-guide.js";
import { resolveMullionBundleDir } from "../../src/services/hook-adapters/mullion-bundle.js";
import { buildOpenCodeMcpConfig } from "../../src/services/hook-adapters/opencode.js";
import { buildCodexMcpFlags, buildCodexTrustFlag } from "../../src/services/hook-adapters/codex.js";
import { resolveMcpServerPath } from "../../src/services/hook-adapters/shared.js";
import { deriveInstanceId } from "../../src/services/session-process.js";
import { getScopeBackend } from "../../src/services/scope/index.js";

vi.mock("node-pty", () => nodePtyMock());
vi.mock("../../src/services/bundle-sync.js", () => bundleSyncMock());
vi.mock("node:child_process", async (importOriginal) => childProcessMock(await importOriginal()));
vi.mock("../../src/services/cgroup-inventory.js", () => cgroupInventoryMock());

const { PtyManager, Session } = await import("../../src/services/pty-manager.js");
const { getAdapterEmits } = await import("../../src/services/hook-adapters/index.js");

describe("Session.hookEmits (issue #351)", () => {
  let sessionsDir: string;

  beforeEach(() => {
    sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-hookemits-"));
    // Create sessionsDir for Session constructor
    fs.mkdirSync(sessionsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  });

  function makeSession(opts: { id: string; command: string; cols?: number; rows?: number }) {
    return new Session({
      id: opts.id,
      cwd: "/tmp",
      command: opts.command,
      socketPath: path.join(sessionsDir, `${opts.id}.sock`),
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      hookSocketPath: path.join(sessionsDir, "hooks.sock"),
      controlSocketPath: path.join(sessionsDir, "mullion.sock"),
      sessionsDir,
      scope: getScopeBackend({
        sessionsDir,
        instanceId: deriveInstanceId(sessionsDir),
      }),
    });
  }

  it("reports hookEmits matching CLAUDE_CODE_EMITS for a claude-matching command", () => {
    const emits = getAdapterEmits("claude");
    expect(emits).toContain("notification");
    expect(emits).toContain("progress");
    expect(emits).toContain("stop_failure");
    expect(emits).toContain("session_end");
    // Also verify through Session constructor -> toInfo() path
    const session = makeSession({ id: "1", command: "claude" });
    const info = session.toInfo();
    expect(info.hookEmits).toContain("notification");
  });

  it("reports hookEmits as [] for a bash (non-matching) command", () => {
    expect(getAdapterEmits("bash")).toEqual([]);
    const session = makeSession({ id: "2", command: "bash" });
    const info = session.toInfo();
    expect(info.hookEmits).toEqual([]);
  });
});

describe("PtyManager", () => {
  let sessionsDir: string;
  let manager: InstanceType<typeof PtyManager>;

  beforeEach(() => {
    // Every test starts from a clean slate: no fake PTYs, no `systemctl`
    // fixtures and no cgroup-inventory call log left over from a sibling.
    resetPtyManagerMocks();
    ({ sessionsDir, manager } = createPtyManagerFixture(PtyManager));
  });

  afterEach(() => {
    destroyPtyManagerFixture({ sessionsDir, manager });
  });

  // Confirms bootstrapMaster() actually wires applyHookAdapters() in — the
  // adapter framework itself is unit-tested directly against
  // (test/services/hook-adapters/), this just proves the spawn seam calls
  // it with the right context and uses its result (issue #174).
  describe("hook adapter integration at spawn (issue #174)", () => {
    // injectMullionBundle defaults to true (PtyManager's own getInjectMullionBundle
    // default) and this checkout genuinely ships src/bundle/, so every real
    // `manager.getOrCreate({command: "claude", ...})` spawn below appends
    // --plugin-dir too — computed here, once, rather than hardcoded, so this
    // suite doesn't hardcode a worktree-specific absolute path.
    const bundleFlag = ` --plugin-dir ${JSON.stringify(resolveMullionBundleDir())}`;

    it("spawns a matching (claude) command with --settings and --mcp-config appended, and writes both files (issue #271)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      const settingsPath = path.join(sessionsDir, "1.hooks.json");
      expect(fs.existsSync(settingsPath)).toBe(true);
      const mcpConfigPath = path.join(sessionsDir, "1.mcp.json");
      expect(fs.existsSync(mcpConfigPath)).toBe(true);

      // PreToolUse has exactly one entry (ExitPlanMode, observational) — the
      // old Bash gate this used to also register behind a flag was replaced
      // by PermissionRequest-based approval (issue #264), registered
      // unconditionally with the long permission-approval timeout.
      const written = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      expect(written.hooks.PreToolUse).toBeDefined();
      expect(written.hooks.PreToolUse[0].matcher).toBe("ExitPlanMode");
      expect(written.hooks.PreToolUse[1]).toBeUndefined();
      expect(written.hooks.PermissionRequest[0].hooks[0].timeout).toBe(300);

      // .findLast, not .find: this mock is shared (and never cleared)
      // across every test in this file, so earlier tests' own "systemd-run"
      // calls are still in its history — only the MOST RECENT one is this
      // test's own spawn.
      const call = vi
        .mocked(spawnChildProcess)
        .mock.calls.findLast(([file]) => file === "systemd-run");
      expect(call).toBeDefined();
      const args = call?.[1] as string[];
      expect(args[args.length - 1]).toBe(
        `claude --settings ${JSON.stringify(settingsPath)} --mcp-config ${JSON.stringify(mcpConfigPath)}${bundleFlag}`,
      );
    });

    it("injects SSH_AUTH_SOCK from the spawned systemd-run env only when PtyManager is constructed with sshAuthSock set", async () => {
      const bridgedManager = new PtyManager({ sessionsDir, sshAuthSock: "/tmp/ssh-agent.sock" });
      const session = bridgedManager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      const call = vi
        .mocked(spawnChildProcess)
        .mock.calls.findLast(([file]) => file === "systemd-run");
      expect(call).toBeDefined();
      const opts = call?.[2] as { env?: Record<string, string> };
      expect(opts.env?.SSH_AUTH_SOCK).toBe("/tmp/ssh-agent.sock");

      // Same "this test's own manager, clean up its own timers/sessions"
      // reasoning as this describe block's other own-manager tests.
      bridgedManager.killAll();
    });

    it("resolves a relative sshAuthSock against the server's own cwd, not a session's project cwd", async () => {
      // dtach (and every session shell) runs with cwd set to the SESSION's
      // own project directory, not this process's — same reasoning as
      // controlSocketPath's own path.resolve() a few lines above it in
      // PtyManager's constructor. An unresolved relative path here would
      // otherwise resolve differently (or not at all) per session.
      const relativeManager = new PtyManager({
        sessionsDir,
        sshAuthSock: "relative/ssh-agent.sock",
      });
      const session = relativeManager.getOrCreate({
        id: "1",
        cwd: "/tmp/some-other-project",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      const call = vi
        .mocked(spawnChildProcess)
        .mock.calls.findLast(([file]) => file === "systemd-run");
      expect(call).toBeDefined();
      const opts = call?.[2] as { env?: Record<string, string> };
      expect(opts.env?.SSH_AUTH_SOCK).toBe(path.resolve(process.cwd(), "relative/ssh-agent.sock"));

      relativeManager.killAll();
    });

    it("injects env from CreateSessionOptions.env into the spawned systemd-run env", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
        env: { CUSTOM_VAR: "hello" },
      });
      await waitForSpawn(session);

      const call = vi
        .mocked(spawnChildProcess)
        .mock.calls.findLast(([file]) => file === "systemd-run");
      expect(call).toBeDefined();
      const opts = call?.[2] as { env?: Record<string, string> };
      expect(opts.env?.CUSTOM_VAR).toBe("hello");
    });

    it("a MULLION_* injection wins over a colliding key in CreateSessionOptions.env", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
        env: { MULLION_SESSION_ID: "attacker-value" },
      });
      await waitForSpawn(session);

      const call = vi
        .mocked(spawnChildProcess)
        .mock.calls.findLast(([file]) => file === "systemd-run");
      const opts = call?.[2] as { env?: Record<string, string> };
      expect(opts.env?.MULLION_SESSION_ID).toBe("1");
    });

    // Issue #822 — env is per-session config (CreateSessionOptions.env),
    // not just a spawn-time input: a re-bootstrap on a FRESH PtyManager
    // (simulating a Mullion process restart, same pattern as the hook-token
    // persistence test above) must be re-supplied it — exactly what
    // routes/terminal.ts's resolveAndAttach does by reading it back off the
    // DB row and passing it into attachSocketToSession's getOrCreate call.
    // This test proves PtyManager's own half of that contract: given the
    // same env again, the respawned session's launch applies it.
    it("re-applies env on a fresh PtyManager given the same env again (simulates reattach after a Mullion process restart)", async () => {
      const first = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
        env: { CUSTOM_VAR: "hello" },
      });
      await waitForSpawn(first);

      const restarted = new PtyManager({ sessionsDir });
      const reattached = restarted.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
        env: { CUSTOM_VAR: "hello" },
      });
      await waitForSpawn(reattached);

      const call = vi
        .mocked(spawnChildProcess)
        .mock.calls.findLast(([file]) => file === "systemd-run");
      const opts = call?.[2] as { env?: Record<string, string> };
      expect(opts.env?.CUSTOM_VAR).toBe("hello");

      restarted.killAll();
    });

    it("leaves an inherited SSH_AUTH_SOCK untouched by default (PtyManager constructed with no sshAuthSock override)", async () => {
      // Deliberately NOT asserting absence here: buildSessionEnv() never
      // strips SSH_AUTH_SOCK (see session-env.ts's "Deliberately NOT
      // stripped" comment), so the default-off behavior is pass-through, not
      // removal — matching whatever this test process itself inherited, set
      // explicitly here so the assertion doesn't depend on the host's own
      // ambient environment.
      const original = process.env.SSH_AUTH_SOCK;
      process.env.SSH_AUTH_SOCK = "/run/user/1000/gnupg/S.gpg-agent.ssh";
      try {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "bash",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);

        const call = vi
          .mocked(spawnChildProcess)
          .mock.calls.findLast(([file]) => file === "systemd-run");
        expect(call).toBeDefined();
        const opts = call?.[2] as { env?: Record<string, string> };
        expect(opts.env?.SSH_AUTH_SOCK).toBe("/run/user/1000/gnupg/S.gpg-agent.ssh");
      } finally {
        if (original === undefined) delete process.env.SSH_AUTH_SOCK;
        else process.env.SSH_AUTH_SOCK = original;
      }
    });

    it("spawns a non-matching command completely unchanged, writing no settings file", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      expect(fs.existsSync(path.join(sessionsDir, "1.hooks.json"))).toBe(false);
      // .findLast, not .find: this mock is shared (and never cleared)
      // across every test in this file, so earlier tests' own "systemd-run"
      // calls are still in its history — only the MOST RECENT one is this
      // test's own spawn.
      const call = vi
        .mocked(spawnChildProcess)
        .mock.calls.findLast(([file]) => file === "systemd-run");
      const args = call?.[1] as string[];
      expect(args[args.length - 1]).toBe("bash");
    });

    it("appends the skip-permissions flag when skipPermissions is true", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
        skipPermissions: true,
      });
      await waitForSpawn(session);

      const call = vi
        .mocked(spawnChildProcess)
        .mock.calls.findLast(([file]) => file === "systemd-run");
      const args = call?.[1] as string[];
      expect(args[args.length - 1]).toMatch(/claude.*--dangerously-skip-permissions/);
    });

    it("does not append the skip-permissions flag when skipPermissions is false or absent", async () => {
      const session = manager.getOrCreate({
        id: "2",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      const call = vi
        .mocked(spawnChildProcess)
        .mock.calls.findLast(([file]) => file === "systemd-run");
      const args = call?.[1] as string[];
      expect(args[args.length - 1]).not.toMatch(/--dangerously-skip-permissions/);
    });

    // Task Master's initial-prompt fix — a claim/retry/review spawn no
    // longer relies on stashSeed's SessionStart `additionalContext` (which
    // injects context but never submits a turn); it appends the matched
    // hook adapter's initialPromptArgs to the spawned command line instead.
    // Pins the ordering this whole fix depends on (see pty-manager.ts's own
    // doc comment on `initialPromptArgs`'s composition): commandTransform's
    // own flags first, then skipPermissions, then the prompt LAST — so
    // neither the hook-adapter matches() guard nor getSkipPermissionFlag's
    // metacharacter guard ever sees prompt text, and shell metacharacters in
    // the prompt (a real-world issue body routinely has them) can't break
    // either guard or escape the surrounding single quotes.
    //
    // Covers claude and codex through the full spawn path (both write into
    // test-scoped scratch dirs — sessionsDir / $CODEX_HOME). agy's
    // managedInstall() writes into the REAL developer/CI-runner's
    // ~/.gemini/config (no env override exists — see agy.test.ts's own doc
    // comment for why even the adapter-level merge test uses a scratch path
    // via __testing rather than spawning "agy" for real); its
    // initialPromptArgs argv shape (`-i '<prompt>'`) and metacharacter
    // safety are covered instead by
    // hook-adapters/initial-prompt.test.ts's adapter-level tests, which
    // exercise the exact same shellQuote() this integration path calls.
    describe("Task Master initial-prompt argv (claimed task never starting a turn)", () => {
      // ; & | < > are shell-significant outside single quotes; an
      // apostrophe needs its own escape. A real task body routinely
      // contains all of these.
      const dangerousPrompt = "fix the bug; rm -rf / && it's broken | echo <script> > out.txt";
      // Hermes review, PR #538 — claude/codex both prepend `--` so a
      // leading-hyphen prompt isn't parsed as an unrecognized option (see
      // claude-code.ts's own doc comment for the live-verified failure this
      // fixes).
      const quotedDangerousPrompt =
        "-- 'fix the bug; rm -rf / && it'\\''s broken | echo <script> > out.txt'";

      it("appends the shell-quoted prompt after --settings/--mcp-config for claude, with skipPermissions off", async () => {
        const session = manager.getOrCreate({
          id: "10",
          cwd: "/tmp",
          command: "claude",
          cols: 80,
          rows: 24,
          initialPrompt: dangerousPrompt,
        });
        await waitForSpawn(session);

        const settingsPath = path.join(sessionsDir, "10.hooks.json");
        const mcpConfigPath = path.join(sessionsDir, "10.mcp.json");
        expect(fs.existsSync(settingsPath)).toBe(true);

        const call = vi
          .mocked(spawnChildProcess)
          .mock.calls.findLast(([file]) => file === "systemd-run");
        const args = call?.[1] as string[];
        expect(args[args.length - 1]).toBe(
          `claude --settings ${JSON.stringify(settingsPath)} --mcp-config ${JSON.stringify(mcpConfigPath)}${bundleFlag} ${quotedDangerousPrompt}`,
        );
        // Hooks stayed wired — the exact regression the rejected
        // "append the prompt to `command` before matches()" alternative
        // would have caused (dangerousPrompt's `;`/`&`/`|`/`<`/`>` would
        // have failed SHELL_METACHARACTERS_RE and silently disabled hooks).
        const written = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
        expect(written.hooks.Notification).toBeDefined();
      });

      it("appends the shell-quoted prompt after --settings/--mcp-config AND the skip-permissions flag for claude, with skipPermissions on", async () => {
        const session = manager.getOrCreate({
          id: "11",
          cwd: "/tmp",
          command: "claude",
          cols: 80,
          rows: 24,
          skipPermissions: true,
          initialPrompt: dangerousPrompt,
        });
        await waitForSpawn(session);

        const settingsPath = path.join(sessionsDir, "11.hooks.json");
        const mcpConfigPath = path.join(sessionsDir, "11.mcp.json");

        const call = vi
          .mocked(spawnChildProcess)
          .mock.calls.findLast(([file]) => file === "systemd-run");
        const args = call?.[1] as string[];
        expect(args[args.length - 1]).toBe(
          `claude --settings ${JSON.stringify(settingsPath)} --mcp-config ${JSON.stringify(mcpConfigPath)}${bundleFlag} --dangerously-skip-permissions ${quotedDangerousPrompt}`,
        );
      });

      it("does not append any prompt argv when initialPrompt is omitted (claude)", async () => {
        const session = manager.getOrCreate({
          id: "12",
          cwd: "/tmp",
          command: "claude",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);

        const call = vi
          .mocked(spawnChildProcess)
          .mock.calls.findLast(([file]) => file === "systemd-run");
        const args = call?.[1] as string[];
        expect(args[args.length - 1]).not.toContain(dangerousPrompt);
        expect(args[args.length - 1].endsWith(JSON.stringify(resolveMullionBundleDir()))).toBe(
          true,
        );
      });

      // Hermes review, PR #538 — a task title starting with `-` is a real,
      // reachable prompt (issue titles routinely start with punctuation),
      // and verified live to fail argv parsing without the `--` marker
      // (`claude: error: unknown option '-x hello'`).
      it("prepends `--` so a leading-hyphen prompt reaches claude as a positional, not an option", async () => {
        const session = manager.getOrCreate({
          id: "15",
          cwd: "/tmp",
          command: "claude",
          cols: 80,
          rows: 24,
          initialPrompt: "- fix the leading-hyphen bug",
        });
        await waitForSpawn(session);

        const settingsPath = path.join(sessionsDir, "15.hooks.json");
        const mcpConfigPath = path.join(sessionsDir, "15.mcp.json");
        const call = vi
          .mocked(spawnChildProcess)
          .mock.calls.findLast(([file]) => file === "systemd-run");
        const args = call?.[1] as string[];
        expect(args[args.length - 1]).toBe(
          `claude --settings ${JSON.stringify(settingsPath)} --mcp-config ${JSON.stringify(mcpConfigPath)}${bundleFlag} -- '- fix the leading-hyphen bug'`,
        );
      });

      describe("codex", () => {
        let codexHome: string;
        const originalCodexHome = process.env.CODEX_HOME;
        const originalHome = process.env.HOME;

        beforeEach(() => {
          // Same scratch-dir redirection as the existing "Codex (issue
          // #252)" describe block above — codex.ts merges into the REAL
          // $CODEX_HOME/hooks.json, and (since the forwarder-shim
          // migration) also installs the shim at a fixed os.homedir()-
          // derived location, so HOME needs the same redirection.
          codexHome = path.join(sessionsDir, "codex-home-scratch-prompt");
          process.env.CODEX_HOME = codexHome;
          process.env.HOME = path.join(sessionsDir, "fake-home-codex-prompt");
        });

        afterEach(() => {
          if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
          else process.env.CODEX_HOME = originalCodexHome;
          if (originalHome === undefined) delete process.env.HOME;
          else process.env.HOME = originalHome;
        });

        it("appends the shell-quoted prompt after the MCP -c flags, with skipPermissions off", async () => {
          const session = manager.getOrCreate({
            id: "13",
            cwd: "/tmp",
            command: "codex",
            cols: 80,
            rows: 24,
            initialPrompt: dangerousPrompt,
          });
          await waitForSpawn(session);

          const call = vi
            .mocked(spawnChildProcess)
            .mock.calls.findLast(([file]) => file === "systemd-run");
          const args = call?.[1] as string[];
          // Issue #906 + issue #880 — --add-dir .git (unconditional) lands
          // first, then the MCP -c flags, then the shell-quoted prompt
          // (commandTransform runs before initialPromptArgs — see
          // launch-plan.ts's own ordering comment).
          const mcpFlags = buildCodexMcpFlags(resolveMcpServerPath());
          expect(args[args.length - 1]).toBe(
            `codex --add-dir .git ${mcpFlags} ${quotedDangerousPrompt}`,
          );
        });

        it("appends the skip-permissions flag between the MCP -c flags and the shell-quoted prompt, with skipPermissions on", async () => {
          const session = manager.getOrCreate({
            id: "14",
            cwd: "/tmp",
            command: "codex",
            cols: 80,
            rows: 24,
            skipPermissions: true,
            initialPrompt: dangerousPrompt,
          });
          await waitForSpawn(session);

          const call = vi
            .mocked(spawnChildProcess)
            .mock.calls.findLast(([file]) => file === "systemd-run");
          const args = call?.[1] as string[];
          const mcpFlags = buildCodexMcpFlags(resolveMcpServerPath());
          // Folder-trust hang fix — ctx.skipPermissions && ctx.cwd
          // (both true here) also appends buildCodexTrustFlag, landing
          // between the MCP flags and the skip-permissions flag: it's
          // part of the SAME commandTransform as the MCP flags (launch-plan.ts
          // runs commandTransform, then appends the skip-permissions flag
          // as a separate later step).
          const trustFlag = buildCodexTrustFlag("/tmp");
          expect(args[args.length - 1]).toBe(
            `codex --add-dir .git ${mcpFlags} ${trustFlag} --dangerously-bypass-approvals-and-sandbox ${quotedDangerousPrompt}`,
          );
        });
      });
    });

    it("spawns a matching (opencode) command with --standalone, the plugin file written and no OPENCODE_CONFIG_DIR (issue #175; opencode v2)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "opencode",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      const pluginPath = path.join(sessionsDir, "1.opencode-config", "plugin", "server.js");
      expect(fs.existsSync(pluginPath)).toBe(true);

      const call = vi
        .mocked(spawnChildProcess)
        .mock.calls.findLast(([file]) => file === "systemd-run");
      const args = call?.[1] as string[];
      const opts = call?.[2] as { env?: Record<string, string> };
      // v2: a private per-session server instead of the shared background
      // service, and no OPENCODE_CONFIG_DIR (it would REPLACE the user's
      // global config root).
      expect(args[args.length - 1]).toBe("opencode --standalone");
      expect(opts.env).not.toHaveProperty("OPENCODE_CONFIG_DIR");
    });

    // Issue #884 — session-lifecycle.ts's createSessionRecord threads a
    // per-project-resolved value through getOrCreate() as an explicit opt;
    // this is the direct, adapter-independent proof that opt wins over the
    // manager's own live getInjectAgentGuide()/getInjectProjectBriefing()
    // closures, which is what makes that threading meaningful at all.
    it("getOrCreate()'s explicit injectAgentGuide/injectProjectBriefing opts win over the manager's own live closures", async () => {
      const overrideManager = new PtyManager({
        sessionsDir,
        getInjectAgentGuide: () => true,
        getInjectProjectBriefing: () => true,
      });
      const session = overrideManager.getOrCreate({
        id: "9001",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
        injectAgentGuide: false,
        injectProjectBriefing: false,
      });
      expect(session.injectAgentGuide).toBe(false);
      expect(session.injectProjectBriefing).toBe(false);
      overrideManager.killAll();
    });

    it("getOrCreate() falls back to the manager's live closures when the opts are omitted (unchanged pre-#884 behavior)", async () => {
      const fallbackManager = new PtyManager({
        sessionsDir,
        getInjectAgentGuide: () => false,
        getInjectProjectBriefing: () => false,
      });
      const session = fallbackManager.getOrCreate({
        id: "9002",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      expect(session.injectAgentGuide).toBe(false);
      expect(session.injectProjectBriefing).toBe(false);
      fallbackManager.killAll();
    });

    // Issue #1089 — same direct, adapter-independent proof as the
    // injectAgentGuide/injectProjectBriefing test immediately above, for the
    // independent sessions.injectMullionBundle setting: before this fix,
    // getOrCreate() ignored `opts.injectMullionBundle` entirely and always
    // used the manager's own live getInjectMullionBundle() closure, which is
    // exactly the bug that let a remote agent host silently always inject
    // the bundle regardless of what the primary's stored setting said.
    it("getOrCreate()'s explicit injectMullionBundle opt wins over the manager's own live getInjectMullionBundle() closure", async () => {
      const overrideManager = new PtyManager({
        sessionsDir,
        getInjectMullionBundle: () => true,
      });
      const session = overrideManager.getOrCreate({
        id: "9003",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
        injectMullionBundle: false,
      });
      expect(session.injectMullionBundle).toBe(false);
      overrideManager.killAll();
    });

    it("getOrCreate() falls back to the manager's live getInjectMullionBundle() closure when the opt is omitted (unchanged pre-#1089 behavior)", async () => {
      const fallbackManager = new PtyManager({
        sessionsDir,
        getInjectMullionBundle: () => false,
      });
      const session = fallbackManager.getOrCreate({
        id: "9004",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      expect(session.injectMullionBundle).toBe(false);
      fallbackManager.killAll();
    });

    it("hands this session's own tier-0 guide push to the opencode plugin when injectAgentGuide is on (issue #949, formerly #437c; default manager — getInjectAgentGuide defaults to () => true)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "opencode",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      const call = vi
        .mocked(spawnChildProcess)
        .mock.calls.findLast(([file]) => file === "systemd-run");
      const opts = call?.[2] as { env?: Record<string, string> };
      expect(opts.env?.OPENCODE_CONFIG_CONTENT).toBeDefined();
      const tier0Path = path.join(sessionsDir, "1.opencode-tier0.md");
      // getInjectMullionBundle also defaults to () => true, and this
      // checkout genuinely ships src/bundle/ — the payload carries
      // skills alongside the plugin, same as claude-code's
      // --plugin-dir composing with --settings/--mcp-config
      // (this file's own claude-code case above). Issue
      // #881 — mcp.mullion is now unconditional, so it's present here too.
      expect(JSON.parse(opts.env!.OPENCODE_CONFIG_CONTENT)).toEqual({
        skills: [path.join(resolveMullionBundleDir()!, "skills")],
        plugins: [path.join(sessionsDir, "1.opencode-config", "plugin")],
        mcp: buildOpenCodeMcpConfig(
          resolveMcpServerPath(),
          manager.hookSocketPath,
          session.hookToken,
          manager.controlSocketPath,
        ),
      });
      // v2 never reads the `instructions` config key, so the plugin gets the
      // file paths via this env var instead.
      expect(JSON.parse(opts.env!.MULLION_OPENCODE_INSTRUCTIONS)).toEqual([tier0Path]);
      // The tier-0 file itself is a real on-disk write (settingsFiles),
      // not just an env-var reference — same short block hooks.ts pushes
      // to the other three agents, `authEnabled` defaulting true here
      // (this describe block's own `manager` is constructed with no
      // authEnabled option — see the dedicated authEnabled test below for
      // the explicit `false` case).
      expect(fs.readFileSync(tier0Path, "utf8")).toBe(
        buildAgentGuideBlock(sessionAgentGuidePath(sessionsDir, "1"), true),
      );
    });

    // Issue #949 — the end-to-end proof that `authEnabled` (a boot-time
    // PtyManager constant, threaded the same way sshAuthSock already is —
    // see this describe block's own sshAuthSock tests above) actually
    // reaches the opencode tier-0 file's content, not just the
    // HookAdapterContext unit-level assertions in launch-plan.test.ts/
    // opencode.test.ts.
    it("reflects PtyManager's own authEnabled constant in the opencode tier-0 push", async () => {
      const authedManager = new PtyManager({ sessionsDir, authEnabled: true });
      const session = authedManager.getOrCreate({
        id: "5",
        cwd: "/tmp",
        command: "opencode",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      const tier0Path = path.join(sessionsDir, "5.opencode-tier0.md");
      expect(fs.readFileSync(tier0Path, "utf8")).toBe(
        buildAgentGuideBlock(sessionAgentGuidePath(sessionsDir, "5"), true),
      );

      authedManager.killAll();
    });

    it("omits the guide pointer from instructions when the manager's getInjectAgentGuide reports the setting off — mirrors hooks.ts gating the pointer, not the on-disk write, for every other agent (issue #437c; OPENCODE_CONFIG_CONTENT itself stays present for the unconditional mcp entry, issue #881)", async () => {
      // getInjectMullionBundle: () => false too — this test is specifically
      // about the injectAgentGuide gate; the bundle's own independent gate
      // has its own coverage in "Mullion tooling bundle" below.
      const ungatedManager = new PtyManager({
        sessionsDir,
        getInjectAgentGuide: () => false,
        getInjectMullionBundle: () => false,
      });
      const session = ungatedManager.getOrCreate({
        id: "2",
        cwd: "/tmp",
        command: "opencode",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      const call = vi
        .mocked(spawnChildProcess)
        .mock.calls.findLast(([file]) => file === "systemd-run");
      const opts = call?.[2] as { env?: Record<string, string> };
      expect(JSON.parse(opts.env!.OPENCODE_CONFIG_CONTENT)).toEqual({
        mcp: buildOpenCodeMcpConfig(
          resolveMcpServerPath(),
          ungatedManager.hookSocketPath,
          session.hookToken,
          ungatedManager.controlSocketPath,
        ),
        plugins: [path.join(sessionsDir, "2.opencode-config", "plugin")],
      });
      expect(opts.env).not.toHaveProperty("MULLION_OPENCODE_INSTRUCTIONS");
      // The plugin mechanism is unaffected by this gate.
      expect(
        fs.existsSync(path.join(sessionsDir, "2.opencode-config", "plugin", "server.js")),
      ).toBe(true);

      // This test's own manager, not the outer `manager` — same cleanup
      // reasoning as this describe block's other own-manager tests.
      ungatedManager.killAll();
    });

    // Issue #678 — the end-to-end proof the plumbing actually works: a
    // `seedPrompt` passed into getOrCreate() survives the full six-hop
    // chain (CreateSessionOptions -> Session's own field -> the
    // LaunchPlanSession literal buildLaunchPlan() receives -> ctx ->
    // openCodeAdapter.prepareLaunch()) and reaches the REAL env passed to
    // the spawned systemd-run process, not just a typechecked-but-untested
    // pass-through.
    it("delivers a seedPrompt to the opencode plugin's instruction files, independently of injectAgentGuide", async () => {
      // getInjectMullionBundle: () => false too — keeps this test's payload
      // isolated to the seed path, its own point, not also asserting on
      // the bundle's independently-gated skills.paths.
      const ungatedManager = new PtyManager({
        sessionsDir,
        getInjectAgentGuide: () => false,
        getInjectMullionBundle: () => false,
      });
      const session = ungatedManager.getOrCreate({
        id: "3",
        cwd: "/tmp",
        command: "opencode",
        cols: 80,
        rows: 24,
        seedPrompt: "resume the refactor",
      });
      await waitForSpawn(session);

      const seedPath = path.join(sessionsDir, "3.opencode-seed.md");
      expect(fs.existsSync(seedPath)).toBe(true);
      expect(fs.readFileSync(seedPath, "utf8")).toBe("resume the refactor");

      const call = vi
        .mocked(spawnChildProcess)
        .mock.calls.findLast(([file]) => file === "systemd-run");
      const opts = call?.[2] as { env?: Record<string, string> };
      expect(opts.env?.OPENCODE_CONFIG_CONTENT).toBeDefined();
      // injectAgentGuide is off on this manager, so only the seed path
      // should be present alongside the unconditional mcp entry (issue
      // #881) — proves the gate is independent of that setting.
      expect(JSON.parse(opts.env!.OPENCODE_CONFIG_CONTENT)).toEqual({
        mcp: buildOpenCodeMcpConfig(
          resolveMcpServerPath(),
          ungatedManager.hookSocketPath,
          session.hookToken,
          ungatedManager.controlSocketPath,
        ),
        plugins: [path.join(sessionsDir, "3.opencode-config", "plugin")],
      });
      expect(JSON.parse(opts.env!.MULLION_OPENCODE_INSTRUCTIONS)).toEqual([seedPath]);

      ungatedManager.killAll();
    });

    it("omits skills when the manager's getInjectMullionBundle reports the setting off, independently of injectAgentGuide", async () => {
      const bundlelessManager = new PtyManager({
        sessionsDir,
        getInjectMullionBundle: () => false,
      });
      const session = bundlelessManager.getOrCreate({
        id: "4",
        cwd: "/tmp",
        command: "opencode",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      const call = vi
        .mocked(spawnChildProcess)
        .mock.calls.findLast(([file]) => file === "systemd-run");
      const opts = call?.[2] as { env?: Record<string, string> };
      // injectAgentGuide still defaults to true on this manager, so
      // OPENCODE_CONFIG_CONTENT is still present — just without skills.
      // mcp.mullion is unconditional (issue #881), so it's present too.
      expect(JSON.parse(opts.env!.OPENCODE_CONFIG_CONTENT)).toEqual({
        mcp: buildOpenCodeMcpConfig(
          resolveMcpServerPath(),
          bundlelessManager.hookSocketPath,
          session.hookToken,
          bundlelessManager.controlSocketPath,
        ),
        plugins: [path.join(sessionsDir, "4.opencode-config", "plugin")],
      });
      expect(JSON.parse(opts.env!.MULLION_OPENCODE_INSTRUCTIONS)).toEqual([
        path.join(sessionsDir, "4.opencode-tier0.md"),
      ]);

      bundlelessManager.killAll();
    });

    describe("Codex (issue #252)", () => {
      let codexHome: string;
      const originalCodexHome = process.env.CODEX_HOME;
      const originalHome = process.env.HOME;

      beforeEach(() => {
        // Codex's adapter merges into the REAL $CODEX_HOME/hooks.json (see
        // codex.ts's own header comment for why it can't be ephemeral) —
        // this MUST be redirected to a scratch dir for the test, never the
        // real developer/CI-runner's own ~/.codex.
        codexHome = path.join(sessionsDir, "codex-home-scratch");
        process.env.CODEX_HOME = codexHome;
        // mergeCodexHooks() now also installs the forwarder shim at a
        // fixed os.homedir()-derived location (forwarder-shim.ts) — HOME
        // must be redirected too, or spawning "codex" for real here writes
        // into the developer/CI-runner's own ~/.mullion.
        process.env.HOME = path.join(sessionsDir, "fake-home-codex-252");
      });

      afterEach(() => {
        if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = originalCodexHome;
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
      });

      it("merges a managed hooks.json into $CODEX_HOME (not sessionsDir), and appends --add-dir .git + the MCP -c flags to the command (issue #906 + issue #880)", async () => {
        const session = manager.getOrCreate({
          id: "1",
          cwd: "/tmp",
          command: "codex",
          cols: 80,
          rows: 24,
        });
        await waitForSpawn(session);

        const hooksPath = path.join(codexHome, "hooks.json");
        // managedInstall() is fire-and-forget from the spawn seam's point of
        // view (see applyHookAdapters) — poll rather than assume it's done
        // by the time waitForSpawn resolves.
        for (let i = 0; i < 50 && !fs.existsSync(hooksPath); i++) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        expect(fs.existsSync(hooksPath)).toBe(true);
        const written = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
        expect(written.hooks.Stop).toHaveLength(1);
        expect(written.hooks.PostToolUse[0].matcher).toBe("apply_patch");

        const call = vi
          .mocked(spawnChildProcess)
          .mock.calls.findLast(([file]) => file === "systemd-run");
        const args = call?.[1] as string[];
        // Issue #880 — the managed hooks.json write (above) and the
        // ephemeral --add-dir .git + MCP -c flags (here) are independent
        // mechanisms on the same adapter; this is the one test proving all
        // three fire from a single real spawn, not just each in isolation
        // via its own adapter-level unit test.
        const mcpFlags = buildCodexMcpFlags(resolveMcpServerPath());
        expect(args[args.length - 1]).toBe(`codex --add-dir .git ${mcpFlags}`);
      });
    });
  });
});
