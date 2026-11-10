import { describe, it, expect } from "vitest";
import { actionsRunIdFromCheckUrl } from "../../src/services/github.js";

const repo = { owner: "o", repo: "r" };

describe("actionsRunIdFromCheckUrl", () => {
  it("reads the workflow run id from a job URL", () => {
    expect(
      actionsRunIdFromCheckUrl("https://github.com/o/r/actions/runs/42671268878/job/129", repo),
    ).toBe(42671268878);
  });

  it("reads it from a run URL with no job, or with a query string", () => {
    expect(actionsRunIdFromCheckUrl("https://github.com/o/r/actions/runs/7", repo)).toBe(7);
    expect(actionsRunIdFromCheckUrl("https://github.com/o/r/actions/runs/7?pr=3", repo)).toBe(7);
  });

  it("reads it from the shape a check has AFTER a rerun (the next tick parses this)", () => {
    expect(
      actionsRunIdFromCheckUrl("https://github.com/o/r/actions/runs/7/attempts/2/job/99", repo),
    ).toBe(7);
  });

  it("is undefined for a check from another app, or no URL", () => {
    expect(actionsRunIdFromCheckUrl("https://app.codecov.io/gh/o/r/pull/9", repo)).toBeUndefined();
    expect(actionsRunIdFromCheckUrl("https://github.com/o/r/runs/123", repo)).toBeUndefined();
    expect(actionsRunIdFromCheckUrl(undefined, repo)).toBeUndefined();
  });

  it("is undefined for a run in a different repository, so its id is never POSTed against this one", () => {
    expect(
      actionsRunIdFromCheckUrl("https://github.com/o/other/actions/runs/555/job/1", repo),
    ).toBeUndefined();
    expect(
      actionsRunIdFromCheckUrl("https://github.com/x/r/actions/runs/555/job/1", repo),
    ).toBeUndefined();
  });

  it("matches owner and repo case-insensitively and treats them literally", () => {
    expect(actionsRunIdFromCheckUrl("https://github.com/O/R/actions/runs/8/job/1", repo)).toBe(8);
    // Owner "o." must not match "oX": unescaped, the dot is a wildcard and this
    // path would match and return 9.
    expect(
      actionsRunIdFromCheckUrl("https://github.com/oX/r/actions/runs/9", {
        owner: "o.",
        repo: "r",
      }),
    ).toBeUndefined();
  });
});
