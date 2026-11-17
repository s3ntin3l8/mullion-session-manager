// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceChip } from "./WorkspaceChip.js";
import { chipPopoverPosition } from "../lib/railPopoverPosition.js";
import type { Group } from "../api/index.js";
import { resetPhoneBackStackForTests } from "../hooks/usePhoneBackStack.js";
import { useDashboardStore } from "../store/index.js";
import { makeSession, makeWorkspace } from "../test/fixtures.js";
import railCss from "../styles/left-rail.css?raw";
import { expectNameHasVisibleText } from "../test/a11y.js";
import { moveWorkspace } from "../workspaceActions.js";
import type * as WorkspaceActions from "../workspaceActions.js";

vi.mock("../workspaceActions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof WorkspaceActions>()),
  moveWorkspace: vi.fn(),
}));

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
      makeWorkspace({
        id: 3,
        name: "Runway",
        groupId: 2,
        position: 1,
        layout: { views: [{ params: { sessionId: 5 } }] },
      }),
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

const chip = () => screen.getByRole("button", { name: /switch workspace$/ });

describe("WorkspaceChip", () => {
  it("names the current workspace with its initial in its group's colour", () => {
    render(<WorkspaceChip onSelectWorkspace={vi.fn()} sheet={false} />);
    // The name starts with the visible text, the workspace name; the initial
    // is drawn by CSS from data-initial, so it is not text in the chip (#2886).
    expect(chip()).toHaveAccessibleName("Mullion, group AI Usage, switch workspace");
    expect(chip()).toHaveAttribute("aria-haspopup", "dialog");
    expect(chip()).toHaveTextContent(/^Mullion$/);
    expectNameHasVisibleText(chip());
    const initial = chip().querySelector(".rail-ws-initial") as HTMLElement;
    expect(initial).toHaveAttribute("data-initial", "M");
    // The initial's glyph comes from the stylesheet.
    expect(railCss).toMatch(/\.rail-ws-initial::before\s*\{\s*content:\s*attr\(data-initial\);/);
    expect(initial.style.borderColor).toBe("var(--b)");
    // Groups are already loaded: no second fetch.
    expect(refreshGroups).not.toHaveBeenCalled();
  });

  it("loads the groups when nothing has yet, and swallows a failed load", async () => {
    refreshGroups.mockRejectedValueOnce(new Error("429"));
    useDashboardStore.setState({ groups: [] });
    render(<WorkspaceChip onSelectWorkspace={vi.fn()} sheet={false} />);
    expect(refreshGroups).toHaveBeenCalledTimes(1);
    await act(async () => {});
  });

  it("shows one square per group in name order, a grey one for ungrouped, the current outlined", () => {
    render(<WorkspaceChip onSelectWorkspace={vi.fn()} sheet={false} />);
    const squares = [...chip().querySelectorAll<HTMLElement>(".rail-ws-square")];
    expect(squares.map((s) => s.dataset.square)).toEqual(["g2", "g1", "ungrouped"]);
    expect(squares.map((s) => s.style.background)).toEqual(["var(--b)", "var(--o)", "var(--dim)"]);
    expect(squares.map((s) => s.classList.contains("current"))).toEqual([true, false, false]);
    expect(squares.map((s) => s.title)).toEqual(["AI Usage", "Homelab", "Ungrouped"]);
  });

  it("has no ungrouped square without ungrouped workspaces, and outlines it for an ungrouped one", () => {
    seed({ withUngrouped: false });
    const { unmount } = render(<WorkspaceChip onSelectWorkspace={vi.fn()} sheet={false} />);
    expect(chip().querySelector('[data-square="ungrouped"]')).toBeNull();
    unmount();
    seed({ active: 4 });
    render(<WorkspaceChip onSelectWorkspace={vi.fn()} sheet={false} />);
    expect(chip()).toHaveAccessibleName("Personal, switch workspace");
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
        .map((b) => b.getAttribute("aria-label") ?? b.textContent),
    ).toEqual([
      "Manage group AI Usage",
      "Reorder Mullion",
      "Mullion",
      "Manage Mullion",
      "Reorder Runway",
      "Runway",
      "Manage Runway",
    ]);
    expect(within(ai).getByRole("button", { name: "Mullion" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(within(list).getByRole("button", { name: "Personal" })).toBeInTheDocument();
    // Runway holds a session that needs input: the sidebar's attention dot.
    expect(
      within(ai).getByRole("button", { name: "Runway" }).querySelector(".workspace-attn-dot"),
    ).not.toBeNull();
    expect(
      within(ai).getByRole("button", { name: "Mullion" }).querySelector(".workspace-attn-dot"),
    ).toBeNull();
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
        .map((b) => b.getAttribute("aria-label") ?? b.textContent),
    ).toEqual([
      "Manage group AI Usage",
      "Reorder Runway",
      "Runway",
      "Manage Runway",
      "New workspace",
      "New group",
    ]);
    // A filtered list is not the groups' order: no reordering from it.
    expect(within(list).getByRole("button", { name: "Reorder Runway" })).toBeDisabled();
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
    // Focus goes back to the chip, not to <body>.
    await act(() => new Promise((r) => requestAnimationFrame(() => r(undefined))));
    expect(chip()).toHaveFocus();
  });

  it("follows the chip when the rail scrolls under the open popover", async () => {
    const user = userEvent.setup();
    render(<WorkspaceChip onSelectWorkspace={vi.fn()} sheet={false} />);
    const rect = vi.spyOn(chip(), "getBoundingClientRect");
    rect.mockReturnValue({ top: 120, right: 46 } as DOMRect);
    await user.click(chip());
    const popover = screen.getByRole("dialog", { name: "Workspaces" });
    expect(popover.style.top).toBe("120px");
    rect.mockReturnValue({ top: 60, right: 46 } as DOMRect);
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(popover.style.top).toBe("60px");
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
    expect(chip()).toHaveAccessibleName("No workspace, switch workspace");
    expectNameHasVisibleText(chip());
    expect(chip().querySelectorAll(".rail-ws-square.current")).toHaveLength(0);
  });
});

// #3217 — reorder by the handle; groups as a hierarchy.
describe("reordering in the picker", () => {
  const openList = async (props: { sheet?: boolean } = {}) => {
    const user = userEvent.setup();
    render(<WorkspaceChip onSelectWorkspace={vi.fn()} sheet={props.sheet ?? false} />);
    await user.click(chip());
    return { user, list: screen.getByRole("dialog", { name: "Workspaces" }) };
  };

  it("has no Move up / Move down in the ⋯ menu; Move to a group stays", async () => {
    const { user, list } = await openList();
    await user.click(within(list).getByRole("button", { name: "Manage Mullion" }));
    const menu = screen.getByRole("menu", { name: "Mullion actions" });
    const labels = within(menu)
      .getAllByRole("menuitem")
      .map((i) => i.textContent);
    expect(labels).not.toContain("Move up");
    expect(labels).not.toContain("Move down");
    expect(labels).toEqual(
      expect.arrayContaining(["Rename", "Move to Homelab", "Move to No group"]),
    );
    await user.click(within(menu).getByRole("menuitem", { name: "Move to Homelab" }));
    expect(moveWorkspace).toHaveBeenCalledWith(expect.any(Array), 2, 1, 1);
  });

  it("moves a row with Arrow Up / Arrow Down on its handle and announces it", async () => {
    const { user, list } = await openList();
    const handle = within(list).getByRole("button", { name: "Reorder Mullion" });
    expect(handle).toHaveAccessibleDescription(/Arrow Up or Arrow Down/);
    handle.focus();
    await user.keyboard("{ArrowDown}");
    expect(moveWorkspace).toHaveBeenCalledWith(useDashboardStore.getState().workspaces, 2, 2, 1);
    const status = within(list).getByRole("status");
    expect(status).toHaveTextContent("Mullion moved to position 2 of 2 in AI Usage");
    // Focus is put back on the handle once the list has re-rendered.
    handle.blur();
    await act(() => new Promise((r) => requestAnimationFrame(() => r(undefined))));
    expect(within(list).getByRole("button", { name: "Reorder Mullion" })).toHaveFocus();

    vi.mocked(moveWorkspace).mockClear();
    within(list).getByRole("button", { name: "Reorder Mullion" }).focus();
    await user.keyboard("{ArrowUp}");
    expect(moveWorkspace).not.toHaveBeenCalled();
    expect(status).toHaveTextContent("Mullion is already first in AI Usage");
    within(list).getByRole("button", { name: "Reorder Personal" }).focus();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(moveWorkspace).not.toHaveBeenCalled();
    expect(status).toHaveTextContent("Personal is already last in No group");
  });

  it("exposes each group, and No group, as a labelled section, an empty group included", async () => {
    useDashboardStore.setState({
      groups: [...useDashboardStore.getState().groups, group({ id: 3, name: "Empty" })],
    });
    const { list } = await openList();
    expect(
      within(list)
        .getAllByRole("group")
        .map((g) => g.getAttribute("aria-label")),
    ).toEqual(["AI Usage", "Empty", "Homelab", "No group"]);
    const empty = within(list).getByRole("group", { name: "Empty" });
    expect(empty).toHaveAttribute("data-drop-zone", "3");
    expect(empty).toHaveTextContent("No workspaces: drag one here");
    expect(within(list).getByRole("group", { name: "No group" })).toHaveAttribute(
      "data-drop-zone",
      "none",
    );
  });

  it("drops a dragged row where the pointer leaves it, a No group zone appearing for it", async () => {
    seed({ withUngrouped: false });
    const { list } = await openList({ sheet: true });
    expect(within(list).queryByRole("group", { name: "No group" })).toBeNull();
    const handle = within(list).getByRole("button", { name: "Reorder Runway" });
    expect(handle.closest(".rail-ws-list.touch")).not.toBeNull();
    fireEvent.pointerDown(handle, { pointerId: 1, isPrimary: true, button: 0, clientY: 10 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 40 });
    // Mid-drag: the row is dimmed and No group is offered as a target.
    expect(handle.closest(".rail-ws-item")).toHaveClass("dragging");
    const none = within(list).getByRole("group", { name: "No group" });
    expect(none).toHaveTextContent("Drop here to take it out of its group");
    // jsdom has no layout: put No group under the pointer.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const top = this.dataset.dropZone === "none" ? 100 : 0;
      return { top, bottom: top + 50, left: 0, right: 100, width: 100, height: 50 } as DOMRect;
    });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 120 });
    expect(none).toHaveClass("drop-target");
    // An empty zone lights up its own box rather than drawing a line.
    expect(none.querySelector(".rail-ws-drop-indicator")).toBeNull();
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 120 });
    expect(moveWorkspace).toHaveBeenCalledWith(expect.any(Array), 3, null, 0);
    expect(within(list).getByRole("status")).toHaveTextContent(
      "Runway moved to position 1 of 1 in No group",
    );
    vi.restoreAllMocks();
  });

  it("moves nothing when a row is dropped back where it was", async () => {
    const { list } = await openList();
    const handle = within(list).getByRole("button", { name: "Reorder Mullion" });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      top: 0,
      bottom: 0,
      left: 0,
      right: 0,
      width: 0,
      height: 0,
    } as DOMRect);
    fireEvent.pointerDown(handle, { pointerId: 1, isPrimary: true, button: 0, clientY: 0 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: -20 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: -20 });
    expect(moveWorkspace).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe("chipPopoverPosition", () => {
  it("opens beside the chip, level with its top, and caps its height", () => {
    expect(chipPopoverPosition({ top: 120, right: 46 }, 1280, 600)).toEqual({
      top: 120,
      left: 52,
      maxHeight: 472,
    });
    expect(chipPopoverPosition({ top: 120, right: 46 }, 1280, 900).maxHeight).toBe(520);
  });

  it("keeps room for the list when the chip sits low, and stays inside a narrow window", () => {
    expect(chipPopoverPosition({ top: 600, right: 46 }, 290, 640)).toEqual({
      top: 392,
      left: 8,
      maxHeight: 240,
    });
  });
});

