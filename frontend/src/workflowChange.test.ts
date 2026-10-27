import { describe, it, expect } from "vitest";
import { parseWorkflowChange, visibleTaskSyncError } from "./workflowChange.js";

describe("parseWorkflowChange", () => {
  it("reads a stored change", () => {
    expect(parseWorkflowChange('{"sha":"abc","files":["w.yml"]}')).toEqual({
      sha: "abc",
      files: ["w.yml"],
    });
  });

  it("drops non-string file entries", () => {
    expect(parseWorkflowChange('{"sha":"abc","files":["w.yml",3,null]}')).toEqual({
      sha: "abc",
      files: ["w.yml"],
    });
  });

  it("reads null, empty, corrupt and wrongly-shaped values as nothing waiting", () => {
    expect(parseWorkflowChange(null)).toBeNull();
    expect(parseWorkflowChange(undefined)).toBeNull();
    expect(parseWorkflowChange("")).toBeNull();
    expect(parseWorkflowChange("{not json")).toBeNull();
    expect(parseWorkflowChange('{"sha":1,"files":[]}')).toBeNull();
    expect(parseWorkflowChange('{"files":[]}')).toBeNull();
  });
});

describe("visibleTaskSyncError", () => {
  const workflowChange = JSON.stringify({
    sha: "a".repeat(40),
    files: [".github/workflows/ci.yml"],
  });
  const rejection =
    "refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission";

  it("suppresses only the push rejection superseded by an active workflow hold", () => {
    expect(visibleTaskSyncError({ workflowChange, githubSyncError: rejection })).toBeNull();
    expect(visibleTaskSyncError({ workflowChange, githubSyncError: null })).toBeNull();
    expect(visibleTaskSyncError({ workflowChange, githubSyncError: "403 Forbidden" })).toBe(
      "403 Forbidden",
    );
    expect(
      visibleTaskSyncError({
        workflowChange,
        githubSyncError:
          "refusing to allow a GitHub App to create or update workflow: another failure",
      }),
    ).not.toBeNull();
  });

  it("keeps the rejection visible when the hold clears or cannot be parsed", () => {
    expect(visibleTaskSyncError({ workflowChange: null, githubSyncError: rejection })).toBe(
      rejection,
    );
    expect(visibleTaskSyncError({ workflowChange: "{broken", githubSyncError: rejection })).toBe(
      rejection,
    );
  });
});
