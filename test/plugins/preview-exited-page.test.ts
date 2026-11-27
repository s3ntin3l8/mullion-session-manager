import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { projects, sessions } from "../../src/db/schema.js";
import {
  bindBranchPreview,
  getOrCreateProjectPreview,
  upsertBranchPreview,
} from "../../src/services/preview-registry.js";
import { acceptsHtml, buildExitedPreviewHtml } from "../../src/services/preview-exited-page.js";

// Issue #3588 — a browser opening a branch preview whose dev server exited gets
// a readable page (exit code, last output, a way back), not the raw JSON 502;
// an API client keeps the fixed JSON body.
const tmpDb = path.join(os.tmpdir(), `preview-exited-page-${process.pid}.db`);
const BASE = "preview.exited-page.test";

describe("preview proxy: the dev server exited (#3588)", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let n = 0;

  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.PREVIEW_BASE_HOST = BASE;
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.PREVIEW_BASE_HOST;
  });

  function addPreview(
    session: Partial<typeof sessions.$inferInsert>,
    opts: { setupRecipe?: string | null; branch?: string } = {},
  ) {
    const project = app.db
      .insert(projects)
      .values({
        name: `ep-${++n}`,
        cwd: "/tmp/ep",
        hostId: "local",
        setupRecipe: opts.setupRecipe ?? null,
      })
      .returning()
      .get();
    const row = app.db
      .insert(sessions)
      .values({ projectId: project.id, command: "make dev", kind: "dock", ...session })
      .returning()
      .get();
    const preview = upsertBranchPreview(app, project.id, opts.branch ?? "feat-tasks-mode");
    // A port nothing listens on: the dev server is gone.
    bindBranchPreview(app, preview.slug, { sessionId: row.id, upstreamPort: 1 });
    return preview.slug;
  }

  const get = (slug: string, accept?: string) =>
    app.inject({
      method: "GET",
      url: "/",
      headers: {
        host: `preview-${slug}.${BASE}`,
        origin: "https://dashboard.example",
        ...(accept ? { accept } : {}),
      },
    });

  it("answers a browser with the exit code, the last output and the no-recipe hint", async () => {
    const slug = addPreview({
      status: "exited",
      lastExitCode: 1,
      lastOutput: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsx' <imported>",
      setupHint: "no-recipe",
    });
    const res = await get(slug, "text/html,application/xhtml+xml,*/*;q=0.8");
    expect(res.statusCode).toBe(502);
    expect(res.headers["content-type"]).toMatch(/^text\/html/);
    expect(res.body).toContain("The dev server for feat-tasks-mode exited (code 1).");
    // Escaped, not markup.
    expect(res.body).toContain("Cannot find package &#39;tsx&#39; &lt;imported&gt;");
    expect(res.body).toContain("This project has no setup recipe");
    // The page carries the dev server's output: never readable cross-origin.
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("drops the hint once the project has a recipe, and says when there is no output", async () => {
    const slug = addPreview(
      { status: "exited", setupHint: "no-recipe" },
      { setupRecipe: "npm ci", branch: "feat/b" },
    );
    const res = await get(slug, "text/html");
    expect(res.body).toContain("The dev server for feat/b exited.");
    expect(res.body).toContain("It left no output to show.");
    expect(res.body).not.toContain("no setup recipe");
  });

  it("keeps the fixed JSON body for a non-HTML client", async () => {
    const slug = addPreview({ status: "exited", lastExitCode: 1, lastOutput: "boom" });
    const res = await get(slug, "application/json");
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ message: "preview unavailable" });
    expect(res.body).not.toContain("boom");
  });

  it("leaves a preview whose session is still active to the proxy", async () => {
    const slug = addPreview({ status: "active", lastOutput: "boom" });
    const res = await get(slug, "text/html");
    // The upstream is unreachable and the session still counts as running.
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain("boom");
  });

  it("never answers the project checkout's preview with it, whatever session it was bound to", async () => {
    const project = app.db
      .insert(projects)
      .values({ name: `ep-${++n}`, cwd: "/tmp/ep", hostId: "local", devServerUrl: "1" })
      .returning()
      .get();
    const ended = app.db
      .insert(sessions)
      .values({ projectId: project.id, command: "bash", status: "killed", lastOutput: "boom" })
      .returning()
      .get();
    const preview = getOrCreateProjectPreview(app, project.id, ended.id);
    const res = await get(preview.slug, "text/html");
    expect(res.body).not.toContain("exited");
    expect(res.json()).toMatchObject({ message: "preview unavailable" });
  });

  it("acceptsHtml and the page builder", () => {
    expect(acceptsHtml(undefined)).toBe(false);
    expect(acceptsHtml(["application/json", "text/html"])).toBe(true);
    const html = buildExitedPreviewHtml(
      { branch: null, exitCode: null, output: null, noRecipe: false },
      "https://dash.example/?a=<b>",
    );
    expect(html).toContain("The dev server exited.");
    expect(html).toContain('href="https://dash.example/?a=&lt;b&gt;"');
  });
});
