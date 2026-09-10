// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { KebabMenu } from "./KebabMenu.js";

// menuPlacement="top" (added for the Dock, whose kebabs sit near the bottom
// of the viewport and would otherwise drop a downward menu off-screen).
// jsdom returns an all-zero DOMRect from getBoundingClientRect by default, so
// the plain placement tests below can only assert WHICH inline style
// property the portal ends up with — they prove the wiring, not that the
// menu is actually visible or reachable at a real viewport size. The
// maxHeight tests further down stub a realistic rect instead, specifically
// to exercise the near-viewport-edge arithmetic a zero rect can't reach.
describe("ui/KebabMenu menuPlacement", () => {
  const items = [{ key: "only", label: "Only item", onClick: vi.fn() }];

  // Both offsets on the inactive axis must be the explicit string "auto",
  // never merely unset/"" — an unset `style.top` let .pane-tab-overflow-menu's
  // own stylesheet `top: 31px` leak through underneath an inline `bottom`,
  // which is exactly the bug that made a "top"-placed menu render 1000+px
  // tall (see getMenuStyle's own doc comment).
  it("defaults to a downward menu (top set, bottom auto)", async () => {
    const user = userEvent.setup();
    render(<KebabMenu items={items} />);

    await user.click(screen.getByRole("button"));

    const menu = document.querySelector(".pane-tab-overflow-menu") as HTMLElement;
    expect(menu).toBeInTheDocument();
    expect(menu.style.top).not.toBe("");
    expect(menu.style.bottom).toBe("auto");
  });

  it('menuPlacement="top" grows the menu upward (bottom set, top auto)', async () => {
    const user = userEvent.setup();
    render(<KebabMenu items={items} menuPlacement="top" />);

    await user.click(screen.getByRole("button"));

    const menu = document.querySelector(".pane-tab-overflow-menu") as HTMLElement;
    expect(menu).toBeInTheDocument();
    expect(menu.style.bottom).not.toBe("");
    expect(menu.style.top).toBe("auto");
  });
});

describe("ui/KebabMenu maxHeight floor", () => {
  const items = [{ key: "only", label: "Only item", onClick: vi.fn() }];

  // `rect.top - 8` (the "top" placement's raw maxHeight) goes negative once
  // the trigger sits within 8px of the top of the viewport — the Dock at its
  // minimum height is exactly this case. A negative `max-height` is an
  // invalid CSS length, so an unfloored value would be silently dropped by
  // the browser, un-capping the menu right back to the original bug. This
  // stubs a real (non-zero) rect specifically to exercise that arithmetic —
  // jsdom's default all-zero rect can't, since 0 - 8 is still negative but
  // gives no signal about whether the floor actually engaged.
  it('menuPlacement="top" floors maxHeight when the trigger sits near the top edge', async () => {
    const user = userEvent.setup();
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      top: 4,
      bottom: 20,
      left: 0,
      right: 100,
      width: 100,
      height: 16,
      x: 0,
      y: 4,
      toJSON: () => ({}),
    });
    try {
      render(<KebabMenu items={items} menuPlacement="top" />);
      await user.click(screen.getByRole("button"));

      const menu = document.querySelector(".pane-tab-overflow-menu") as HTMLElement;
      expect(menu).toBeInTheDocument();
      expect(menu.style.maxHeight).toBe("120px");
    } finally {
      rectSpy.mockRestore();
    }
  });

  // Mirror case for the default "bottom" placement: `window.innerHeight -
  // rect.bottom - 8` goes negative once the trigger sits within 8px of the
  // BOTTOM of the viewport.
  it('menuPlacement="bottom" floors maxHeight when the trigger sits near the bottom edge', async () => {
    const user = userEvent.setup();
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", { value: 30, configurable: true });
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      top: 0,
      bottom: 26,
      left: 0,
      right: 100,
      width: 100,
      height: 26,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    try {
      render(<KebabMenu items={items} />);
      await user.click(screen.getByRole("button"));

      const menu = document.querySelector(".pane-tab-overflow-menu") as HTMLElement;
      expect(menu).toBeInTheDocument();
      expect(menu.style.maxHeight).toBe("120px");
    } finally {
      rectSpy.mockRestore();
      Object.defineProperty(window, "innerHeight", {
        value: originalInnerHeight,
        configurable: true,
      });
    }
  });
});

// Issue #1106 — an item's `disabled` used to map straight to the native
// `disabled` attribute, which can't reliably carry an explanatory `title`
// (disabled controls don't receive pointer events, and tooltip display is
// tied to those). Switched to `aria-disabled` + a JS click guard instead.
describe("ui/KebabMenu disabled item — title and aria-disabled", () => {
  it("forwards an item's title onto its rendered button", async () => {
    const user = userEvent.setup();
    render(
      <KebabMenu
        items={[
          {
            key: "check-update",
            label: "Check for update",
            disabled: true,
            title: "No registry image to compare",
            onClick: vi.fn(),
          },
        ]}
      />,
    );

    await user.click(screen.getByRole("button"));

    const item = screen.getByText("Check for update").closest("button");
    expect(item).toHaveAttribute("title", "No registry image to compare");
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).not.toBeDisabled();
  });

  it("does not fire onClick for a disabled item even though the button itself stays enabled", async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(
      <KebabMenu
        items={[{ key: "check-update", label: "Check for update", disabled: true, onClick }]}
      />,
    );

    await user.click(screen.getByRole("button"));
    await user.click(screen.getByText("Check for update"));

    expect(onClick).not.toHaveBeenCalled();
  });

  it("an enabled item has no aria-disabled attribute at all", async () => {
    const user = userEvent.setup();
    render(<KebabMenu items={[{ key: "restart", label: "Restart service", onClick: vi.fn() }]} />);

    await user.click(screen.getByRole("button"));

    const item = screen.getByText("Restart service").closest("button");
    expect(item).not.toHaveAttribute("aria-disabled");
  });
});
