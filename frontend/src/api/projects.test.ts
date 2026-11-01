// Regression coverage for a Hermes review finding on #812: `updateProject`'s
// `Pick<Project, ...>` had drifted out of sync with `Project` itself (missing
// `autoTagRelease`, added alongside mergeOnApprove/autoApprove/
// conventionalCommitTitles). The mismatch didn't actually break the existing
// caller (store/slices/projects.ts forwards its own wider-typed `patch`
// variable straight through, and TS only excess-property-checks object
// LITERALS, not variables) — but it silently narrowed the type any OTHER
// caller could pass, and would have started dropping fields for real the
// moment someone reconstructed the request body from this type instead of
// forwarding it. Asserting the literal call site here means a future
// omission fails typecheck, not just a runtime/behavioral read.
import { describe, it, expect, vi } from "vitest";
import { jsonResponse } from "../test/jsonResponse.js";
import { projectsApi } from "./projects.js";

describe("projectsApi.updateProject", () => {
  it("carries every per-project toggle field, including autoTagRelease, through to the PATCH body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);

    await projectsApi.updateProject(1, {
      mergeOnApprove: true,
      autoApprove: false,
      conventionalCommitTitles: true,
      autoTagRelease: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      mergeOnApprove: true,
      autoApprove: false,
      conventionalCommitTitles: true,
      autoTagRelease: true,
    });
  });
});

describe("projectsApi.generateProjectSetup", () => {
  it("POSTs the options, including an explicit refresh list, to /setup/generate", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        previewId: "p1",
        diff: "",
        files: [],
        hasAgentsOverride: false,
        sandboxed: true,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await projectsApi.generateProjectSetup(7, {
      slug: "demo",
      symlinkAgentsSkills: true,
      refresh: ["skill"],
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/projects/7/setup/generate");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      slug: "demo",
      symlinkAgentsSkills: true,
      refresh: ["skill"],
    });
    expect(result.sandboxed).toBe(true);
  });
});

describe("projectsApi.generateProjectSetup — existingInstructions", () => {
  it("sends the mode and returns conflicts untouched", async () => {
    const conflict = { file: "AGENTS.md", excerpt: "x", kind: "contradicts", note: "n" };
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        previewId: "p",
        diff: "",
        files: [],
        hasAgentsOverride: false,
        sandboxed: true,
        conflicts: [conflict],
        droppedConflictLines: 1,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await projectsApi.generateProjectSetup(7, {
      slug: "demo",
      existingInstructions: "report",
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).existingInstructions).toBe("report");
    expect(result.conflicts).toEqual([conflict]);
    expect(result.droppedConflictLines).toBe(1);
  });
});

// Issue #2429 — the background generation job the Scaffold panel polls.
describe("projectsApi.startGenerateProjectSetup", () => {
  it("POSTs the options to /setup/generate/start and returns the job id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(202, { jobId: "job-1" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await projectsApi.startGenerateProjectSetup(7, {
      slug: "demo",
      includeDockConfig: true,
      refresh: ["skill"],
      existingInstructions: "restructure",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/projects/7/setup/generate/start");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      slug: "demo",
      includeDockConfig: true,
      refresh: ["skill"],
      existingInstructions: "restructure",
    });
    expect(result.jobId).toBe("job-1");
  });
});

describe("projectsApi.getGenerateJob", () => {
  it("GETs the job's state and returns its phase, agent and mode", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        jobId: "job-1",
        slug: "demo",
        phase: "agent",
        agent: "codex",
        mode: "restructure",
        startedAt: 1000,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const job = await projectsApi.getGenerateJob(7, "job-1");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/projects/7/setup/generate/jobs/job-1");
    expect(init.method).toBeUndefined();
    expect(job.phase).toBe("agent");
    expect(job.agent).toBe("codex");
    expect(job.mode).toBe("restructure");
    expect(job.startedAt).toBe(1000);
  });
});

describe("projectsApi.getActiveGenerateJob", () => {
  it("returns the project's current job", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        jobId: "job-1",
        slug: "demo",
        phase: "done",
        agent: "codex",
        mode: "keep",
        startedAt: 1000,
        finishedAt: 2000,
        result: { previewId: "p", diff: "", files: [], hasAgentsOverride: false, sandboxed: true },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const job = await projectsApi.getActiveGenerateJob(7);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/projects/7/setup/generate/active");
    expect(job?.phase).toBe("done");
    expect(job?.result?.previewId).toBe("p");
  });

  it("returns undefined when the server holds no job (204)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(204));
    vi.stubGlobal("fetch", fetchMock);

    expect(await projectsApi.getActiveGenerateJob(7)).toBeUndefined();
  });
});
