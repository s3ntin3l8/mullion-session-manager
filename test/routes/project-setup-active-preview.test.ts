import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { gitEnv } from "../../src/services/git-env.js";
import { PREVIEW_TTL_MS } from "../../src/services/scaffold-generate-jobs.js";
import type * as GithubIntegration from "../../src/services/github-integration.js";
import type * as ScaffoldGenerate from "../../src/services/scaffold-generate.js";

vi.mock("../../src/services/github-integration.js", async (importOriginal) => {
  const actual = await importOriginal<typeof GithubIntegration>();
  return { ...actual, resolveGitHubToken: vi.fn().mockResolvedValue(null) };
});

vi.mock("../../src/services/scaffold-generate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ScaffoldGenerate>();
  return { ...actual, generateScaffoldContent: vi.fn() };
});

const { generateScaffoldContent } = await import("../../src/services/scaffold-generate.js");

function mockValidGeneration(slug: string) {
  vi.mocked(generateScaffoldContent).mockResolvedValue({
    skill: `---\nname: ${slug}\n---\nGenerated: real invariant about ${slug}.\n`,
    reviewer: `---\nname: ${slug}-reviewer\n---\nRead .claude/skills/${slug}/SKILL.md first.\n`,
    scaffoldRegion: `The generated skill lives at .claude/skills/${slug}/SKILL.md.`,
    sandboxed: true,
    possiblyGeneric: false,
  });
}

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv() });
}

function initRepo(cwd: string) {
  fs.mkdirSync(cwd, { recursive: true });
  git(cwd, ["init", "-b", "main"]);
  fs.writeFileSync(path.join(cwd, "README.md"), "# test repo\n");
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-m", "initial commit", "--no-verify"]);
}

async function createProject(app: Awaited<ReturnType<typeof buildApp>>, cwd: string, name = "p") {
  const res = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { allowDuplicate: true, name, cwd },
  });
  return res.json().id as number;
}

const tmpDb = path.join(os.tmpdir(), `project-setup-active-preview-test-${process.pid}.db`);
let repoDir: string;

describe("project-setup route", () => {
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
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-setup-active-repo-"));
    initRepo(repoDir);
    vi.mocked(generateScaffoldContent).mockReset();
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  describe("GET /setup/preview/active (issue #2478)", () => {
    it("returns the newest live preview with its payload, 204 when none, 404 for an unknown project", async () => {
      const app = await buildApp();
      const projectId = await createProject(app, repoDir);
      const url = `/api/projects/${projectId}/setup/preview/active`;
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(204);
      expect(
        (await app.inject({ method: "GET", url: "/api/projects/999999/setup/preview/active" }))
          .statusCode,
      ).toBe(404);

      const preview = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/setup/preview`,
        payload: { slug: "active-demo" },
      });
      expect(preview.statusCode).toBe(200);
      const active = await app.inject({ method: "GET", url });
      expect(active.statusCode).toBe(200);
      const body = active.json();
      expect(body.previewId).toBe(preview.json().previewId);
      expect(body.diff).toBe(preview.json().diff);
      expect(body.files).toEqual(preview.json().files);
      expect(body.slug).toBe("active-demo");
      expect(typeof body.createdAt).toBe("number");
      await app.close();
    });

    it("carries the generate-only fields of a generated preview", async () => {
      mockValidGeneration("gen-demo");
      const app = await buildApp();
      const projectId = await createProject(app, repoDir);
      const gen = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/setup/generate`,
        payload: { slug: "gen-demo" },
      });
      expect(gen.statusCode).toBe(200);
      const active = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/setup/preview/active`,
      });
      const body = active.json();
      expect(body.previewId).toBe(gen.json().previewId);
      expect(body.generated).toBe(true);
      expect(body.sandboxed).toBe(true);
      expect(body.agent).toBe(gen.json().agent);
      expect(body.instructionsMode).toBe("keep");
      await app.close();
    });

    it("does not return another project's preview, and drops an expired one", async () => {
      const app = await buildApp();
      const projectA = await createProject(app, repoDir);
      const otherRepo = fs.mkdtempSync(path.join(os.tmpdir(), "project-setup-repo-b-"));
      initRepo(otherRepo);
      const projectB = await createProject(app, otherRepo);
      try {
        await app.inject({
          method: "POST",
          url: `/api/projects/${projectA}/setup/preview`,
          payload: { slug: "only-a" },
        });
        const other = await app.inject({
          method: "GET",
          url: `/api/projects/${projectB}/setup/preview/active`,
        });
        expect(other.statusCode).toBe(204);

        const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + PREVIEW_TTL_MS + 1000);
        try {
          const expired = await app.inject({
            method: "GET",
            url: `/api/projects/${projectA}/setup/preview/active`,
          });
          expect(expired.statusCode).toBe(204);
        } finally {
          nowSpy.mockRestore();
        }
      } finally {
        fs.rmSync(otherRepo, { recursive: true, force: true });
      }
      await app.close();
    });
  });
});
