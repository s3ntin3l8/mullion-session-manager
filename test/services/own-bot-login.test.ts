// resolveOwnBotLogin: the App's own bot login, from the persisted slug or one
// lazy `GET /app`. Real DB; only the network call is mocked.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import type * as GithubAppModule from "../../src/services/github-app.js";

const mockGetAuthenticatedApp = vi.hoisted(() => vi.fn());
vi.mock("../../src/services/github-app.js", async (importOriginal) => ({
  ...(await importOriginal<typeof GithubAppModule>()),
  getAuthenticatedApp: mockGetAuthenticatedApp,
}));

import { eq } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { integrations } from "../../src/db/schema.js";
import {
  clearGitHubApp,
  resolveOwnBotLogin,
  setGitHubApp,
} from "../../src/services/github-integration.js";

const tmpDb = path.join(os.tmpdir(), `own-bot-login-test-${process.pid}.db`);
const { privateKey: KEY } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

describe("resolveOwnBotLogin", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  const slugInDb = () =>
    app.db.select().from(integrations).where(eq(integrations.provider, "github")).get()
      ?.githubAppSlug;

  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });
  beforeEach(() => {
    mockGetAuthenticatedApp.mockReset();
    clearGitHubApp(app);
  });

  it("is null with no App configured", async () => {
    expect(await resolveOwnBotLogin(app)).toBeNull();
  });

  it("uses the slug saved at configure time without a network call", async () => {
    setGitHubApp(app, "11", KEY, "github", "My-App");
    expect(await resolveOwnBotLogin(app)).toBe("my-app[bot]");
    expect(mockGetAuthenticatedApp).not.toHaveBeenCalled();
  });

  it("fetches and saves the slug for an App configured before it was stored", async () => {
    setGitHubApp(app, "22", KEY);
    mockGetAuthenticatedApp.mockResolvedValue({ id: 22, slug: "late-app", name: "x" });
    expect(await resolveOwnBotLogin(app)).toBe("late-app[bot]");
    expect(slugInDb()).toBe("late-app");
    await resolveOwnBotLogin(app);
    expect(mockGetAuthenticatedApp).toHaveBeenCalledTimes(1);
  });

  it("returns null and backs off after a failed lookup", async () => {
    setGitHubApp(app, "33", KEY);
    mockGetAuthenticatedApp.mockRejectedValue(new Error("down"));
    expect(await resolveOwnBotLogin(app)).toBeNull();
    expect(await resolveOwnBotLogin(app)).toBeNull();
    expect(mockGetAuthenticatedApp).toHaveBeenCalledTimes(1);
    expect(slugInDb()).toBeNull();
  });

  it("does not trust a slug GitHub reports for a different App id", async () => {
    setGitHubApp(app, "44", KEY);
    mockGetAuthenticatedApp.mockResolvedValue({ id: 99, slug: "other", name: "x" });
    expect(await resolveOwnBotLogin(app)).toBeNull();
    expect(slugInDb()).toBeNull();
  });

  it("forgets the slug when the App is cleared", async () => {
    setGitHubApp(app, "55", KEY, "github", "gone");
    clearGitHubApp(app);
    expect(slugInDb()).toBeNull();
    expect(await resolveOwnBotLogin(app)).toBeNull();
  });
});
