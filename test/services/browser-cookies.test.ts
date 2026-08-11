import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

// The DB-facing half of cookie import — browser-cookie-import.ts's actual
// host-file reading is mocked out here so this only exercises storage
// (encrypt-at-rest, upsert-by-label, most-recent-wins for launch).
vi.mock("../../src/services/browser-cookie-import.js", () => ({
  readBrowserCookies: vi.fn(),
}));

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { readBrowserCookies } = await import("../../src/services/browser-cookie-import.js");
const {
  importCookieProfile,
  listCookieProfiles,
  deleteCookieProfile,
  loadStoredCookiesForProject,
} = await import("../../src/services/browser-cookies.js");

const tmpDb = path.join(os.tmpdir(), `browser-cookies-test-${process.pid}.db`);

describe("browser-cookies", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.DB_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64url");
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.DB_ENCRYPTION_KEY;
  });

  async function createProject(app: Awaited<ReturnType<typeof buildApp>>) {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { createDir: true, name: "p", cwd: "/tmp" },
    });
    return res.json().id as number;
  }

  it("imports a profile, storing cookies encrypted at rest", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);
    vi.mocked(readBrowserCookies).mockReturnValue([
      { name: "sid", value: "abc", domain: "example.com", path: "/", httpOnly: true, secure: true },
    ]);

    const summary = importCookieProfile(app, projectId, {
      browser: "firefox",
      profilePath: "/fake/cookies.sqlite",
      label: "work",
    });

    expect(summary).toMatchObject({ projectId, label: "work", browser: "firefox", cookieCount: 1 });

    const { browserCookies } = await import("../../src/db/schema.js");
    const { eq } = await import("drizzle-orm");
    const [row] = app.db
      .select()
      .from(browserCookies)
      .where(eq(browserCookies.id, summary.id))
      .all();
    expect(row.cookiesEnc).not.toContain("sid"); // never stored in plaintext
    expect(row.cookiesEnc.startsWith("enc:")).toBe(true);

    await app.close();
  });

  it("upserts by (projectId, label) rather than accumulating rows on re-import", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);
    vi.mocked(readBrowserCookies).mockReturnValue([
      { name: "a", value: "1", domain: "x.com", path: "/", httpOnly: false, secure: false },
    ]);

    const first = importCookieProfile(app, projectId, {
      browser: "chrome",
      profilePath: "/fake/Cookies",
      label: "personal",
    });

    vi.mocked(readBrowserCookies).mockReturnValue([
      { name: "a", value: "1", domain: "x.com", path: "/", httpOnly: false, secure: false },
      { name: "b", value: "2", domain: "x.com", path: "/", httpOnly: false, secure: false },
    ]);
    const second = importCookieProfile(app, projectId, {
      browser: "chrome",
      profilePath: "/fake/Cookies",
      label: "personal",
    });

    expect(second.id).toBe(first.id);
    expect(second.cookieCount).toBe(2);
    expect(listCookieProfiles(app, projectId)).toHaveLength(1);

    await app.close();
  });

  it("supports multiple distinct profiles per project", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);
    vi.mocked(readBrowserCookies).mockReturnValue([]);

    importCookieProfile(app, projectId, { browser: "chrome", profilePath: "/a", label: "work" });
    importCookieProfile(app, projectId, {
      browser: "firefox",
      profilePath: "/b",
      label: "personal",
    });

    const profiles = listCookieProfiles(app, projectId);
    expect(profiles.map((p) => p.label).sort()).toEqual(["personal", "work"]);

    await app.close();
  });

  it("listCookieProfiles never exposes decrypted cookie values", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);
    vi.mocked(readBrowserCookies).mockReturnValue([
      {
        name: "secret",
        value: "super-sensitive",
        domain: "x.com",
        path: "/",
        httpOnly: true,
        secure: true,
      },
    ]);
    importCookieProfile(app, projectId, { browser: "chrome", profilePath: "/a", label: "work" });

    const profiles = listCookieProfiles(app, projectId);
    expect(JSON.stringify(profiles)).not.toContain("super-sensitive");
    expect(profiles[0]).not.toHaveProperty("cookiesEnc");

    await app.close();
  });

  it("deleteCookieProfile removes a profile scoped to its project", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);
    vi.mocked(readBrowserCookies).mockReturnValue([]);
    const summary = importCookieProfile(app, projectId, {
      browser: "chrome",
      profilePath: "/a",
      label: "work",
    });

    expect(deleteCookieProfile(app, projectId, summary.id)).toBe(true);
    expect(listCookieProfiles(app, projectId)).toEqual([]);
    // Deleting again (already gone) is a clean false, not a throw.
    expect(deleteCookieProfile(app, projectId, summary.id)).toBe(false);

    await app.close();
  });

  it("deleteCookieProfile does not delete a profile belonging to a different project", async () => {
    const app = await buildApp();
    const projectA = await createProject(app);
    const projectB = await createProject(app);
    vi.mocked(readBrowserCookies).mockReturnValue([]);
    const summary = importCookieProfile(app, projectA, {
      browser: "chrome",
      profilePath: "/a",
      label: "work",
    });

    expect(deleteCookieProfile(app, projectB, summary.id)).toBe(false);
    expect(listCookieProfiles(app, projectA)).toHaveLength(1);

    await app.close();
  });

  it("loadStoredCookiesForProject returns [] when no profile is stored", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    expect(loadStoredCookiesForProject(app, projectId)).toEqual([]);

    await app.close();
  });

  it("loadStoredCookiesForProject applies the most recently imported profile", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);

    vi.mocked(readBrowserCookies).mockReturnValue([
      { name: "old", value: "1", domain: "x.com", path: "/", httpOnly: false, secure: false },
    ]);
    importCookieProfile(app, projectId, {
      browser: "chrome",
      profilePath: "/a",
      label: "personal",
    });

    // "Most recent" is decided by id when two imports land in the same
    // second (importedAt's column mode is second-granularity) — no
    // wall-clock wait needed for this to be deterministic.
    vi.mocked(readBrowserCookies).mockReturnValue([
      { name: "new", value: "2", domain: "x.com", path: "/", httpOnly: false, secure: false },
    ]);
    importCookieProfile(app, projectId, { browser: "firefox", profilePath: "/b", label: "work" });

    const cookies = loadStoredCookiesForProject(app, projectId);
    expect(cookies).toEqual([
      { name: "new", value: "2", domain: "x.com", path: "/", httpOnly: false, secure: false },
    ]);

    await app.close();
  });

  it("loadStoredCookiesForProject returns [] and logs a warning on a decrypt failure", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);
    vi.mocked(readBrowserCookies).mockReturnValue([
      { name: "a", value: "1", domain: "x.com", path: "/", httpOnly: false, secure: false },
    ]);
    importCookieProfile(app, projectId, { browser: "chrome", profilePath: "/a", label: "work" });

    const decryptSpy = vi.spyOn(app.encryption, "decryptJson").mockImplementation(() => {
      throw new Error("bad ciphertext");
    });
    const warnSpy = vi.spyOn(app.log, "warn");

    expect(loadStoredCookiesForProject(app, projectId)).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();

    decryptSpy.mockRestore();
    await app.close();
  });

  // Finding AS14: decryptJson now distinguishes "decryption succeeded but
  // the plaintext wasn't valid JSON" (returns null) from a genuine decrypt
  // failure (throws). This caller must treat the null case the same way it
  // already treats a thrown DecryptionError — log and fall back to [],
  // never cast null into an ImportedCookie[] and hand it to a consumer that
  // will iterate it.
  it("loadStoredCookiesForProject returns [] and logs a warning when decryptJson returns null", async () => {
    const app = await buildApp();
    const projectId = await createProject(app);
    vi.mocked(readBrowserCookies).mockReturnValue([
      { name: "a", value: "1", domain: "x.com", path: "/", httpOnly: false, secure: false },
    ]);
    importCookieProfile(app, projectId, { browser: "chrome", profilePath: "/a", label: "work" });

    const decryptSpy = vi.spyOn(app.encryption, "decryptJson").mockReturnValue(null);
    const warnSpy = vi.spyOn(app.log, "warn");

    expect(loadStoredCookiesForProject(app, projectId)).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();

    decryptSpy.mockRestore();
    await app.close();
  });
});
