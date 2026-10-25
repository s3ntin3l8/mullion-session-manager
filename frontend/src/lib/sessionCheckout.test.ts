import { describe, it, expect } from "vitest";
import { sessionCheckoutRoot, sessionIdOfPanel } from "./sessionCheckout.js";

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

describe("sessionIdOfPanel", () => {
  it.each([
    ["session-12", 12],
    ["timeline-3", 3],
    ["browserPane-7", 7],
    ["file-4-@9-src%2Fa.ts", 9],
  ])("%s -> %i", (id, n) => expect(sessionIdOfPanel(id)).toBe(n));
  it.each([null, "git-4", "file-4-src%2Fa.ts", "file-4-s9-src%2Fa.ts", "settings", "session-x"])(
    "%s -> null",
    (id) => expect(sessionIdOfPanel(id)).toBeNull(),
  );
});
