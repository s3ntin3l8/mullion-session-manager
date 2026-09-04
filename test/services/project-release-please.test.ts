import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { eq } from "drizzle-orm";
import type * as HostGit from "../../src/services/host-git.js";
import type * as GithubIntegration from "../../src/services/github-integration.js";
import type * as Github from "../../src/services/github.js";

const mockResolveRepoRefResult = vi.fn();
const mockResolveGitHubToken = vi.fn();
const mockDetectReleasePleaseConfig = vi.fn();

// #484/#489 machinery elsewhere in the app (task-github-sync.ts et al.,
// pulled in transitively by buildApp()) imports other real exports of these
// same modules (GitHubApiError, resolveRepoRef, ...) — importOriginal keeps
// those intact and only swaps the three functions this sweep actually calls.
vi.mock("../../src/services/host-git.js", async (importOriginal) => {
  const actual = await importOriginal<typeof HostGit>();
  return { ...actual, resolveRepoRefResult: mockResolveRepoRefResult };
});
vi.mock("../../src/services/github-integration.js", async (importOriginal) => {
  const actual = await importOriginal<typeof GithubIntegration>();
  return { ...actual, resolveGitHubToken: mockResolveGitHubToken };
});
vi.mock("../../src/services/github.js", async (importOriginal) => {
  const actual = await importOriginal<typeof Github>();
  return { ...actual, detectReleasePleaseConfig: mockDetectReleasePleaseConfig };
});

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { projects } = await import("../../src/db/schema.js");
const { maybeAutoEnableConventionalTitles } =
  await import("../../src/services/project-release-please.js");

const tmpDb = path.join(os.tmpdir(), `project-release-please-test-${process.pid}.db`);
const repoRef = { owner: "test-owner", repo: "test-repo" };

