import { describe, it, expect } from "vitest";
import { SERVER_ENV_KEYS, buildSessionEnv } from "../../src/services/session-env.js";

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
      expect(result).toEqual({ ...base, COLORTERM: "truecolor", TERM: "xterm-256color" });
    });

    it("always forces COLORTERM=truecolor, overriding any inherited value (issue #91)", () => {
      const result = buildSessionEnv({ PATH: "/usr/bin", COLORTERM: "" });

      expect(result.COLORTERM).toBe("truecolor");
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
      });
    });
  });
});
