import { describe, it, expect } from "vitest";
import { sessionCheckoutRoot } from "./sessionCheckout.js";

const project = { cwd: "/work/app" };

describe("sessionCheckoutRoot", () => {
  it("is null for the project's own checkout, incl. a subfolder and a missing cwd", () => {
    expect(sessionCheckoutRoot({ cwd: "/work/app" }, project)).toBeNull();
    expect(sessionCheckoutRoot({ cwd: "/work/app/" }, project)).toBeNull();
    expect(sessionCheckoutRoot({ cwd: "/work/app/packages/ui" }, project)).toBeNull();
    expect(sessionCheckoutRoot({ cwd: null }, project)).toBeNull();
  });
  it("is the session's cwd for a worktree inside .mullion-worktrees", () => {
    expect(sessionCheckoutRoot({ cwd: "/work/app/.mullion-worktrees/feat-x" }, project)).toBe(
      "/work/app/.mullion-worktrees/feat-x",
    );
  });
  it("is the session's cwd for a worktree outside the project", () => {
    expect(sessionCheckoutRoot({ cwd: "/work/app-wt/feat-x" }, project)).toBe(
      "/work/app-wt/feat-x",
    );
    expect(sessionCheckoutRoot({ cwd: "/work/app2" }, project)).toBe("/work/app2");
  });
});
