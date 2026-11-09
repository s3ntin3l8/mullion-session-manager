import { describe, it, expect } from "vitest";
import { actionsRunIdFromCheckUrl } from "../../src/services/github.js";

describe("actionsRunIdFromCheckUrl", () => {
  it("reads the workflow run id from a job URL", () => {
    expect(
      actionsRunIdFromCheckUrl("https://github.com/o/r/actions/runs/42671268878/job/129"),
    ).toBe(42671268878);
  });

  it("reads it from a run URL with no job, or with a query string", () => {
    expect(actionsRunIdFromCheckUrl("https://github.com/o/r/actions/runs/7")).toBe(7);
    expect(actionsRunIdFromCheckUrl("https://github.com/o/r/actions/runs/7?pr=3")).toBe(7);
  });

  it("is undefined for a check from another app, or no URL", () => {
    expect(actionsRunIdFromCheckUrl("https://app.codecov.io/gh/o/r/pull/9")).toBeUndefined();
    expect(actionsRunIdFromCheckUrl("https://github.com/o/r/runs/123")).toBeUndefined();
    expect(actionsRunIdFromCheckUrl(undefined)).toBeUndefined();
  });
});
