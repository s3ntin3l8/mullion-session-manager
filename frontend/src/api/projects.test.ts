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
