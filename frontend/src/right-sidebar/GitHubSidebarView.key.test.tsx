// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { describe, expect, it, vi } from "vitest";

const mounts: number[] = [];

vi.mock("../GitHubPanel.js", () => ({
  GitHubPanel: ({ params }: { params: { projectId: number } }) => {
    // Mount only: a reused instance must not record the new project.
    const first = useRef(params.projectId);
    useEffect(() => {
      mounts.push(first.current);
    }, []);
    return <div />;
  },
}));

import { GitHubSidebarView } from "./GitHubSidebarView.js";

const actions = { onOpenGitHub: vi.fn() } as never;

describe("GitHubSidebarView", () => {
  it("remounts the panel for another project, so its state cannot carry over", () => {
    const { rerender } = render(<GitHubSidebarView projectId={1} actions={actions} />);
    rerender(<GitHubSidebarView projectId={2} actions={actions} />);
    expect(mounts).toEqual([1, 2]);
  });
});
