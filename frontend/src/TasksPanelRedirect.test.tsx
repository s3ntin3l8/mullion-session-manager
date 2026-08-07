// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TasksPanelRedirect } from "./TasksPanelRedirect.js";

describe("TasksPanelRedirect", () => {
  it("renders an explanation that the board moved", () => {
    render(<TasksPanelRedirect onOpenBoard={vi.fn()} />);
    expect(screen.getByText("The task board moved")).toBeInTheDocument();
  });

  it("calls onOpenBoard when the button is clicked", async () => {
    const onOpenBoard = vi.fn();
    const user = userEvent.setup();
    render(<TasksPanelRedirect onOpenBoard={onOpenBoard} />);
    await user.click(screen.getByText("Open the Kanban view"));
    expect(onOpenBoard).toHaveBeenCalledTimes(1);
  });
});
