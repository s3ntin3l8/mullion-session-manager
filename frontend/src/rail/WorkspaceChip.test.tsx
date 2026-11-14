// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceChip } from "./WorkspaceChip.js";
import { chipPopoverPosition } from "../lib/railPopoverPosition.js";
import type { Group } from "../api/index.js";
import { resetPhoneBackStackForTests } from "../hooks/usePhoneBackStack.js";
import { useDashboardStore } from "../store/index.js";
import { makeSession, makeWorkspace } from "../test/fixtures.js";

const group = (over: Partial<Group>): Group => ({
  id: 1,
  name: "Homelab",
  icon: null,
  color: "var(--o)",
  collapsed: true,
  position: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const refreshGroups = vi.fn(async () => {});
const createWorkspace = vi.fn(async (name: string) => makeWorkspace({ id: 99, name }));

function seed({ withUngrouped = true, active = 2 } = {}) {
  useDashboardStore.setState({
    groups: [
      group({ id: 1, name: "Homelab", color: "var(--o)" }),
      group({ id: 2, name: "AI Usage", color: "var(--b)" }),
    ],
    workspaces: [
      makeWorkspace({ id: 1, name: "Landing", groupId: 1, position: 1 }),
      makeWorkspace({ id: 2, name: "Mullion", groupId: 2, position: 0 }),
      makeWorkspace({ id: 3, name: "Runway", groupId: 2, position: 1 }),
      ...(withUngrouped
        ? [makeWorkspace({ id: 4, name: "Personal", groupId: null, position: 0 })]
        : []),
    ],
    sessions: [makeSession({ id: 5, attention: true })],
    activeWorkspaceId: active,
    refreshGroups,
    createWorkspace,
  });
}

beforeEach(() => {
  resetPhoneBackStackForTests();
  seed();
});
afterEach(() => vi.clearAllMocks());

const chip = () => screen.getByRole("button", { name: /^Switch workspace/ });

describe("WorkspaceChip", () => {
  it("names the current workspace with its initial in its group's colour", () => {
    render(<WorkspaceChip onSelectWorkspace={vi.fn()} sheet={false} />);
    expect(chip()).toHaveAccessibleName("Switch workspace, current: Mullion, group AI Usage");
    expect(chip()).toHaveAttribute("aria-haspopup", "dialog");
    expect(chip()).toHaveTextContent("M");
    expect(chip()).toHaveTextContent("Mullion");
    const initial = chip().querySelector(".rail-ws-initial") as HTMLElement;
    expect(initial.style.borderColor).toBe("var(--b)");
    expect(refreshGroups).toHaveBeenCalled();
  });

  it("shows one square per group in name order, a grey one for ungrouped, the current outlined", () => {
    render(<WorkspaceChip onSelectWorkspace={vi.fn()} sheet={false} />);
    const squares = [...chip().querySelectorAll<HTMLElement>(".rail-ws-square")];
    expect(squares.map((s) => s.dataset.square)).toEqual(["g2", "g1", "ungrouped"]);
    expect(squares.map((s) => s.style.background)).toEqual(["var(--b)", "var(--o)", "var(--dim)"]);
    expect(squares.map((s) => s.classList.contains("current"))).toEqual([true, false, false]);
  });

  it("has no ungrouped square without ungrouped workspaces, and outlines it for an ungrouped one", () => {
    seed({ withUngrouped: false });
    const { unmount } = render(<WorkspaceChip onSelectWorkspace={vi.fn()} sheet={false} />);
    expect(chip().querySelector('[data-square="ungrouped"]')).toBeNull();
    unmount();
    seed({ active: 4 });
    render(<WorkspaceChip onSelectWorkspace={vi.fn()} sheet={false} />);
    expect(chip()).toHaveAccessibleName("Switch workspace, current: Personal");
    expect(chip().querySelector('[data-square="ungrouped"]')).toHaveClass("current");
    const initial = chip().querySelector(".rail-ws-initial") as HTMLElement;
    expect(initial.style.borderColor).toBe("var(--dim)");
  });

  it("opens the list as a popover beside the chip and switches workspace from it", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<WorkspaceChip onSelectWorkspace={onSelect} sheet={false} />);
    await user.click(chip());
    expect(chip()).toHaveAttribute("aria-expanded", "true");
    const list = screen.getByRole("dialog", { name: "Workspaces" });
    expect(list).toHaveClass("rail-ws-popover");
    // Groups in their colour with their workspaces, expanded even though the
    // sidebar has them collapsed; then the ungrouped ones; the live dot.
    const ai = within(list).getByRole("group", { name: "AI Usage" });
    expect(
      within(ai)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Mullion", "Runway"]);
    expect(within(ai).getByRole("button", { name: "Mullion" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(within(list).getByRole("button", { name: "Personal" })).toBeInTheDocument();
    expect(within(list).getByRole("button", { name: "New workspace" })).toBeInTheDocument();
    expect(within(list).getByRole("searchbox", { name: "Search workspaces" })).toHaveFocus();

    await user.click(within(list).getByRole("button", { name: "Landing" }));
    expect(onSelect).toHaveBeenCalledWith(1);
    expect(screen.queryByRole("dialog", { name: "Workspaces" })).toBeNull();
  });

  it("filters by workspace or group name, and says when nothing matches", async () => {
    const user = userEvent.setup();
    render(<WorkspaceChip onSelectWorkspace={vi.fn()} sheet={false} />);
    await user.click(chip());
    const list = screen.getByRole("dialog", { name: "Workspaces" });
    await user.type(within(list).getByRole("searchbox"), "run");
    expect(
      within(list)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Runway", "New workspace"]);
    await user.clear(within(list).getByRole("searchbox"));
    await user.type(within(list).getByRole("searchbox"), "homelab");
    expect(within(list).getByRole("button", { name: "Landing" })).toBeInTheDocument();
    await user.type(within(list).getByRole("searchbox"), "zzz");
    expect(within(list).getByText("No matching workspace")).toBeInTheDocument();
  });

  it("closes the popover on Escape and on a click outside", async () => {
    const user = userEvent.setup();
    render(<WorkspaceChip onSelectWorkspace={vi.fn()} sheet={false} />);
    await user.click(chip());
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(chip()).toHaveFocus();
    await user.click(chip());
    await user.click(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("creates a workspace from the list and switches to it", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<WorkspaceChip onSelectWorkspace={onSelect} sheet={false} />);
    await user.click(chip());
    await user.click(screen.getByRole("button", { name: "New workspace" }));
    await user.type(screen.getByPlaceholderText("workspace name"), "Scratch{Enter}");
    expect(createWorkspace).toHaveBeenCalledWith("Scratch");
    await act(async () => {});
    expect(onSelect).toHaveBeenCalledWith(99);
  });

  it("opens the list as a sheet with touch-size rows under a coarse pointer", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<WorkspaceChip onSelectWorkspace={onSelect} sheet />);
    await user.click(chip());
    const sheet = screen.getByRole("dialog", { name: "Workspaces" });
    expect(sheet.closest(".rail-ws-popover")).toBeNull();
    expect(sheet.querySelector(".rail-ws-list.touch")).not.toBeNull();
    // No autofocus in the sheet: it would raise the on-screen keyboard.
    expect(within(sheet).getByRole("searchbox")).not.toHaveFocus();
    await user.click(within(sheet).getByRole("button", { name: "Runway" }));
    expect(onSelect).toHaveBeenCalledWith(3);
    expect(screen.queryByRole("dialog", { name: "Workspaces" })).toBeNull();
  });

  it("reads 'No workspace' while none is active", () => {
    seed({ active: 0 });
    useDashboardStore.setState({ activeWorkspaceId: null });
    render(<WorkspaceChip onSelectWorkspace={vi.fn()} sheet={false} />);
    expect(chip()).toHaveAccessibleName("Switch workspace, current: No workspace");
    expect(chip().querySelectorAll(".rail-ws-square.current")).toHaveLength(0);
  });
});

describe("chipPopoverPosition", () => {
  it("opens beside the chip, level with its top", () => {
    expect(chipPopoverPosition({ top: 120, right: 46 }, 1280, 800)).toEqual({
      top: 120,
      left: 52,
      maxHeight: 672,
    });
  });

  it("keeps room for the list when the chip sits low, and stays inside a narrow window", () => {
    expect(chipPopoverPosition({ top: 600, right: 46 }, 290, 640)).toEqual({
      top: 392,
      left: 8,
      maxHeight: 240,
    });
  });
});
