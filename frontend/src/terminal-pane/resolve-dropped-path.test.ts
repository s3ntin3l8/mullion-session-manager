import { describe, it, expect } from "vitest";
import { resolveDroppedPath } from "./resolve-dropped-path.js";

const PROJECT_CWD = "/work/app";
const WT = "/work/app/.mullion-worktrees/feat";
const src = (path: string, rootCwd = PROJECT_CWD) => ({ projectId: 1, path, rootCwd });

describe("resolveDroppedPath", () => {
  it("a session at the project root gets the project-relative path", () => {
    expect(
      resolveDroppedPath(src("src/a.ts"), {
        projectId: 1,
        cwd: PROJECT_CWD,
        projectCwd: PROJECT_CWD,
      }),
    ).toBe("src/a.ts");
    // no cwd = inherits the project's
    expect(
      resolveDroppedPath(src("src/a.ts"), { projectId: 1, cwd: null, projectCwd: PROJECT_CWD }),
    ).toBe("src/a.ts");
  });

  it("a session in a project subfolder gets a path relative to that folder", () => {
    expect(
      resolveDroppedPath(src("src/a.ts"), {
        projectId: 1,
        cwd: "/work/app/packages/ui",
        projectCwd: PROJECT_CWD,
      }),
    ).toBe("../../src/a.ts");
    expect(
      resolveDroppedPath(src("packages/ui/b.ts"), {
        projectId: 1,
        cwd: "/work/app/packages/ui",
        projectCwd: PROJECT_CWD,
      }),
    ).toBe("b.ts");
  });

  it("a worktree session gets the same file in ITS checkout, from either tree", () => {
    const target = { projectId: 1, cwd: WT, projectCwd: PROJECT_CWD };
    // dragged from the project's own tree
    expect(resolveDroppedPath(src("src/a.ts"), target)).toBe("src/a.ts");
    // dragged from another worktree's tree: still the target worktree's copy
    expect(resolveDroppedPath(src("src/a.ts", "/work/app/.mullion-worktrees/other"), target)).toBe(
      "src/a.ts",
    );
  });

  it("a main-checkout session dragged a worktree tree's file gets the main checkout's copy", () => {
    expect(
      resolveDroppedPath(src("src/a.ts", WT), {
        projectId: 1,
        cwd: PROJECT_CWD,
        projectCwd: PROJECT_CWD,
      }),
    ).toBe("src/a.ts");
  });

  it("a worktree session's tree is rooted at its own directory, so that is its checkout root", () => {
    // Same rule the backend's file routes use (the session's cwd is the root).
    expect(
      resolveDroppedPath(src("src/a.ts"), {
        projectId: 1,
        cwd: `${WT}/sub`,
        projectCwd: PROJECT_CWD,
      }),
    ).toBe("src/a.ts");
  });

  it("another project, or no project, gets the absolute path", () => {
    expect(
      resolveDroppedPath(src("src/a.ts"), {
        projectId: 2,
        cwd: "/work/other",
        projectCwd: "/work/other",
      }),
    ).toBe("/work/app/src/a.ts");
    expect(
      resolveDroppedPath(src("src/a.ts", WT), { projectId: null, cwd: null, projectCwd: null }),
    ).toBe("/work/app/.mullion-worktrees/feat/src/a.ts");
  });

  it("a worktree outside the project is its own root", () => {
    // Outside the project it can only be a checkout of its own: same relative path.
    expect(
      resolveDroppedPath(src("src/a.ts"), {
        projectId: 1,
        cwd: "/elsewhere/wt",
        projectCwd: PROJECT_CWD,
      }),
    ).toBe("src/a.ts");
  });

  it("a dropped folder at the checkout root is '.'", () => {
    expect(
      resolveDroppedPath(src(""), { projectId: 1, cwd: PROJECT_CWD, projectCwd: PROJECT_CWD }),
    ).toBe(".");
  });
});
