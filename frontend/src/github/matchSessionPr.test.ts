import { describe, it, expect } from "vitest";
import { matchSessionPr } from "./matchSessionPr.js";

const prs = [
  { number: 1, headBranch: "feat-a" },
  { number: 2, headBranch: "feat-b" },
];

describe("matchSessionPr", () => {
  it("matches by branch", () => {
    expect(matchSessionPr(prs, { branch: "feat-b" })?.number).toBe(2);
  });
  it("prefers the task's PR number over the branch", () => {
    expect(matchSessionPr(prs, { branch: "feat-b", taskPrNumber: 1 })?.number).toBe(1);
  });
  it("falls back to the branch when the task's PR is no longer open", () => {
    expect(matchSessionPr(prs, { branch: "feat-b", taskPrNumber: 9 })?.number).toBe(2);
  });
  it("returns undefined without PRs or any key", () => {
    expect(matchSessionPr(undefined, { branch: "feat-a" })).toBeUndefined();
    expect(matchSessionPr(prs, {})).toBeUndefined();
    expect(matchSessionPr(prs, { branch: null })).toBeUndefined();
  });
});
