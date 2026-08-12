// @vitest-environment jsdom
// useCommandSearch.ts — the three parallel filter pipelines (Sessions /
// Workspaces / launcher "Matching commands") and the combined-index keyboard
// nav across them, extracted from CommandPalette.tsx (PR 29, Wave 5 of
// .claude/plans/can-we-do-a-warm-cocke.md). CommandPalette.test.tsx's own
// "Sessions/Workspaces search (U2)" describe already exercises this
// end-to-end through a real mount (arrow keys, Enter, mouse hover) and is
// left untouched as the primary regression net for that integration. This
// file is additive: it unit-tests the index math directly against the hook,
// per the roadmap's "every pure-helper extraction must ship the unit tests
// it enables" rule — arrow-key nav across three variable-length,
// independently-filtered lists is exactly where an off-by-one is cheap to
// introduce and expensive to notice through a full component mount alone.
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useCommandSearch } from "./useCommandSearch.js";
import { makeSession, makeProject, makeWorkspace } from "../test/fixtures.js";
import type { Launcher } from "../api.js";

const PROJECT = makeProject({ id: 5, name: "mullion" });

const BASH: Launcher = { id: "shell:bash", kind: "shell", title: "bash", command: "bash" };
const CLAUDE: Launcher = { id: "agent:claude", kind: "agent", title: "claude", command: "claude" };

function baseOptions(overrides: Partial<Parameters<typeof useCommandSearch>[0]> = {}) {
  return {
    scope: "project" as const,
    effectiveProjectId: PROJECT.id,
    sessions: [],
    projects: [PROJECT],
    workspaces: [],
    launchers: [BASH, CLAUDE],
    hiddenAgents: undefined,
    ...overrides,
  };
}

describe("useCommandSearch -> filter pipelines", () => {
  it("returns every launcher and no Sessions/Workspaces groups on a blank query", () => {
    const { result } = renderHook(() => useCommandSearch(baseOptions()));

    expect(result.current.filtered).toEqual([BASH, CLAUDE]);
    expect(result.current.matchingSessions).toEqual([]);
    expect(result.current.matchingWorkspaces).toEqual([]);
    expect(result.current.entries).toHaveLength(2);
  });

  it("strips hidden agents from the launcher pipeline but leaves other kinds alone", () => {
    const { result } = renderHook(() =>
      useCommandSearch(baseOptions({ hiddenAgents: ["claude"] })),
    );

    expect(result.current.filtered).toEqual([BASH]);
  });

  it("only surfaces Sessions/Workspaces once there is a non-blank query", () => {
    const session = makeSession({ id: 1, projectId: PROJECT.id, name: "hotfix runner" });
    const workspace = makeWorkspace({ id: 1, name: "hotfix workspace" });
    const { result } = renderHook(() =>
      useCommandSearch(baseOptions({ sessions: [session], workspaces: [workspace] })),
    );

    expect(result.current.matchingSessions).toEqual([]);
    expect(result.current.matchingWorkspaces).toEqual([]);

    act(() => result.current.setQuery("hotfix"));

    expect(result.current.matchingSessions).toEqual([session]);
    expect(result.current.matchingWorkspaces).toEqual([workspace]);
  });

  it("in project scope, excludes sessions from a different project", () => {
    const here = makeSession({ id: 1, projectId: PROJECT.id, name: "match here" });
    const elsewhere = makeSession({ id: 2, projectId: 999, name: "match elsewhere" });
    const { result } = renderHook(() =>
      useCommandSearch(baseOptions({ sessions: [here, elsewhere] })),
    );

    act(() => result.current.setQuery("match"));

    expect(result.current.matchingSessions).toEqual([here]);
  });

  it("in global scope, does not filter sessions by project", () => {
    const elsewhere = makeSession({ id: 2, projectId: 999, name: "match elsewhere" });
    const { result } = renderHook(() =>
      useCommandSearch(baseOptions({ scope: "global", sessions: [elsewhere] })),
    );

    act(() => result.current.setQuery("match"));

    expect(result.current.matchingSessions).toEqual([elsewhere]);
  });

  it("excludes killed sessions and dock-kind sessions from the Sessions pipeline", () => {
    const killed = makeSession({
      id: 1,
      projectId: PROJECT.id,
      name: "match killed",
      status: "killed",
    });
    const dock = makeSession({ id: 2, projectId: PROJECT.id, name: "match dock", kind: "dock" });
    const live = makeSession({ id: 3, projectId: PROJECT.id, name: "match live" });
    const { result } = renderHook(() =>
      useCommandSearch(baseOptions({ sessions: [killed, dock, live] })),
    );

    act(() => result.current.setQuery("match"));

    expect(result.current.matchingSessions).toEqual([live]);
  });
});

