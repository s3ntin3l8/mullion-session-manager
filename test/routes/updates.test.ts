import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as ChildProcess from "node:child_process";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { clearUpdateCheckCacheForTests } from "../../src/services/update-checker.js";

// The apply endpoint launches scripts/self-update.sh via a detached
// `systemd-run --user --scope` child (mirroring pty-manager.ts's
// bootstrapMaster) — mocked here so tests assert the argv it would launch
// with instead of actually spawning a real subprocess. vi.mock's factory is
// hoisted above every import/const in this file, so spawnMock itself must
// be created via vi.hoisted() — a plain `const spawnMock = vi.fn()` above
// this call would still be in its temporal dead zone when the factory runs.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return { ...actual, spawn: spawnMock };
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const tmpDb = path.join(os.tmpdir(), `updates-test-${process.pid}.db`);
const VALID_ASSET_URL =
  "https://github.com/s3ntin3l8/tessera-session-manager/releases/download/v0.1.5/tessera-0.1.5.tgz";

describe("updates route", () => {
  let tesseraHome: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  beforeEach(() => {
    tesseraHome = fs.mkdtempSync(path.join(os.tmpdir(), "updates-test-home-"));
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    clearUpdateCheckCacheForTests();
    spawnMock.mockReset();
    spawnMock.mockReturnValue({ on: vi.fn(), unref: vi.fn() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.TESSERA_HOME;
    fs.rmSync(tesseraHome, { recursive: true, force: true });
  });

  describe("GET /api/updates/check", () => {
    it("reports applyAvailable: false when TESSERA_HOME is unset (a dev checkout)", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { tag_name: "v0.1.4" }));
      const app = await buildApp();

      const res = await app.inject({ method: "GET", url: "/api/updates/check" });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ applyAvailable: false });
      await app.close();
    });

    it("reports applyAvailable: true when TESSERA_HOME is set", async () => {
      process.env.TESSERA_HOME = tesseraHome;
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { tag_name: "v0.1.4" }));
      const app = await buildApp();

      const res = await app.inject({ method: "GET", url: "/api/updates/check" });

      expect(res.json()).toMatchObject({ applyAvailable: true });
      await app.close();
    });

    it("reports an available update from the latest release", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          tag_name: "v99.0.0",
          html_url: "https://github.com/x/y/releases/tag/v99.0.0",
          assets: [{ name: "tessera-99.0.0.tgz", browser_download_url: VALID_ASSET_URL }],
        }),
      );
      const app = await buildApp();

      const res = await app.inject({ method: "GET", url: "/api/updates/check" });

      expect(res.json()).toMatchObject({
        latestVersion: "99.0.0",
        updateAvailable: true,
        assetUrl: VALID_ASSET_URL,
      });
      await app.close();
    });

    it("returns 502 when the GitHub releases lookup fails", async () => {
      fetchMock.mockResolvedValueOnce(new Response("nope", { status: 500 }));
      const app = await buildApp();

      const res = await app.inject({ method: "GET", url: "/api/updates/check" });

      expect(res.statusCode).toBe(502);
      await app.close();
    });
  });

  describe("GET /api/updates/status", () => {
    it("reports 'unavailable' when TESSERA_HOME is unset", async () => {
      const app = await buildApp();

      const res = await app.inject({ method: "GET", url: "/api/updates/status" });

      expect(res.json()).toEqual({ phase: "unavailable" });
      await app.close();
    });

    it("reports 'idle' when TESSERA_HOME is set but no update has ever run", async () => {
      process.env.TESSERA_HOME = tesseraHome;
      const app = await buildApp();

      const res = await app.inject({ method: "GET", url: "/api/updates/status" });

      expect(res.json()).toEqual({ phase: "idle" });
      await app.close();
    });

    it("reflects the current contents of .update-status.json", async () => {
      process.env.TESSERA_HOME = tesseraHome;
      fs.writeFileSync(
        path.join(tesseraHome, ".update-status.json"),
        JSON.stringify({ phase: "installing", version: "0.1.5", updatedAt: 12345 }),
      );
      const app = await buildApp();

      const res = await app.inject({ method: "GET", url: "/api/updates/status" });

      expect(res.json()).toMatchObject({ phase: "installing", version: "0.1.5" });
      await app.close();
    });
  });

  describe("POST /api/updates/apply", () => {
    it("refuses when TESSERA_HOME is unset", async () => {
      const app = await buildApp();

      const res = await app.inject({
        method: "POST",
        url: "/api/updates/apply",
        payload: { version: "0.1.5", assetUrl: VALID_ASSET_URL },
      });

      expect(res.statusCode).toBe(400);
      expect(spawnMock).not.toHaveBeenCalled();
      await app.close();
    });

    it("rejects a malformed body (bad version pattern)", async () => {
      process.env.TESSERA_HOME = tesseraHome;
      const app = await buildApp();

      const res = await app.inject({
        method: "POST",
        url: "/api/updates/apply",
        payload: { version: "not-a-version", assetUrl: VALID_ASSET_URL },
      });

      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("rejects an assetUrl that isn't hosted on github.com", async () => {
      process.env.TESSERA_HOME = tesseraHome;
      const app = await buildApp();

      const res = await app.inject({
        method: "POST",
        url: "/api/updates/apply",
        payload: { version: "0.1.5", assetUrl: "https://evil.example.com/payload.tgz" },
      });

      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("refuses with 409 when an update is already in progress", async () => {
      process.env.TESSERA_HOME = tesseraHome;
      fs.writeFileSync(
        path.join(tesseraHome, ".update-status.json"),
        JSON.stringify({ phase: "installing", version: "0.1.4" }),
      );
      const app = await buildApp();

      const res = await app.inject({
        method: "POST",
        url: "/api/updates/apply",
        payload: { version: "0.1.5", assetUrl: VALID_ASSET_URL },
      });

      expect(res.statusCode).toBe(409);
      expect(spawnMock).not.toHaveBeenCalled();
      await app.close();
    });

    it("returns 500 when this release predates self-update.sh", async () => {
      process.env.TESSERA_HOME = tesseraHome;
      // No current/scripts/self-update.sh created — simulates an install
      // whose currently-running release shipped before this feature.
      const app = await buildApp();

      const res = await app.inject({
        method: "POST",
        url: "/api/updates/apply",
        payload: { version: "0.1.5", assetUrl: VALID_ASSET_URL },
      });

      expect(res.statusCode).toBe(500);
      expect(spawnMock).not.toHaveBeenCalled();
      await app.close();
    });

    it("launches self-update.sh detached via systemd-run and returns 202", async () => {
      process.env.TESSERA_HOME = tesseraHome;
      const scriptDir = path.join(tesseraHome, "current", "scripts");
      fs.mkdirSync(scriptDir, { recursive: true });
      const scriptPath = path.join(scriptDir, "self-update.sh");
      fs.writeFileSync(scriptPath, "#!/usr/bin/env bash\n");
      const app = await buildApp();

      const res = await app.inject({
        method: "POST",
        url: "/api/updates/apply",
        payload: { version: "0.1.5", assetUrl: VALID_ASSET_URL },
      });

      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject({ phase: "downloading", version: "0.1.5" });

      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [command, argv, opts] = spawnMock.mock.calls[0];
      expect(command).toBe("systemd-run");
      expect(argv).toEqual([
        "--user",
        "--scope",
        "--collect",
        "-u",
        "tessera-update-0.1.5",
        "--",
        scriptPath,
        "0.1.5",
        VALID_ASSET_URL,
        tesseraHome,
        process.execPath,
      ]);
      expect(opts).toMatchObject({ cwd: tesseraHome, stdio: "ignore" });

      await app.close();
    });
  });
});
