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
