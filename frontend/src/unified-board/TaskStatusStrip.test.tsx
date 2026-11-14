// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskStatusStrip } from "./TaskStatusStrip.js";

describe("TaskStatusStrip", () => {
  const statuses = [
    { id: "reviewing" as const, title: "Reviewing", count: 2, needsYou: true },
    { id: "backlog" as const, title: "Backlog", count: 5, needsYou: false },
  ];

  it("lists each status with its count, marking the ones that need the owner", () => {
    render(<TaskStatusStrip statuses={statuses} onJump={vi.fn()} />);
    const nav = screen.getByRole("navigation", { name: "Jump to status" });
    expect(nav).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reviewing, 2, needs you" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Backlog, 5" })).toBeInTheDocument();
    expect(document.querySelectorAll(".task-status-strip-dot")).toHaveLength(1);
  });

  it("jumps to the status it was tapped for", async () => {
    const onJump = vi.fn();
    render(<TaskStatusStrip statuses={statuses} onJump={onJump} label="Statuses" />);
    expect(screen.getByRole("navigation", { name: "Statuses" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Backlog, 5" }));
    expect(onJump).toHaveBeenCalledWith("backlog");
  });
});
