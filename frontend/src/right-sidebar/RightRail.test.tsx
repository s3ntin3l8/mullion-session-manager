// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RightRail } from "./RightRail.js";
import { useDashboardStore } from "../store/index.js";

afterEach(() => vi.restoreAllMocks());

describe("RightRail prefetch (#1970)", () => {
  it("warms the project's GitHub data on hover and focus of the GitHub icon only", async () => {
    const prefetch = vi.fn();
    useDashboardStore.setState({ prefetchGithubProject: prefetch });
    render(<RightRail projectId={4} />);

    await userEvent.hover(screen.getByRole("button", { name: "GitHub" }));
    expect(prefetch).toHaveBeenCalledWith(4);

    prefetch.mockClear();
    await userEvent.hover(screen.getByRole("button", { name: "Files" }));
    expect(prefetch).not.toHaveBeenCalled();
  });

  it("does nothing without a project", async () => {
    const prefetch = vi.fn();
    useDashboardStore.setState({ prefetchGithubProject: prefetch });
    render(<RightRail projectId={null} />);
    await userEvent.hover(screen.getByRole("button", { name: "GitHub" }));
    expect(prefetch).not.toHaveBeenCalled();
  });
});

describe("RightRail GitHub icon", () => {
  const pr = (number: number, prPhase: string) => ({ number, prPhase }) as never;
  const seed = (prs: unknown[]) =>
    useDashboardStore.setState({
      rightSidebarOpen: false,
      rightSidebarView: "git",
      githubOpenPrByProject: {},
      prsByProject: { 4: { prs, prSummary: {} } } as never,
    });

  it("opens the list, not an attention PR, even when a PR needs attention", async () => {
    seed([pr(1, "ready"), pr(2, "conflicts"), pr(3, "ci_failing")]);
    render(<RightRail projectId={4} />);
    await userEvent.click(screen.getByRole("button", { name: "GitHub" }));
    const s = useDashboardStore.getState();
    expect(s.rightSidebarOpen).toBe(true);
    expect(s.rightSidebarView).toBe("github");
    expect(s.githubOpenPrByProject[4]).toBeUndefined();
  });

  it("closes the view when it is already showing, and reopens on the list", async () => {
    seed([pr(2, "conflicts")]);
    useDashboardStore.setState({
      rightSidebarOpen: true,
      rightSidebarView: "github",
      githubOpenPrByProject: { 4: 2 },
    });
    render(<RightRail projectId={4} />);
    await userEvent.click(screen.getByRole("button", { name: "GitHub" }));
    expect(useDashboardStore.getState().rightSidebarOpen).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "GitHub" }));
    const s = useDashboardStore.getState();
    expect(s.rightSidebarOpen).toBe(true);
    expect(s.githubOpenPrByProject[4]).toBeUndefined();
  });
});
