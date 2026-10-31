import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { gitEnv } from "../../src/services/git-env.js";
import {
  clearGenerateJobsForTests,
  PREVIEW_TTL_MS,
} from "../../src/services/scaffold-generate-jobs.js";
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

const { generateScaffoldContent, GenerationSpawnError } =
  await import("../../src/services/scaffold-generate.js");

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

function commitBothScaffoldFiles(cwd: string, slug: string) {
  const skillDir = path.join(cwd, ".claude", "skills", slug);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: demo\ndescription: hand-written\n---\nhand-written skill\n",
  );
  const agentsDir = path.join(cwd, ".claude", "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentsDir, `${slug}-reviewer.md`),
    `---\nname: ${slug}-reviewer\n---\nhand-written reviewer\n`,
  );
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-m", "pre-existing skill+reviewer", "--no-verify"]);
}

async function createProject(app: Awaited<ReturnType<typeof buildApp>>, cwd: string, name = "p") {
  const res = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { allowDuplicate: true, name, cwd },
  });
  return res.json().id as number;
}

async function waitForJobTerminal(
  app: Awaited<ReturnType<typeof buildApp>>,
  projectId: number,
  jobId: string,
) {
  for (let i = 0; i < 100; i++) {
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/setup/generate/jobs/${jobId}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    if (body.phase === "done" || body.phase === "failed") {
      return body;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Job ${jobId} did not finish in time`);
}

const tmpDb = path.join(os.tmpdir(), `project-setup-generate-jobs-test-${process.pid}.db`);
let repoDir: string;

describe("project-setup background generate job routes (issue #2429)", () => {
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
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-setup-jobs-repo-"));
    initRepo(repoDir);
    clearGenerateJobsForTests();
    vi.mocked(generateScaffoldContent).mockReset();
  });

  afterEach(() => {
    clearGenerateJobsForTests();
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it("POST generate/start returns 202 { jobId }, finishes with the same body as synchronous /setup/generate, and its previewId applies", async () => {
    const app = await buildApp();
    const syncRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-setup-sync-repo-"));
    initRepo(syncRepoDir);
    try {
      const syncProjectId = await createProject(app, syncRepoDir, "sync-p");
      const jobProjectId = await createProject(app, repoDir, "job-p");
      mockValidGeneration("demo");

      const syncRes = await app.inject({
        method: "POST",
        url: `/api/projects/${syncProjectId}/setup/generate`,
        payload: { slug: "demo" },
      });
      expect(syncRes.statusCode).toBe(200);
      const syncBody = syncRes.json();

      const startRes = await app.inject({
        method: "POST",
        url: `/api/projects/${jobProjectId}/setup/generate/start`,
        payload: { slug: "demo" },
      });
      expect(startRes.statusCode).toBe(202);
      const { jobId } = startRes.json();
      expect(jobId).toBeTypeOf("string");

      const finishedJob = await waitForJobTerminal(app, jobProjectId, jobId);
      expect(finishedJob.phase).toBe("done");
      expect(finishedJob.agent).toBe("claude");
      expect(finishedJob.mode).toBe("keep");
      expect(finishedJob.startedAt).toBeTypeOf("number");
      expect(finishedJob.finishedAt).toBeTypeOf("number");
      expect(finishedJob.result.previewId).toBeTypeOf("string");
      expect({ ...finishedJob.result, previewId: "same" }).toEqual({
        ...syncBody,
        previewId: "same",
      });

      // The previewId produced by the background job applies via /setup/apply.
      const applyRes = await app.inject({
        method: "POST",
        url: `/api/projects/${jobProjectId}/setup/apply`,
        payload: { previewId: finishedJob.result.previewId },
      });
      expect(applyRes.statusCode).toBe(200);
      expect(applyRes.json()).toMatchObject({
        ok: true,
        mode: "local-branch",
        branch: "mullion/setup-demo",
      });

      // Once applied, the preview (and the job pointing at it) is claimed, so active is 204.
      const activeAfterApply = await app.inject({
        method: "GET",
        url: `/api/projects/${jobProjectId}/setup/generate/active`,
      });
      expect(activeAfterApply.statusCode).toBe(204);
    } finally {
      fs.rmSync(syncRepoDir, { recursive: true, force: true });
      await app.close();
    }
  });

  it("validates synchronously on POST generate/start (404, 400 invalid slug, 409 when skill and reviewer already exist)", async () => {
    const app = await buildApp();
    commitBothScaffoldFiles(repoDir, "demo");
    const projectId = await createProject(app, repoDir);

    const notFound = await app.inject({
      method: "POST",
      url: "/api/projects/999999/setup/generate/start",
      payload: { slug: "demo" },
    });
    expect(notFound.statusCode).toBe(404);

    const badSlug = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/setup/generate/start`,
      payload: { slug: "../evil" },
    });
    expect(badSlug.statusCode).toBe(400);

    const conflict = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/setup/generate/start`,
      payload: { slug: "demo" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(generateScaffoldContent).not.toHaveBeenCalled();

    const activeRes = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/setup/generate/active`,
    });
    expect(activeRes.statusCode).toBe(204);

    await app.close();
  });

  it("attaches on a second POST generate/start while a job is in flight and serves active for running, finished and none", async () => {
    const app = await buildApp();
    const projectId = await createProject(app, repoDir);

    // None before any job starts -> 204.
    const noneRes = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/setup/generate/active`,
    });
    expect(noneRes.statusCode).toBe(204);

    let resolveTurn!: (value: ScaffoldGenerate.GeneratedScaffoldContent) => void;
    vi.mocked(generateScaffoldContent).mockImplementation(
      () =>
        new Promise((res) => {
          resolveTurn = res;
        }),
    );

    const firstStart = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/setup/generate/start`,
      payload: { slug: "demo" },
    });
    expect(firstStart.statusCode).toBe(202);
    const { jobId } = firstStart.json();

    // Active while running -> 200 with running phase.
    const runningActive = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/setup/generate/active`,
    });
    expect(runningActive.statusCode).toBe(200);
    expect(["preparing", "agent", "composing"]).toContain(runningActive.json().phase);
    expect(runningActive.json().jobId).toBe(jobId);

    // Second start while in flight attaches to the existing job without spawning a second turn.
    const secondStart = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/setup/generate/start`,
      payload: { slug: "demo" },
    });
    expect(secondStart.statusCode).toBe(202);
    expect(secondStart.json().jobId).toBe(jobId);
    expect(generateScaffoldContent).toHaveBeenCalledTimes(1);

    resolveTurn({
      skill: "---\nname: demo\n---\nGenerated invariant.\n",
      reviewer: "---\nname: demo-reviewer\n---\nRead .claude/skills/demo/SKILL.md first.\n",
      scaffoldRegion: "Skill at .claude/skills/demo/SKILL.md.",
      sandboxed: true,
      possiblyGeneric: false,
    });

    const finished = await waitForJobTerminal(app, projectId, jobId);
    expect(finished.phase).toBe("done");

    // Active when finished-unclaimed -> 200 with the finished job.
    const finishedActive = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/setup/generate/active`,
    });
    expect(finishedActive.statusCode).toBe(200);
    expect(finishedActive.json()).toMatchObject({
      jobId,
      phase: "done",
      agent: "claude",
      mode: "keep",
    });
    expect(finishedActive.json().result.previewId).toBe(finished.result.previewId);

    await app.close();
  });

  it("returns 404 from GET generate/jobs/:jobId when the job belongs to another project or has expired", async () => {
    const app = await buildApp();
    const otherRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-setup-other-repo-"));
    initRepo(otherRepoDir);
    try {
      const projectA = await createProject(app, repoDir, "project-a");
      const projectB = await createProject(app, otherRepoDir, "project-b");
      mockValidGeneration("demo");

      const startRes = await app.inject({
        method: "POST",
        url: `/api/projects/${projectA}/setup/generate/start`,
        payload: { slug: "demo" },
      });
      const { jobId } = startRes.json();
      await waitForJobTerminal(app, projectA, jobId);

      // Polling from project B returns 404.
      const crossProject = await app.inject({
        method: "GET",
        url: `/api/projects/${projectB}/setup/generate/jobs/${jobId}`,
      });
      expect(crossProject.statusCode).toBe(404);

      // Advance Date.now past PREVIEW_TTL_MS: both job status and active expire.
      const realNow = Date.now();
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(realNow + PREVIEW_TTL_MS + 1000);
      try {
        const expiredJob = await app.inject({
          method: "GET",
          url: `/api/projects/${projectA}/setup/generate/jobs/${jobId}`,
        });
        expect(expiredJob.statusCode).toBe(404);

        const expiredActive = await app.inject({
          method: "GET",
          url: `/api/projects/${projectA}/setup/generate/active`,
        });
        expect(expiredActive.statusCode).toBe(204);
      } finally {
        nowSpy.mockRestore();
      }
    } finally {
      fs.rmSync(otherRepoDir, { recursive: true, force: true });
      await app.close();
    }
  });

  it("records a failed agent turn with status 502 and logs one structured line with no line breaks even when the agent output has line breaks", async () => {
    const app = await buildApp();
    const projectId = await createProject(app, repoDir);
    const infoSpy = vi.spyOn(app.log, "info");

    vi.mocked(generateScaffoldContent).mockRejectedValue(
      new GenerationSpawnError(
        "claude",
        "exit code 1 — stdout: line one\nFAKE LOG ENTRY\r\nline three",
      ),
    );

    const startRes = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/setup/generate/start`,
      payload: { slug: "demo", existingInstructions: "report" },
    });
    expect(startRes.statusCode).toBe(202);
    const { jobId } = startRes.json();

    const failedJob = await waitForJobTerminal(app, projectId, jobId);
    expect(failedJob.phase).toBe("failed");
    expect(failedJob.error).toEqual({
      status: 502,
      message:
        '"claude" generation turn failed: exit code 1 — stdout: line one\nFAKE LOG ENTRY\r\nline three',
    });

    const jobFinishLog = infoSpy.mock.calls.find(
      (call) => call[1] === "[scaffold-generate] generation job finished",
    );
    expect(jobFinishLog).toBeDefined();
    const [fields, msg] = jobFinishLog as unknown as [Record<string, unknown>, string];
    expect(fields).toMatchObject({
      mode: "report",
      agent: "claude",
      sandboxed: false,
      outcome: "failed",
    });
    expect(fields.durationMs).toBeTypeOf("number");
    expect(JSON.stringify(fields)).not.toMatch(/[\r\n]/);
    expect(msg).not.toMatch(/[\r\n]/);

    await app.close();
  });

  it("gives polling routes their own 120/min rate-limit bucket (not SETUP_RATE_LIMIT's 10/min)", async () => {
    const app = await buildApp();
    const projectId = await createProject(app, repoDir);
    mockValidGeneration("demo");

    const startRes = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/setup/generate/start`,
      payload: { slug: "demo" },
    });
    const { jobId } = startRes.json();
    await waitForJobTerminal(app, projectId, jobId);

    // 15 polls in a row exceed SETUP_RATE_LIMIT (10/min) but stay well within 120/min.
    for (let i = 0; i < 15; i++) {
      const pollRes = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/setup/generate/jobs/${jobId}`,
      });
      expect(pollRes.statusCode).toBe(200);
    }

    await app.close();
  });
});
