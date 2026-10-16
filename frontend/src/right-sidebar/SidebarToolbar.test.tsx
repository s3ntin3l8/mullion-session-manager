// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SidebarToolbar } from "./SidebarToolbar.js";
import { SidebarToolbarSlotContext } from "./sidebarToolbarSlot.js";
import { RefreshIcon } from "../ui/icons.js";

const actions = (onClick = vi.fn()) => [
  { key: "refresh", label: "Refresh", icon: RefreshIcon, onClick },
];

describe("SidebarToolbar", () => {
  it("renders inline when there is no slot", async () => {
    const onClick = vi.fn();
    render(<SidebarToolbar actions={actions(onClick)} />);

    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(onClick).toHaveBeenCalled();
  });

  it("portals into the slot when one is provided", () => {
    const slot = document.createElement("div");
    document.body.appendChild(slot);
    const { container } = render(
      <SidebarToolbarSlotContext.Provider value={slot}>
        <SidebarToolbar actions={actions()} />
      </SidebarToolbarSlotContext.Provider>,
    );

    expect(container.querySelector("button")).toBeNull();
    expect(slot.querySelector("button[aria-label='Refresh']")).toBeTruthy();
    slot.remove();
  });
});
