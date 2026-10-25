import { describe, it, expect } from "vitest";
import { schema } from "../../src/plugins/env.js";
import { isReservedSessionEnvKey } from "../../src/services/session-env-keys.js";
import {
  GIT_CONFIG_NO_AUTO_GC_ENV,
  HOST_DISPLAY_ENV_KEYS,
  SERVER_ENV_KEYS,
  SESSION_ENV_PASSTHROUGH_KEYS,
  buildSessionEnv,
} from "../../src/services/session-env.js";

describe("session-env", () => {
  describe("buildSessionEnv", () => {
    it("strips every key in SERVER_ENV_KEYS", () => {
      const base: NodeJS.ProcessEnv = {};
      for (const key of SERVER_ENV_KEYS) base[key] = "leaked";

      const result = buildSessionEnv(base);

      for (const key of SERVER_ENV_KEYS) {
        expect(result).not.toHaveProperty(key);
      }
    });

    it("strips or explicitly allowlists every key in the env schema", () => {
      const stripped = new Set<string>(SERVER_ENV_KEYS);
      const allowed = new Set<string>(SESSION_ENV_PASSTHROUGH_KEYS);
      const unaccounted = Object.keys(schema.properties).filter(
        (k) => !stripped.has(k) && !allowed.has(k),
      );
      // A new schema key that is generic (a name user tools read) belongs in
      // SESSION_ENV_PASSTHROUGH_KEYS; anything else is stripped automatically.
      expect(unaccounted).toEqual([]);
      // The allowlist must not carry stale entries.
      for (const k of allowed) expect(schema.properties).toHaveProperty(k);
    });

    it("strips Mullion-owned schema keys that once leaked into sessions", () => {
      const leaked = [
        "MULLION_WEBHOOK_SECRET",
        "MULLION_TASK_MASTER_ENABLED",
        "MULLION_TASK_TRUSTED_LOGINS",
        "MULLION_TRUST_GATEWAY",
        "MULLION_SERVICE_UNIT",
        "BROWSER_DATA_DIR",
        "DEVICE_ADB_PATH",
        "GITHUB_POLL_INTERVAL_ACTIVE",
        "PREVIEW_AUTH_REQUIRED",
      ];
      const base: NodeJS.ProcessEnv = Object.fromEntries(leaked.map((k) => [k, "leaked"]));
      expect(buildSessionEnv(base)).toEqual({
        COLORTERM: "truecolor",
        TERM: "xterm-256color",
        // Issue #1851 — the gc.auto override every session carries.
        ...GIT_CONFIG_NO_AUTO_GC_ENV,
      });
    });

    it("passes HOST and LOG_LEVEL through", () => {
      const result = buildSessionEnv({ HOST: "myhost", LOG_LEVEL: "debug" });
      expect(result.HOST).toBe("myhost");
      expect(result.LOG_LEVEL).toBe("debug");
    });

    it("preserves generic vars a child process may rely on", () => {
      const base: NodeJS.ProcessEnv = {
        PATH: "/usr/bin:/bin",
        HOME: "/home/dev",
        SHELL: "/bin/bash",
        LOG_LEVEL: "debug",
      };

      const result = buildSessionEnv(base);

      // TERM is not in this list: unlike PATH/HOME/SHELL/LOG_LEVEL it is
      // always overwritten (see the TERM-forcing tests below), same
      // treatment as COLORTERM.
      expect(result).toEqual({
        ...base,
        COLORTERM: "truecolor",
        TERM: "xterm-256color",
        // Issue #1851 — the gc.auto override every session carries.
        ...GIT_CONFIG_NO_AUTO_GC_ENV,
      });
    });

    it("strips host display vars so TUIs fall back to OSC 52 for copy", () => {
      const result = buildSessionEnv({
        PATH: "/usr/bin",
        DISPLAY: ":0",
        WAYLAND_DISPLAY: "wayland-mullion",
        XAUTHORITY: "/home/dev/.Xauthority",
      });
      for (const key of HOST_DISPLAY_ENV_KEYS) expect(result).not.toHaveProperty(key);
      expect(result.PATH).toBe("/usr/bin");
    });

    it("does not reserve display vars, so session.env can opt back in", () => {
      for (const key of HOST_DISPLAY_ENV_KEYS) expect(isReservedSessionEnvKey(key)).toBe(false);
    });

    it("always forces COLORTERM=truecolor, overriding any inherited value (issue #91)", () => {
      const result = buildSessionEnv({ PATH: "/usr/bin", COLORTERM: "" });

      expect(result.COLORTERM).toBe("truecolor");
    });

    // Issue #1851 — an agent CLI's own `git commit` in the user's clone
    // triggers the same background gc that GIT_NO_AUTO_GC stops Mullion's own
    // commands from triggering, and Mullion is what launches the agent. So the
    // override rides in the SESSION's env: env-scoped, so the user's clone
    // config is untouched and it ends with the session.
    it("sets the gc.auto override for the session (issue #1851)", () => {
      const result = buildSessionEnv({});
      expect(result.GIT_CONFIG_COUNT).toBe("1");
      expect(result.GIT_CONFIG_KEY_0).toBe("gc.auto");
      expect(result.GIT_CONFIG_VALUE_0).toBe("0");
    });

    it("does not inherit an ambient gc.auto override (issue #1851)", () => {
      // The scrub removes any ambient GIT_CONFIG_COUNT — git reads only
      // indices 0..COUNT-1, so removing COUNT disables the whole mechanism —
      // and the session's own pair is then set on top.
      const result = buildSessionEnv({
        GIT_CONFIG_COUNT: "3",
        GIT_CONFIG_KEY_0: "core.bare",
        GIT_CONFIG_VALUE_0: "true",
        GIT_CONFIG_KEY_1: "gc.auto",
        GIT_CONFIG_VALUE_1: "1",
      });
      expect(result.GIT_CONFIG_COUNT).toBe("1");
      expect(result.GIT_CONFIG_KEY_0).toBe("gc.auto");
      expect(result.GIT_CONFIG_VALUE_0).toBe("0");
    });

    it("keeps the override when a session's own env is applied on top (issue #1851)", () => {
      // launch-plan.ts applies session.env AFTER buildSessionEnv()'s scrub,
      // so the reserved-key check is what stops a session from turning the
      // protection back off.
      const sessionEnv = buildSessionEnv({});
      expect(isReservedSessionEnvKey("GIT_CONFIG_COUNT")).toBe(true);
      expect(isReservedSessionEnvKey("GIT_CONFIG_KEY_0")).toBe(true);
      expect(isReservedSessionEnvKey("GIT_CONFIG_VALUE_0")).toBe(true);
      expect(sessionEnv.GIT_CONFIG_KEY_0).toBe("gc.auto");
    });

    it("always forces TERM=xterm-256color, including when inherited TERM is absent (issue #305)", () => {
      // The server process itself has no TERM when running as a systemd
      // --user service, and TERM previously passed through unchanged into
      // the session shell — confirmed to break color-capability detection in
      // agy (Antigravity CLI), which falls back to no color when it sees
      // TERM="".
      const result = buildSessionEnv({ PATH: "/usr/bin" });

      expect(result.TERM).toBe("xterm-256color");
    });

    it("overrides an inherited TERM rather than passing it through (issue #305)", () => {
      const result = buildSessionEnv({ PATH: "/usr/bin", TERM: "dumb" });

      expect(result.TERM).toBe("xterm-256color");
    });

    it("strips NODE_ENV even though it's a generic Node convention, not a Mullion key", () => {
      // Inheriting the server's NODE_ENV=production would make npm
      // install/ci inside the session skip devDependencies — breaking the
      // "run a dev checkout from inside a Mullion session" workflow.
      const base: NodeJS.ProcessEnv = { NODE_ENV: "production", PATH: "/usr/bin" };

      const result = buildSessionEnv(base);

      expect(result).not.toHaveProperty("NODE_ENV");
      expect(result.PATH).toBe("/usr/bin");
    });

    it("does not mutate the base object", () => {
      const base: NodeJS.ProcessEnv = { PORT: "3100", PATH: "/usr/bin" };
      const snapshot = { ...base };

      buildSessionEnv(base);

      expect(base).toEqual(snapshot);
    });

    it("defaults to process.env when called with no argument", () => {
      const original = process.env.PORT;
      process.env.PORT = "3100";
      try {
        const result = buildSessionEnv();
        expect(result).not.toHaveProperty("PORT");
        // process.env itself is untouched — only the returned copy is scrubbed.
        expect(process.env.PORT).toBe("3100");
      } finally {
        if (original === undefined) delete process.env.PORT;
        else process.env.PORT = original;
      }
    });

    it("strips MULLION_HOOK_SOCKET/MULLION_HOOK_TOKEN (issue #172) so a nested Mullion re-scrubs them", () => {
      // These two are injected into a session's env deliberately, per-session,
      // by pty-manager.ts AFTER buildSessionEnv() returns — listed in
      // SERVER_ENV_KEYS purely so a *nested* Mullion (a `make dev` run from
      // inside a session that itself has hooks enabled) doesn't inherit the
      // outer session's socket path/token as if it were its own.
      const base: NodeJS.ProcessEnv = {
        PATH: "/usr/bin",
        MULLION_HOOK_SOCKET: "/data/sessions/hooks.sock",
        MULLION_HOOK_TOKEN: "leaked-token",
      };

      const result = buildSessionEnv(base);

      expect(result).not.toHaveProperty("MULLION_HOOK_SOCKET");
      expect(result).not.toHaveProperty("MULLION_HOOK_TOKEN");
      expect(result.PATH).toBe("/usr/bin");
    });

    it("strips MULLION_OPENCODE_INSTRUCTIONS so a nested Mullion never injects the outer session's guide/briefing files", () => {
      const result = buildSessionEnv({
        PATH: "/usr/bin",
        MULLION_OPENCODE_INSTRUCTIONS: '["/data/sessions/9.opencode-tier0.md"]',
      });
      expect(result).not.toHaveProperty("MULLION_OPENCODE_INSTRUCTIONS");
      expect(result.PATH).toBe("/usr/bin");
    });

    it("strips MULLION_SOCKET_PATH/MULLION_SESSION_ID (Phase 4, #134) so a nested Mullion re-scrubs them", () => {
      // Same reasoning as the hook socket/token above — injected
      // per-session by pty-manager.ts AFTER buildSessionEnv() returns, so a
      // nested Mullion must not inherit the outer session's control socket
      // path or session id as if it were its own.
      const base: NodeJS.ProcessEnv = {
        PATH: "/usr/bin",
        MULLION_SOCKET_PATH: "/data/sessions/mullion.sock",
        MULLION_SESSION_ID: "42",
      };

      const result = buildSessionEnv(base);

      expect(result).not.toHaveProperty("MULLION_SOCKET_PATH");
      expect(result).not.toHaveProperty("MULLION_SESSION_ID");
      expect(result.PATH).toBe("/usr/bin");
    });

    it("strips MULLION_SSH_AUTH_SOCK so a nested Mullion re-scrubs it", () => {
      // The config key that names the path launch-plan.ts injects as
      // SSH_AUTH_SOCK — must be stripped so a nested Mullion (a `make dev`
      // run from inside a bridge-enabled session) doesn't inherit the outer
      // process's configured path as if it were its own.
      const base: NodeJS.ProcessEnv = {
        PATH: "/usr/bin",
        MULLION_SSH_AUTH_SOCK: "/data/sessions/ssh-agent.sock",
      };

      const result = buildSessionEnv(base);

      expect(result).not.toHaveProperty("MULLION_SSH_AUTH_SOCK");
      expect(result.PATH).toBe("/usr/bin");
    });

    it("does NOT strip SSH_AUTH_SOCK itself — it's overwritten (or left alone) by launch-plan.ts, not by the scrub", () => {
      // Unlike MULLION_SSH_AUTH_SOCK above, the derived SSH_AUTH_SOCK is
      // deliberately absent from SERVER_ENV_KEYS (see the "Deliberately NOT
      // stripped" comment): a session whose feature is off should still get
      // whatever agent it already had (e.g. a local gpg-agent) passed
      // through untouched.
      const base: NodeJS.ProcessEnv = {
        PATH: "/usr/bin",
        SSH_AUTH_SOCK: "/run/user/1000/gnupg/S.gpg-agent.ssh",
      };

      const result = buildSessionEnv(base);

      expect(result.SSH_AUTH_SOCK).toBe("/run/user/1000/gnupg/S.gpg-agent.ssh");
    });

    it("strips leaked GIT_* vars from the server process (A7)", () => {
      // git-env.ts's gitEnv() protects every backend git subprocess from a
      // leaked GIT_DIR/GIT_INDEX_FILE (the real incident that motivated
      // git-env.ts existing at all). But a session's shell is spawned via
      // buildSessionEnv(), not gitEnv() — if the *server* process itself was
      // started with one of these leaked, every git command an agent runs
      // inside a session would silently target the wrong repo unless
      // buildSessionEnv() also strips them.
      const base: NodeJS.ProcessEnv = {
        PATH: "/usr/bin",
        GIT_DIR: "/tmp/decoy.git",
        GIT_WORK_TREE: "/tmp/decoy",
        GIT_INDEX_FILE: "/tmp/decoy.git/index",
        GIT_CEILING_DIRECTORIES: "/tmp",
        GIT_OBJECT_DIRECTORY: "/tmp/decoy.git/objects",
        GIT_COMMON_DIR: "/tmp/decoy.git",
        GIT_PREFIX: "sub/",
        GIT_CONFIG_GLOBAL: "/tmp/decoy.gitconfig",
        GIT_CONFIG_SYSTEM: "/tmp/decoy-system.gitconfig",
      };

      const result = buildSessionEnv(base);

      expect(result).not.toHaveProperty("GIT_DIR");
      expect(result).not.toHaveProperty("GIT_WORK_TREE");
      expect(result).not.toHaveProperty("GIT_INDEX_FILE");
      expect(result).not.toHaveProperty("GIT_CEILING_DIRECTORIES");
      expect(result).not.toHaveProperty("GIT_OBJECT_DIRECTORY");
      expect(result).not.toHaveProperty("GIT_COMMON_DIR");
      expect(result).not.toHaveProperty("GIT_PREFIX");
      expect(result).not.toHaveProperty("GIT_CONFIG_GLOBAL");
      expect(result).not.toHaveProperty("GIT_CONFIG_SYSTEM");
      expect(result.PATH).toBe("/usr/bin");
    });

    it("realistic case: a production-inherited env is fully scrubbed of Mullion config", () => {
      const inherited: NodeJS.ProcessEnv = {
        PATH: "/usr/bin:/bin",
        HOME: "/home/bjoern",
        SHELL: "/bin/bash",
        PORT: "3100",
        DATABASE_URL: "file:/home/bjoern/opt/mullion/data/app.db",
        SESSIONS_DIR: "/home/bjoern/opt/mullion/data/sessions",
        DB_ENCRYPTION_KEY: "super-secret",
        MULLION_HOME: "/home/bjoern/opt/mullion",
      };

      const result = buildSessionEnv(inherited);

      expect(result).toEqual({
        PATH: "/usr/bin:/bin",
        HOME: "/home/bjoern",
        SHELL: "/bin/bash",
        COLORTERM: "truecolor",
        TERM: "xterm-256color",
        // Issue #1851 — the gc.auto override every session carries.
        ...GIT_CONFIG_NO_AUTO_GC_ENV,
      });
    });
  });
});
