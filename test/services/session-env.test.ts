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
        TERM: "xterm-256color",
        LOG_LEVEL: "debug",
      };

      const result = buildSessionEnv(base);

      expect(result).toEqual({ ...base, COLORTERM: "truecolor" });
    });

    it("always forces COLORTERM=truecolor, overriding any inherited value (issue #91)", () => {
      const result = buildSessionEnv({ PATH: "/usr/bin", COLORTERM: "" });

      expect(result.COLORTERM).toBe("truecolor");
    });

    it("strips NODE_ENV even though it's a generic Node convention, not a Tessera key", () => {
      // Inheriting the server's NODE_ENV=production would make npm
      // install/ci inside the session skip devDependencies — breaking the
      // "run a dev checkout from inside a Tessera session" workflow.
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

    it("realistic case: a production-inherited env is fully scrubbed of Tessera config", () => {
      const inherited: NodeJS.ProcessEnv = {
        PATH: "/usr/bin:/bin",
        HOME: "/home/bjoern",
        SHELL: "/bin/bash",
        PORT: "3100",
        DATABASE_URL: "file:/home/bjoern/opt/tessera/data/app.db",
        SESSIONS_DIR: "/home/bjoern/opt/tessera/data/sessions",
        DB_ENCRYPTION_KEY: "super-secret",
        TESSERA_HOME: "/home/bjoern/opt/tessera",
      };

      const result = buildSessionEnv(inherited);

      expect(result).toEqual({
        PATH: "/usr/bin:/bin",
        HOME: "/home/bjoern",
        SHELL: "/bin/bash",
        COLORTERM: "truecolor",
      });
    });
  });
});
