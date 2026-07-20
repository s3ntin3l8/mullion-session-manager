import { describe, it, expect, afterEach } from "vitest";
import type { UserConfigFn } from "vite";
import configExport from "./vite.config.js";

// vite.config.ts's default export is the callback form (needs `command` to
// decide whether to correct a leaked NODE_ENV=production) rather than a
// plain UserConfig object.
const config = configExport as UserConfigFn;

describe("vite.config dev NODE_ENV guard (#105)", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("corrects a leaked NODE_ENV=production to development for `vite dev`", async () => {
    process.env.NODE_ENV = "production";

    await config({ command: "serve", mode: "development" });

    // Otherwise @vitejs/plugin-react drops the Fast-Refresh preamble (it
    // gates that on isProduction) while still emitting $RefreshReg$
    // registrations in every module — ReferenceError + blank screen.
    expect(process.env.NODE_ENV).toBe("development");
  });

  it("leaves NODE_ENV untouched for a production build", async () => {
    process.env.NODE_ENV = "production";

    await config({ command: "build", mode: "production" });

    expect(process.env.NODE_ENV).toBe("production");
  });

  it("leaves an already-correct NODE_ENV alone", async () => {
    process.env.NODE_ENV = "development";

    await config({ command: "serve", mode: "development" });

    expect(process.env.NODE_ENV).toBe("development");
  });
});
