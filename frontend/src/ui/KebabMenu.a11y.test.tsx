// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { KebabMenu } from "./KebabMenu.js";

// KebabMenu was mouse-only.
//
// The trigger was an icon button with no accessible name, the portaled menu
// had no `role`, the items had no `role="menuitem"`, and there was no key
// handling at all — a keyboard user could not open the menu, reach any of
// its actions, or close it once open. `PaneActionsMenu` (the pane tab's own
// overflow menu) has had the correct pattern for a while; this brings the
// generic one in line with it.

const items = [
  { key: "rename", label: "Rename", onClick: vi.fn() },
  { key: "promote", label: "Promote to worktree…", onClick: vi.fn() },
  { key: "delete", label: "Delete", onClick: vi.fn() },
];

describe("ui/KebabMenu keyboard and menu semantics", () => {
  it("gives the icon-only trigger an accessible name", () => {
    render(<KebabMenu items={items} />);
    expect(screen.getByRole("button", { name: "More…" })).toBeInTheDocument();
  });

  it("uses a caller-supplied title as the accessible name", () => {
    render(<KebabMenu items={items} title="Session actions" />);
    expect(screen.getByRole("button", { name: "Session actions" })).toBeInTheDocument();
  });

  it("announces the trigger as a menu button and whether it is open", async () => {
    const user = userEvent.setup();
    render(<KebabMenu items={items} />);
    const trigger = screen.getByRole("button", { name: "More…" });

    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("exposes the menu and its items with menu roles", async () => {
    const user = userEvent.setup();
    render(<KebabMenu items={items} />);
    await user.click(screen.getByRole("button", { name: "More…" }));

    expect(screen.getByRole("menu")).toBeInTheDocument();
    const menuItems = screen.getAllByRole("menuitem");
    expect(menuItems.map((el) => el.textContent)).toEqual([
      "Rename",
      "Promote to worktree…",
      "Delete",
    ]);
  });

  it("opens with the Down Arrow key and moves focus into the menu", async () => {
    const user = userEvent.setup();
    render(<KebabMenu items={items} />);
    const trigger = screen.getByRole("button", { name: "More…" });
    trigger.focus();

    await user.keyboard("{ArrowDown}");

    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Rename" })).toHaveFocus();
  });

  it("moves between items with the arrow keys and Home/End", async () => {
    const user = userEvent.setup();
    render(<KebabMenu items={items} />);
    await user.click(screen.getByRole("button", { name: "More…" }));

    expect(screen.getByRole("menuitem", { name: "Rename" })).toHaveFocus();

    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Promote to worktree…" })).toHaveFocus();

    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveFocus();

    // Wraps around at the end.
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Rename" })).toHaveFocus();

    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveFocus();

    await user.keyboard("{Home}");
    expect(screen.getByRole("menuitem", { name: "Rename" })).toHaveFocus();

    await user.keyboard("{End}");
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveFocus();
  });

  it("closes on Escape and puts focus back on the trigger", async () => {
    const user = userEvent.setup();
    render(<KebabMenu items={items} />);
    const trigger = screen.getByRole("button", { name: "More…" });

    await user.click(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("runs the item's action when it is activated", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<KebabMenu items={[{ key: "one", label: "One", onClick }]} />);

    await user.click(screen.getByRole("button", { name: "More…" }));
    await user.click(screen.getByRole("menuitem", { name: "One" }));

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
