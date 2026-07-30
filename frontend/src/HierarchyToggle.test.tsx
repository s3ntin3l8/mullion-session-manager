// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HierarchyToggle } from "./HierarchyToggle.js";

let hierarchicalView: boolean;
const setHierarchicalView = vi.fn((next: boolean) => {
  hierarchicalView = next;
});

vi.mock("./store.js", () => ({
  useDashboardStore: (selector?: (s: unknown) => unknown) => {
    const state = { hierarchicalView, setHierarchicalView };
    return selector ? selector(state) : state;
  },
}));

beforeEach(() => {
  hierarchicalView = false;
  setHierarchicalView.mockClear();
});

describe("HierarchyToggle", () => {
  it("marks the flat button active by default", () => {
    render(<HierarchyToggle />);
    expect(screen.getByTitle("Flat view")).toHaveClass("active");
    expect(screen.getByTitle("Hierarchical view")).not.toHaveClass("active");
  });

  it("calls setHierarchicalView(true) when the hierarchical button is clicked", async () => {
    const user = userEvent.setup();
    render(<HierarchyToggle />);
    await user.click(screen.getByTitle("Hierarchical view"));
    expect(setHierarchicalView).toHaveBeenCalledWith(true);
  });

  it("marks the hierarchical button active once hierarchicalView is true", () => {
    hierarchicalView = true;
    render(<HierarchyToggle />);
    expect(screen.getByTitle("Hierarchical view")).toHaveClass("active");
    expect(screen.getByTitle("Flat view")).not.toHaveClass("active");
  });

  it("calls setHierarchicalView(false) when the flat button is clicked", async () => {
    hierarchicalView = true;
    const user = userEvent.setup();
    render(<HierarchyToggle />);
    await user.click(screen.getByTitle("Flat view"));
    expect(setHierarchicalView).toHaveBeenCalledWith(false);
  });
});