describe("workspace list rows", () => {
  it("are at least 48px tall under a coarse pointer", () => {
    const start = railCss.indexOf(".rail-ws-list.touch .rail-ws-row {");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(railCss.slice(start, railCss.indexOf("}", start))).toMatch(/min-height:\s*48px/);
  });
});

// #3072 — the picker's columns line up: every "⋯" on one vertical line, group
// and workspace names on one indent, and both footer actions readable.
describe("workspace list alignment", () => {
  const rule = (selector: string) => {
    const start = railCss.indexOf(`${selector} {`);
    expect(start).toBeGreaterThanOrEqual(0);
    return railCss.slice(start, railCss.indexOf("}", start));
  };

  it("gives a group header no right padding, like a workspace row, so the ⋯ buttons align", () => {
    expect(rule(".rail-ws-group-header")).toMatch(/padding:\s*2px 0;/);
    expect(rule(".rail-ws-item")).not.toMatch(/padding/);
  });

  // #3217 replaced #3072's single indent: workspaces sit indented under
  // their group's header.
  it("puts a group's colour square in the handle's 20px column and indents the rows under it", () => {
    // 10px square + 5px either side = the handle's 20px.
    expect(rule(".rail-ws-group-color")).toMatch(/width:\s*10px[\s\S]*margin:\s*0 5px/);
    expect(rule(".rail-ws-grip")).toMatch(/width:\s*20px/);
    expect(
      rule(
        ".rail-ws-group.grouped > .rail-ws-group-body,\n.rail-ws-group.ungrouped > .rail-ws-group-body",
      ),
    ).toMatch(/margin-left:\s*9px[\s\S]*border-left:/);
    // The header is a label, not a row: no hover, no uppercase small caps.
    expect(railCss).not.toMatch(/\.rail-ws-group-header:hover/);
    expect(rule(".rail-ws-group-header")).not.toMatch(/text-transform/);
  });

  it("lets only the handle take a touch, at 44px under a coarse pointer", () => {
    expect(rule(".rail-ws-grip")).toMatch(/touch-action:\s*none/);
    expect(rule(".rail-ws-item")).not.toMatch(/touch-action/);
    expect(rule(".rail-ws-list.touch .rail-ws-more,\n.rail-ws-list.touch .rail-ws-grip")).toMatch(
      /width:\s*44px;\s*height:\s*44px/,
    );
  });

  it("stacks New workspace and New group instead of halving the width", () => {
    expect(rule(".rail-ws-new-row")).toMatch(/flex-direction:\s*column/);
    // ...with the rows' 2px gap, so the two buttons still read as two targets.
    expect(rule(".rail-ws-new-row")).toMatch(/gap:\s*2px/);
  });
});
