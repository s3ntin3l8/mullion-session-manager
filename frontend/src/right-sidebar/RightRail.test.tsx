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

describe("RightRail attention routing (B8)", () => {
  const pr = (number: number, prPhase: string) => ({ number, prPhase }) as never;
  const seed = (prs: unknown[]) =>
    useDashboardStore.setState({
      rightSidebarOpen: false,
      rightSidebarView: "git",
      prsByProject: { 4: { prs, prSummary: {} } } as never,
    });

  it("opens the most urgent attention PR when the GitHub icon is clicked", async () => {
    seed([pr(1, "ready"), pr(2, "conflicts"), pr(3, "ci_failing")]);
    render(<RightRail projectId={4} />);
    await userEvent.click(screen.getByRole("button", { name: "GitHub" }));
    const s = useDashboardStore.getState();
    expect(s.rightSidebarView).toBe("github");
    expect(s.githubOpenPrByProject[4]).toBe(3);
  });

  it("just toggles the view when no PR needs attention, and closes it when already showing", async () => {
    seed([pr(1, "ready_to_merge")]);
    useDashboardStore.setState({ githubOpenPrByProject: {} });
    render(<RightRail projectId={4} />);
    await userEvent.click(screen.getByRole("button", { name: "GitHub" }));
    expect(useDashboardStore.getState().rightSidebarOpen).toBe(true);
    expect(useDashboardStore.getState().githubOpenPrByProject[4]).toBeUndefined();

    seed([pr(2, "conflicts")]);
    useDashboardStore.setState({ rightSidebarOpen: true, rightSidebarView: "github" });
    await userEvent.click(screen.getByRole("button", { name: "GitHub" }));
    expect(useDashboardStore.getState().rightSidebarOpen).toBe(false);
  });
});
