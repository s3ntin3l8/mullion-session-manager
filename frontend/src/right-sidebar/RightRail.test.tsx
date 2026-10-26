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
