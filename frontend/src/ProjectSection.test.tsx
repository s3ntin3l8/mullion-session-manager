// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { ProjectSection } from "./Sidebar.js";
import { LOCAL_HOST_ID } from "./api.js";
import type { GitStatus, Project } from "./api.js";

// ProjectSection reads the store two ways: a selector (`gitStatuses[project.id]`)
// and — since the P1 perf fix moved its five actions off a whole-store
// subscription — `useDashboardStore.getState()` calls at each action's own
// call site. The mock must serve both, unlike SessionRow.test.tsx's
// selector-only mock. Actions are stable `vi.fn()`s defined once (not
// recreated per state() call) so a test can assert on them the same way it
// would against the real store's own stable action identities.
let gitStatuses: Record<number, GitStatus | null>;
const deleteProject = vi.fn();
const deleteSession = vi.fn();
const updateProject = vi.fn();
const subscribeToGitHubProject = vi.fn();
const unsubscribeFromGitHubProject = vi.fn();
function storeState() {
  return {
    gitStatuses,
    deleteProject,
    deleteSession,
    updateProject,
    subscribeToGitHubProject,
    unsubscribeFromGitHubProject,
  };
}
vi.mock("./store.js", () => {
  const useDashboardStore = (selector?: (s: unknown) => unknown) => {
    const state = storeState();
    return selector ? selector(state) : state;
  };
  useDashboardStore.getState = storeState;
  return { useDashboardStore };
});

const PROJECT: Project = {
  id: 1,
  name: "demo",
  cwd: "/home/x/demo",
  hostId: LOCAL_HOST_ID,
  devServerUrl: null,
  detectedDevServerPort: null,
  currentBranch: null,
  autoFetch: null,
  ruleFiles: [],
  defaultAgent: null,
  defaultReviewAgent: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

function statusWith(overrides: Partial<GitStatus>): GitStatus {
  return {
    branch: "main",
    hash: "abc1234",
    ahead: 0,
    behind: 0,
    files: [],
    isClean: true,
    hasConflicts: false,
    ...overrides,
  };
}

function renderSection(status: GitStatus | null) {
  gitStatuses = { [PROJECT.id]: status };
  return render(
    <ProjectSection
      project={PROJECT}
      sessions={[]}
      hosts={[]}
      onOpenSession={vi.fn()}
      onOpenSessionAsFloat={vi.fn()}
      onSessionEnded={vi.fn()}
      onOpenLauncher={vi.fn()}
      hierarchicalView={false}
    />,
  );
}

describe("ProjectSection ahead/behind badge (issue #433 scope A)", () => {
  it("renders no badge when ahead/behind are both 0", () => {
    const { container } = renderSection(statusWith({}));
    expect(container.querySelector(".project-git-sync")).toBeNull();
  });

  it("renders no badge when there is no git status at all", () => {
    const { container } = renderSection(null);
    expect(container.querySelector(".project-git-sync")).toBeNull();
  });

  it("renders only the ahead count when behind is 0", () => {
    const { container } = renderSection(statusWith({ ahead: 3, isClean: true }));
    const badge = container.querySelector(".project-git-sync");
    expect(badge?.textContent).toBe("↑3");
    expect(container.querySelector(".project-git-behind")).toBeNull();
  });

  it("renders only the behind count when ahead is 0", () => {
    const { container } = renderSection(statusWith({ behind: 5, isClean: true }));
    const badge = container.querySelector(".project-git-sync");
    expect(badge?.textContent).toBe("↓5");
    expect(container.querySelector(".project-git-ahead")).toBeNull();
  });

  it("renders both counts when ahead and behind are nonzero", () => {
    const { container } = renderSection(statusWith({ ahead: 2, behind: 5 }));
    expect(container.querySelector(".project-git-sync")?.textContent).toBe("↑2↓5");
  });

  it("does not add the stale class exactly at the threshold", () => {
    const { container } = renderSection(statusWith({ behind: 10 }));
    expect(container.querySelector(".project-git-sync.stale")).toBeNull();
  });

  it("adds the stale class above the threshold", () => {
    const { container } = renderSection(statusWith({ behind: 11 }));
    expect(container.querySelector(".project-git-sync.stale")).toBeTruthy();
  });

  it("includes the 'as of last fetch' caveat in the title", () => {
    const { container } = renderSection(statusWith({ behind: 3 }));
    const badge = container.querySelector(".project-git-sync");
    expect(badge?.getAttribute("title")).toBe("main: 3 behind origin (as of last fetch)");
  });
});
