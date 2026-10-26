// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useFollowedCheckoutSession } from "./useFollowedCheckoutSession.js";
import { makeProject, makeSession } from "../test/fixtures.js";
import { resetStore } from "../test/resetStore.js";

const project = makeProject({ id: 4, cwd: "/work/app" });
const worktree = makeSession({ id: 9, projectId: 4, cwd: "/work/app/.mullion-worktrees/feat" });
const plain = makeSession({ id: 3, projectId: 4, cwd: "/work/app" });

const follow = (projectId: number | null) =>
  renderHook(() => useFollowedCheckoutSession(projectId)).result.current;

beforeEach(() => resetStore({ projects: [project], sessions: [worktree, plain] }));

describe("useFollowedCheckoutSession", () => {
  it.each(["session-9", "timeline-9", "browserPane-9", "file-4-@9-src%2Fa.ts"])(
    "is the worktree session when the focused panel is %s",
    (panel) => {
      resetStore({ projects: [project], sessions: [worktree, plain], activePanelId: panel });
      expect(follow(4)).toBe(9);
    },
  );

  it("is null for a session in the project's own checkout", () => {
    resetStore({ projects: [project], sessions: [worktree, plain], activePanelId: "session-3" });
    expect(follow(4)).toBeNull();
  });

  it("is null for a panel that belongs to no session, or none focused", () => {
    resetStore({ projects: [project], sessions: [worktree], activePanelId: "git-4" });
    expect(follow(4)).toBeNull();
    resetStore({ projects: [project], sessions: [worktree], activePanelId: null });
    expect(follow(4)).toBeNull();
  });

  it("is null when the sidebar shows another project, or none", () => {
    resetStore({ projects: [project], sessions: [worktree], activePanelId: "session-9" });
    expect(follow(5)).toBeNull();
    expect(follow(null)).toBeNull();
  });

  it("is null for a session the store doesn't know (ended) or whose project it doesn't", () => {
    resetStore({ projects: [project], sessions: [], activePanelId: "session-9" });
    expect(follow(4)).toBeNull();
    resetStore({ projects: [], sessions: [worktree], activePanelId: "session-9" });
    expect(follow(4)).toBeNull();
  });
});
