// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ViewModeToggle } from "./ViewModeToggle.js";
import type { ViewMode } from "./store.js";

let viewMode: ViewMode;
const setViewMode = vi.fn((next: ViewMode) => {
  viewMode = next;
});

vi.mock("./store.js", () => ({
  useDashboardStore: (selector?: (s: unknown) => unknown) => {
    const state = { viewMode, setViewMode };
    return selector ? selector(state) : state;
  },
}));

beforeEach(() => {
  viewMode = "list";
  setViewMode.mockClear();
});

describe("ViewModeToggle", () => {
  it("marks the list button active by default", () => {
    render(<ViewModeToggle />);
    expect(screen.getByTitle("List view")).toHaveClass("active");
    expect(screen.getByTitle("Kanban board view")).not.toHaveClass("active");
  });

  it("calls setViewMode('kanban') when the board button is clicked", async () => {
    const user = userEvent.setup();
    render(<ViewModeToggle />);
    await user.click(screen.getByTitle("Kanban board view"));
    expect(setViewMode).toHaveBeenCalledWith("kanban");
  });

  it("marks the board button active once viewMode is 'kanban'", () => {
    viewMode = "kanban";
    render(<ViewModeToggle />);
    expect(screen.getByTitle("Kanban board view")).toHaveClass("active");
    expect(screen.getByTitle("List view")).not.toHaveClass("active");
  });

  it("calls setViewMode('list') when the list button is clicked", async () => {
    viewMode = "kanban";
    const user = userEvent.setup();
    render(<ViewModeToggle />);
    await user.click(screen.getByTitle("List view"));
    expect(setViewMode).toHaveBeenCalledWith("list");
  });
});