describe("useCommandSearch -> combined-index math", () => {
  it("flattens Sessions, then Workspaces, then launchers into one ordered `entries` list", () => {
    const session = makeSession({ id: 1, projectId: PROJECT.id, name: "bashful session" });
    const workspace = makeWorkspace({ id: 1, name: "bashful workspace" });
    const { result } = renderHook(() =>
      useCommandSearch(baseOptions({ sessions: [session], workspaces: [workspace] })),
    );

    act(() => result.current.setQuery("bash"));

    // "bash" matches the session/workspace names and BASH's own title —
    // CLAUDE doesn't match "bash" at all, so the launcher pipeline only
    // contributes one entry here.
    expect(result.current.entries).toEqual([
      { type: "session", session },
      { type: "workspace", workspace },
      { type: "launcher", launcher: BASH },
    ]);
    // groupOffset is where the launcher group starts — sessions.length (1) +
    // workspaces.length (1) = 2, the exact index of the first launcher entry
    // above.
    expect(result.current.groupOffset).toBe(2);
  });

  it("setQuery resets selectedIndex to 0, same as the search input's own onChange used to do inline", () => {
    const { result } = renderHook(() => useCommandSearch(baseOptions()));

    act(() => result.current.setSelectedIndex(1));
    expect(result.current.selectedIndex).toBe(1);

    act(() => result.current.setQuery("claude"));
    expect(result.current.selectedIndex).toBe(0);
  });

  it("clamps activeIndex to the last entry when selectedIndex is set past the end (e.g. a live session dropping out of the match set mid-poll)", () => {
    const { result } = renderHook(() => useCommandSearch(baseOptions()));

    act(() => result.current.setSelectedIndex(50));

    // Only 2 launchers (no query -> no Sessions/Workspaces groups) — the
    // last valid index is 1.
    expect(result.current.activeIndex).toBe(1);
    expect(result.current.activeEntry).toEqual({ type: "launcher", launcher: CLAUDE });
  });

  it("activeIndex is -1 and activeEntry is undefined when every pipeline is empty", () => {
    const { result } = renderHook(() => useCommandSearch(baseOptions({ launchers: [] })));

    expect(result.current.entries).toEqual([]);
    expect(result.current.activeIndex).toBe(-1);
    expect(result.current.activeEntry).toBeUndefined();
  });

  it("middle-group indexing: with one session and one workspace, index 0 is the session and index 1 is the workspace (no off-by-one on groupOffset)", () => {
    const session = makeSession({ id: 5, projectId: PROJECT.id, name: "bashful session" });
    const workspace = makeWorkspace({ id: 3, name: "bashful workspace" });
    const { result } = renderHook(() =>
      useCommandSearch(baseOptions({ sessions: [session], workspaces: [workspace] })),
    );

    act(() => result.current.setQuery("bash"));

    expect(result.current.entries[0]).toEqual({ type: "session", session });
    expect(result.current.entries[1]).toEqual({ type: "workspace", workspace });
    expect(result.current.entries[result.current.groupOffset]).toEqual({
      type: "launcher",
      launcher: BASH,
    });
  });
});