describe("maybeAutoEnableConventionalTitles", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

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
    vi.clearAllMocks();
    mockResolveRepoRefResult.mockResolvedValue({ ok: true, value: repoRef });
    mockResolveGitHubToken.mockResolvedValue("ghp_token");
    mockDetectReleasePleaseConfig.mockResolvedValue(true);
  });

  // Inserted directly rather than via POST /api/projects, so the route's
  // own create-time call to this same function never fires — every test
  // here calls it exactly once, deliberately, to observe its own contract.
  function insertProject(overrides: Partial<typeof projects.$inferInsert> = {}) {
    const [row] = app.db
      .insert(projects)
      .values({
        name: "release-please-test-project",
        cwd: "/tmp/does-not-matter",
        hostId: "local",
        ...overrides,
      })
      .returning()
      .all();
    return row;
  }

  it("turns conventionalCommitTitles on and stamps resolvedAt when release-please is detected", async () => {
    const project = insertProject({ conventionalCommitTitles: false });
    const updated = await maybeAutoEnableConventionalTitles(app, project);

    expect(updated.conventionalCommitTitles).toBe(true);
    expect(updated.conventionalCommitTitlesResolvedAt).not.toBeNull();
  });

  // The entire point: branchdam-mobile, this repo, and branchDAM were all a
  // stored `0`, not null, when this sweep shipped.
  it("writes over a stored false, not just a null", async () => {
    const project = insertProject({ conventionalCommitTitles: false });
    expect(project.conventionalCommitTitles).toBe(false);

    const updated = await maybeAutoEnableConventionalTitles(app, project);
    expect(updated.conventionalCommitTitles).toBe(true);
  });

  it("no-ops when conventionalCommitTitlesResolvedAt is already set — a human's choice wins permanently", async () => {
    const project = insertProject({
      conventionalCommitTitles: false,
      conventionalCommitTitlesResolvedAt: new Date(),
    });
    const updated = await maybeAutoEnableConventionalTitles(app, project);

    expect(updated.conventionalCommitTitles).toBe(false);
    expect(mockResolveRepoRefResult).not.toHaveBeenCalled();
  });

  it("stamps resolvedAt without enabling the flag when release-please isn't detected", async () => {
    mockDetectReleasePleaseConfig.mockResolvedValue(false);
    const project = insertProject();
    const updated = await maybeAutoEnableConventionalTitles(app, project);

    expect(updated.conventionalCommitTitles).toBeNull();
    expect(updated.conventionalCommitTitlesResolvedAt).not.toBeNull();
  });

  it("stamps resolvedAt (a real negative) when the project has no GitHub remote at all", async () => {
    mockResolveRepoRefResult.mockResolvedValue({ ok: true, value: null });
    const project = insertProject();
    const updated = await maybeAutoEnableConventionalTitles(app, project);

    expect(updated.conventionalCommitTitles).toBeNull();
    expect(updated.conventionalCommitTitlesResolvedAt).not.toBeNull();
    expect(mockResolveGitHubToken).not.toHaveBeenCalled();
  });

  it("leaves the project unresolved (no stamp) when the host is unreachable — a transient failure", async () => {
    mockResolveRepoRefResult.mockResolvedValue({ ok: false, reason: "unreachable" });
    const project = insertProject();
    const updated = await maybeAutoEnableConventionalTitles(app, project);

    expect(updated.conventionalCommitTitles).toBeNull();
    expect(updated.conventionalCommitTitlesResolvedAt).toBeNull();
  });

  it("leaves the project unresolved when no GitHub token is available", async () => {
    mockResolveGitHubToken.mockResolvedValue(null);
    const project = insertProject();
    const updated = await maybeAutoEnableConventionalTitles(app, project);

    expect(updated.conventionalCommitTitles).toBeNull();
    expect(updated.conventionalCommitTitlesResolvedAt).toBeNull();
  });

  it("leaves the project unresolved when detection returns null (couldn't tell)", async () => {
    mockDetectReleasePleaseConfig.mockResolvedValue(null);
    const project = insertProject();
    const updated = await maybeAutoEnableConventionalTitles(app, project);

    expect(updated.conventionalCommitTitles).toBeNull();
    expect(updated.conventionalCommitTitlesResolvedAt).toBeNull();
  });

  // A real race: this sweep's own write is issued against the `row` it read
  // BEFORE the awaited resolveRepoRefResult/resolveGitHubToken/
  // detectReleasePleaseConfig chain — a human can PATCH conventionalCommitTitles
  // directly during that window (which stamps conventionalCommitTitlesResolvedAt
  // itself, routes/projects.ts) before this function's own commitResolution
  // write lands. The WHERE clause's `isNull` guard, not just a bare
  // `eq(id, row.id)`, is what makes that update a no-op instead of clobbering
  // the human's concurrent choice.
  it("does not clobber a human's concurrent PATCH made while detection was in flight", async () => {
    const project = insertProject({ conventionalCommitTitles: null });
    mockDetectReleasePleaseConfig.mockImplementation(async () => {
      // Simulates a human's PATCH /api/projects/:id landing WHILE this
      // sweep's own network calls are still in flight — routes/projects.ts's
      // PATCH handler stamps conventionalCommitTitlesResolvedAt too.
      app.db
        .update(projects)
        .set({ conventionalCommitTitles: false, conventionalCommitTitlesResolvedAt: new Date() })
        .where(eq(projects.id, project.id))
        .run();
      return true;
    });

    const updated = await maybeAutoEnableConventionalTitles(app, project);

    expect(updated.conventionalCommitTitles).toBe(false);
    const [persisted] = app.db.select().from(projects).where(eq(projects.id, project.id)).all();
    expect(persisted.conventionalCommitTitles).toBe(false);
  });

  it("never throws — an unexpected error leaves the project unresolved", async () => {
    mockResolveRepoRefResult.mockRejectedValue(new Error("boom"));
    const project = insertProject();

    await expect(maybeAutoEnableConventionalTitles(app, project)).resolves.toMatchObject({
      conventionalCommitTitles: null,
      conventionalCommitTitlesResolvedAt: null,
    });
  });
});
