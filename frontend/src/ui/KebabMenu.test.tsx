// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { KebabMenu } from "./KebabMenu.js";

// menuPlacement="top" (added for the Dock, whose kebabs sit near the bottom
// of the viewport and would otherwise drop a downward menu off-screen).
// jsdom returns an all-zero DOMRect from getBoundingClientRect, so these
// tests can only assert WHICH inline style property the portal ends up
// with — they prove the wiring, not that the menu is actually visible or
// reachable at a real viewport size. That's a manual check (drag the Dock
// to its minimum height and open a kebab), not something jsdom can cover.
describe("ui/KebabMenu menuPlacement", () => {
  const items = [{ key: "only", label: "Only item", onClick: vi.fn() }];

  it("defaults to a downward menu (top set, bottom unset)", async () => {
    const user = userEvent.setup();
    render(<KebabMenu items={items} />);

    await user.click(screen.getByRole("button"));

    const menu = document.querySelector(".pane-tab-overflow-menu") as HTMLElement;
    expect(menu).toBeInTheDocument();
    expect(menu.style.top).not.toBe("");
    expect(menu.style.bottom).toBe("");
  });

  it('menuPlacement="top" grows the menu upward (bottom set, top unset)', async () => {
    const user = userEvent.setup();
    render(<KebabMenu items={items} menuPlacement="top" />);

    await user.click(screen.getByRole("button"));

    const menu = document.querySelector(".pane-tab-overflow-menu") as HTMLElement;
    expect(menu).toBeInTheDocument();
    expect(menu.style.bottom).not.toBe("");
    expect(menu.style.top).toBe("");
  });
});
