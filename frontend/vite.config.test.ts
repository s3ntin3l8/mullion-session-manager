import { describe, it, expect, afterEach, vi } from "vitest";
import type { UserConfigFn } from "vite";
import configExport from "./vite.config.js";

// vite.config.ts's default export is the callback form (needs `command` and
// `mode` to decide whether to correct a leaked NODE_ENV=production) rather
// than a plain UserConfig object.
const config = configExport as UserConfigFn;

describe("vite.config dev NODE_ENV guard (#105)", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    vi.restoreAllMocks();
  });

  it("corrects a leaked NODE_ENV=production to development for `vite dev`", async () => {
    process.env.NODE_ENV = "production";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await config({ command: "serve", mode: "development" });

    // Otherwise @vitejs/plugin-react drops the Fast-Refresh preamble (it
    // gates that on isProduction) while still emitting $RefreshReg$
    // registrations in every module — ReferenceError + blank screen.
    expect(process.env.NODE_ENV).toBe("development");
    expect(warn).toHaveBeenCalledOnce();
  });

  it("honors an explicit non-production --mode instead of hardcoding development", async () => {
    process.env.NODE_ENV = "production";
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await config({ command: "serve", mode: "staging" });

    expect(process.env.NODE_ENV).toBe("staging");
  });

  it("leaves NODE_ENV untouched for a production build", async () => {
    process.env.NODE_ENV = "production";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await config({ command: "build", mode: "production" });

    expect(process.env.NODE_ENV).toBe("production");
    expect(warn).not.toHaveBeenCalled();
  });

  it("leaves an explicit production dev-server mode alone (no false-positive warning)", async () => {
    process.env.NODE_ENV = "production";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await config({ command: "serve", mode: "production" });

    expect(process.env.NODE_ENV).toBe("production");
    expect(warn).not.toHaveBeenCalled();
  });

  it("leaves an already-correct NODE_ENV alone", async () => {
    process.env.NODE_ENV = "development";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await config({ command: "serve", mode: "development" });

    expect(process.env.NODE_ENV).toBe("development");
    expect(warn).not.toHaveBeenCalled();
  });
});
