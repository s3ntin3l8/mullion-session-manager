import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import type { UserConfigFn } from "vite";
import configExport from "./vite.config.js";

// vite.config.ts's default export is the callback form (needs `command` and
// `mode` to decide whether to correct a leaked NODE_ENV=production) rather
// than a plain UserConfig object.
const config = configExport as UserConfigFn;

// vite-plugin-pwa's own workbox-build machinery isn't something a unit test
// should invoke for real (it shells out to esbuild/rollup and writes files);
// mocking the module and capturing what vite.config.ts passes to VitePWA()
// is the precise, fast way to pin the *options*, which is what the
// index.html precache regression below is actually about.
interface VitePwaWorkboxOptions {
  workbox: { globIgnores: string[]; navigateFallback: unknown };
}
const vitePwaMock = vi.fn((_options: VitePwaWorkboxOptions) => [] as const);
vi.mock("vite-plugin-pwa", () => ({
  VitePWA: (options: VitePwaWorkboxOptions) => vitePwaMock(options),
}));

describe("vite.config VitePWA workbox options (forward-auth session recovery)", () => {
  beforeEach(() => {
    vitePwaMock.mockClear();
  });

  // Regression test for the production incident: a service worker
  // precaching index.html made PrecacheRoute's directoryIndex resolution
  // answer every navigation to "/" from Cache Storage, cache-first, so a
  // plain browser refresh never reached the network — and therefore never
  // reached Traefik/Authentik's forward-auth redirect, the only thing that
  // can re-mint an expired proxy session cookie. See vite.config.ts's own
  // long comment on `runtimeCaching` for the full mechanism. This test pins
  // the config that closes it; it does NOT re-verify the mechanism itself
  // (that's an integration/production concern), only that nobody
  // accidentally removes the fix.
  it("excludes index.html from the workbox precache manifest", async () => {
    await config({ command: "build", mode: "production" });

    expect(vitePwaMock).toHaveBeenCalledOnce();
    const options = vitePwaMock.mock.calls[0][0];
    expect(options.workbox.globIgnores).toContain("**/index.html");
    // navigateFallback must stay null — see the comment in vite.config.ts:
    // re-enabling it would invent a NavigationRoute serving index.html for
    // paths the server itself 404s, a different bug with the same symptom.
    expect(options.workbox.navigateFallback).toBeNull();
  });

  it("still excludes push-sw.js from the precache manifest (unrelated to this fix)", async () => {
    await config({ command: "build", mode: "production" });

    const options = vitePwaMock.mock.calls[0][0];
    expect(options.workbox.globIgnores).toContain("**/push-sw.js");
  });
});

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
