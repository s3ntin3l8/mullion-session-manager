// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DockviewApi } from "dockview-react";
import { useDashboardStore } from "../store/index.js";
import type { Project, Session } from "../api/index.js";
import { openTerminalPath } from "./openTerminalPath.js";

const openFileEditorPanel = vi.fn();
const openExternalFilePanel = vi.fn();
vi.mock("../panelUtils.js", () => ({
  openFileEditorPanel: (...args: unknown[]) => openFileEditorPanel(...args),
  openExternalFilePanel: (...args: unknown[]) => openExternalFilePanel(...args),
}));

// The boolean is the fold's right half's contract (#3034): it moves focus to
// the left half only when something opened there.
describe("openTerminalPath", () => {
  const api = {} as DockviewApi;
  const layout = { tier: "tablet" as const };

  beforeEach(() => {
    openFileEditorPanel.mockClear();
    openExternalFilePanel.mockClear();
    useDashboardStore.setState({
      sessions: [
        { id: 1, projectId: 7, cwd: null } as Session,
        { id: 2, projectId: 7, cwd: "/proj/.mullion-worktrees/wt" } as Session,
        { id: 3, projectId: 99, cwd: null } as Session,
      ],
      projects: [{ id: 7, name: "demo", cwd: "/proj/" } as Project],
    });
  });

  it("opens a project file in the editor, relative to the session's root", () => {
    expect(openTerminalPath(api, 1, layout, "/proj/src/a.ts", 4)).toBe(true);
    expect(openFileEditorPanel).toHaveBeenCalledWith(api, 7, expect.any(Array), layout, {
      path: "src/a.ts",
      sessionId: undefined,
      line: 4,
    });
    // A worktree session's own checkout roots the editor.
    expect(openTerminalPath(api, 2, layout, "./././b.ts")).toBe(true);
    expect(openFileEditorPanel).toHaveBeenLastCalledWith(api, 7, expect.any(Array), layout, {
      path: "b.ts",
      sessionId: 2,
      line: undefined,
    });
  });

  it("opens a path outside the root in the read-only viewer", () => {
    expect(openTerminalPath(api, 1, layout, "~/.claude/plans/p.md")).toBe(true);
    expect(openTerminalPath(api, 1, layout, "/etc/hosts", 2)).toBe(true);
    expect(openExternalFilePanel).toHaveBeenLastCalledWith(api, 7, expect.any(Array), layout, {
      path: "/etc/hosts",
      line: 2,
    });
    expect(openFileEditorPanel).not.toHaveBeenCalled();
  });

  it("opens nothing for a path above the root, an empty one, or an unknown session or project", () => {
    expect(openTerminalPath(api, 1, layout, "../x.ts")).toBe(false);
    expect(openTerminalPath(api, 1, layout, "./")).toBe(false);
    expect(openTerminalPath(api, 42, layout, "src/a.ts")).toBe(false);
    expect(openTerminalPath(api, 3, layout, "src/a.ts")).toBe(false);
    expect(openFileEditorPanel).not.toHaveBeenCalled();
    expect(openExternalFilePanel).not.toHaveBeenCalled();
  });
});
