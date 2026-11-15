// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { KebabMenu } from "./KebabMenu.js";
import {
  flushRaf,
  installFakeVisualViewport,
  uninstallFakeVisualViewport,
} from "../test/fakeVisualViewport.js";

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

  // Issue #1402 — innerHeight stays the layout viewport when the iOS keyboard
  // is open. A downward cap must stop at the visible bottom.
  it("caps a downward menu against the visible viewport, not innerHeight", async () => {
    const user = userEvent.setup();
    installFakeVisualViewport(400, 100);
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      top: 120,
      bottom: 140,
      left: 0,
      right: 100,
      width: 100,
      height: 20,
      x: 0,
      y: 120,
      toJSON: () => ({}),
    });
    try {
      render(<KebabMenu items={items} />);
      await user.click(screen.getByRole("button"));

      const menu = document.querySelector(".pane-tab-overflow-menu") as HTMLElement;
      // visible bottom is 100 + 400 = 500, not innerHeight 800.
      expect(menu.style.maxHeight).toBe(`${500 - 140 - 8}px`);
    } finally {
      rectSpy.mockRestore();
      uninstallFakeVisualViewport();
      Object.defineProperty(window, "innerHeight", {
        value: originalInnerHeight,
        configurable: true,
      });
    }
  });

  // A free gap under the 120px floor must stay that gap. Flooring it back
  // up hid the menu behind the keyboard.
  it("does not floor a small positive gap back up to 120px", async () => {
    const user = userEvent.setup();
    installFakeVisualViewport(400, 100);
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      top: 458,
      bottom: 478,
      left: 0,
      right: 100,
      width: 100,
      height: 20,
      x: 0,
      y: 458,
      toJSON: () => ({}),
    });
    try {
      render(<KebabMenu items={items} />);
      await user.click(screen.getByRole("button"));
      const menu = document.querySelector(".pane-tab-overflow-menu") as HTMLElement;
      expect(menu.style.maxHeight).toBe("14px");
    } finally {
      rectSpy.mockRestore();
      uninstallFakeVisualViewport();
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

// Issue #1399 — since #1398 the toolbar moves with the iOS visual viewport
// when it pans with the keyboard open; an open menu must follow its trigger
// instead of staying where it was first drawn.
describe("ui/KebabMenu visual-viewport pan", () => {
  it("re-anchors the open menu to the trigger's moved rect", async () => {
    const user = userEvent.setup();
    const vv = installFakeVisualViewport();
    let triggerTop = 10;
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(() => ({
        top: triggerTop,
        bottom: triggerTop + 20,
        left: 0,
        right: 100,
        width: 100,
        height: 20,
        x: 0,
        y: triggerTop,
        toJSON: () => ({}),
      }));
    try {
      render(<KebabMenu items={[{ key: "only", label: "Only item", onClick: vi.fn() }]} />);
      await user.click(screen.getByRole("button"));
      const menu = document.querySelector(".pane-tab-overflow-menu") as HTMLElement;
      expect(menu.style.top).toBe("34px");

      triggerTop = 150;
      await act(async () => {
        vv.panTo(140);
        await flushRaf();
      });
      expect(menu.style.top).toBe("174px");
    } finally {
      rectSpy.mockRestore();
      uninstallFakeVisualViewport();
    }
  });
});

describe("ui/KebabMenu window resize", () => {
  it("re-anchors the open menu to the trigger's moved rect", async () => {
    const user = userEvent.setup();
    let triggerTop = 10;
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(() => ({
        top: triggerTop,
        bottom: triggerTop + 20,
        left: 0,
        right: 100,
        width: 100,
        height: 20,
        x: 0,
        y: triggerTop,
        toJSON: () => ({}),
      }));
    try {
      render(<KebabMenu items={[{ key: "only", label: "Only item", onClick: vi.fn() }]} />);
      await user.click(screen.getByRole("button"));
      const menu = document.querySelector(".pane-tab-overflow-menu") as HTMLElement;
      expect(menu.style.top).toBe("34px");

      triggerTop = 150;
      await act(async () => {
        window.dispatchEvent(new Event("resize"));
        await flushRaf();
      });
      expect(menu.style.top).toBe("174px");
    } finally {
      rectSpy.mockRestore();
    }
  });
});

describe('ui/KebabMenu menuPlacement="auto"', () => {
  const items = [{ key: "only", label: "Only item", onClick: vi.fn() }];

  function rectAt(top: number, bottom = top + 20): DOMRect {
    return {
      top,
      bottom,
      left: 0,
      right: 100,
      width: 100,
      height: bottom - top,
      x: 0,
      y: top,
      toJSON: () => ({}),
    };
  }

  function mockGeometry(top: number, bottom: number, menuHeight = 180) {
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(() => rectAt(top, bottom));
    const heightSpy = vi
      .spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockImplementation(function (this: HTMLElement) {
        return this.classList.contains("pane-tab-overflow-menu") ? menuHeight : 0;
      });
    return () => {
      rectSpy.mockRestore();
      heightSpy.mockRestore();
    };
  }

  it("flips upward near the bottom when the menu does not fit below", async () => {
    const user = userEvent.setup();
    const originalHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", { value: 500, configurable: true });
    const restore = mockGeometry(450, 470);
    try {
      render(<KebabMenu items={items} menuPlacement="auto" />);
      await user.click(screen.getByRole("button"));
      const menu = document.querySelector(".pane-tab-overflow-menu") as HTMLElement;
      expect(menu.style.bottom).not.toBe("auto");
      expect(menu.style.top).toBe("auto");
      expect(menu.style.maxHeight).toBe("442px");
    } finally {
      restore();
      Object.defineProperty(window, "innerHeight", { value: originalHeight, configurable: true });
    }
  });

  it('keeps explicit "bottom" placement and its small available-height cap', async () => {
    const user = userEvent.setup();
    installFakeVisualViewport(400, 100);
    const restore = mockGeometry(458, 478);
    try {
      render(<KebabMenu items={items} menuPlacement="bottom" />);
      await user.click(screen.getByRole("button"));
      const menu = document.querySelector(".pane-tab-overflow-menu") as HTMLElement;
      expect(menu.style.top).not.toBe("auto");
      expect(menu.style.bottom).toBe("auto");
      expect(menu.style.maxHeight).toBe("14px");
    } finally {
      restore();
      uninstallFakeVisualViewport();
    }
  });

  it("opens downward near the top when the menu fits below", async () => {
    const user = userEvent.setup();
    const originalHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", { value: 500, configurable: true });
    const restore = mockGeometry(20, 40);
    try {
      render(<KebabMenu items={items} menuPlacement="auto" />);
      await user.click(screen.getByRole("button"));
      const menu = document.querySelector(".pane-tab-overflow-menu") as HTMLElement;
      expect(menu.style.top).toBe("44px");
      expect(menu.style.bottom).toBe("auto");
    } finally {
      restore();
      Object.defineProperty(window, "innerHeight", { value: originalHeight, configurable: true });
    }
  });

  it("chooses the roomier side when neither side can fit the menu", async () => {
    const user = userEvent.setup();
    const originalHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", { value: 300, configurable: true });
    const restore = mockGeometry(170, 190, 220);
    try {
      render(<KebabMenu items={items} menuPlacement="auto" />);
      await user.click(screen.getByRole("button"));
      const menu = document.querySelector(".pane-tab-overflow-menu") as HTMLElement;
      // 162px above is roomier than 102px below.
      expect(menu.style.bottom).not.toBe("auto");
      expect(menu.style.maxHeight).toBe("162px");
    } finally {
      restore();
      Object.defineProperty(window, "innerHeight", { value: originalHeight, configurable: true });
    }
  });

  it("stays below when it fits there even if the space above is roomier", async () => {
    const user = userEvent.setup();
    const originalHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", { value: 500, configurable: true });
    const restore = mockGeometry(300, 320, 100);
    try {
      render(<KebabMenu items={items} menuPlacement="auto" />);
      await user.click(screen.getByRole("button"));
      const menu = document.querySelector(".pane-tab-overflow-menu") as HTMLElement;
      expect(menu.style.top).toBe("324px");
      expect(menu.style.bottom).toBe("auto");
    } finally {
      restore();
      Object.defineProperty(window, "innerHeight", { value: originalHeight, configurable: true });
    }
  });

  it("re-evaluates placement on window resize and visual viewport resize", async () => {
    const user = userEvent.setup();
    const originalHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", { value: 500, configurable: true });
    const vv = installFakeVisualViewport(500);
    let triggerTop = 100;
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(() => rectAt(triggerTop, triggerTop + 20));
    const heightSpy = vi
      .spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockImplementation(function (this: HTMLElement) {
        return this.classList.contains("pane-tab-overflow-menu") ? 180 : 0;
      });
    try {
      render(<KebabMenu items={items} menuPlacement="auto" />);
      await user.click(screen.getByRole("button"));
      const menu = document.querySelector(".pane-tab-overflow-menu") as HTMLElement;
      expect(menu.style.top).toBe("124px");

      triggerTop = 450;
      await act(async () => {
        window.dispatchEvent(new Event("resize"));
        await flushRaf();
      });
      expect(menu.style.bottom).not.toBe("auto");

      triggerTop = 100;
      await act(async () => {
        vv.resizeTo(150);
        await flushRaf();
      });
      expect(menu.style.bottom).not.toBe("auto");
      expect(menu.style.maxHeight).toBe("92px");
    } finally {
      rectSpy.mockRestore();
      heightSpy.mockRestore();
      uninstallFakeVisualViewport();
      Object.defineProperty(window, "innerHeight", { value: originalHeight, configurable: true });
    }
  });
});

// #3015 — the menu stays mounted while it leaves, then goes.
describe("ui/KebabMenu exit", () => {
  it("leaves the way it came, unreachable while it goes, then unmounts", async () => {
    const { installExitAnimations } = await import("../test/exitAnimations.js");
    const exits = installExitAnimations();
    try {
      const user = userEvent.setup();
      render(<KebabMenu items={[{ key: "a", label: "Item", onClick: vi.fn() }]} />);
      const trigger = screen.getByRole("button");
      await user.click(trigger);
      const menu = screen.getByRole("menu");
      expect(menu).toHaveAttribute("data-presence", "open");
      expect(menu).toHaveAttribute("data-placement", "bottom");

      await user.keyboard("{Escape}");
      expect(menu).toBeInTheDocument();
      expect(menu).toHaveAttribute("data-presence", "leaving");
      expect(menu).toHaveAttribute("inert");
      expect(trigger).toHaveFocus();

      await exits.finishExits();
      expect(menu).not.toBeInTheDocument();
    } finally {
      exits.restore();
    }
  });

  it("marks an upward menu so it grows from the edge nearest its trigger", async () => {
    const user = userEvent.setup();
    render(
      <KebabMenu items={[{ key: "a", label: "Item", onClick: vi.fn() }]} menuPlacement="top" />,
    );
    await user.click(screen.getByRole("button"));
    expect(screen.getByRole("menu")).toHaveAttribute("data-placement", "top");
  });
});

// #3071 — the opt-in touch variant and the outside press that must not strand
// focus on <body>.
describe("ui/KebabMenu sheet variant and focus", () => {
  function stubPointer(coarse: boolean) {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: coarse && query === "(pointer: coarse)",
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
  }
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const SHEET = { title: "mullion", closeLabel: "Close project actions" };

  it("opens a sheet under a coarse pointer, with the same items, and runs one", async () => {
    stubPointer(true);
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(
      <KebabMenu
        title="Manage mullion"
        menuLabel="mullion actions"
        items={[{ key: "edit", label: "Edit", onClick }]}
        sheet={SHEET}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Manage mullion" });
    expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
    await user.click(trigger);
    const sheet = screen.getByRole("dialog", { name: "mullion actions" });
    expect(document.querySelector(".pane-tab-overflow-menu")).toBeNull();
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(sheet).not.toBeInTheDocument();
  });

  it("keeps the popover under a fine pointer, and without `sheet` on any pointer", async () => {
    stubPointer(false);
    const user = userEvent.setup();
    const { unmount } = render(
      <KebabMenu
        title="Manage"
        items={[{ key: "a", label: "A", onClick: vi.fn() }]}
        sheet={SHEET}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Manage" }));
    expect(document.querySelector(".pane-tab-overflow-menu")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    unmount();

    stubPointer(true);
    render(<KebabMenu title="Plain" items={[{ key: "a", label: "A", onClick: vi.fn() }]} />);
    const plain = screen.getByRole("button", { name: "Plain" });
    expect(plain).toHaveAttribute("aria-haspopup", "menu");
    await user.click(plain);
    expect(screen.getByRole("menu", { name: "Plain" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("arrow keys move between items in the sheet", async () => {
    stubPointer(true);
    const user = userEvent.setup();
    render(
      <KebabMenu
        title="Manage"
        items={[
          { key: "a", label: "A", onClick: vi.fn() },
          { key: "b", label: "B", onClick: vi.fn() },
        ]}
        sheet={SHEET}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Manage" }));
    screen.getByRole("menuitem", { name: "A" }).focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "B" })).toHaveFocus();
  });

  it("a press outside on nothing focusable closes the popover and keeps focus on the trigger", async () => {
    stubPointer(false);
    const user = userEvent.setup();
    render(
      <div>
        <p>Plain text</p>
        <KebabMenu title="Manage" items={[{ key: "a", label: "A", onClick: vi.fn() }]} />
      </div>,
    );
    const trigger = screen.getByRole("button", { name: "Manage" });
    await user.click(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await user.click(screen.getByText("Plain text"));
    await vi.waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(trigger).toHaveFocus();
  });

  it("a press outside on a control lets that control take focus", async () => {
    stubPointer(false);
    const user = userEvent.setup();
    render(
      <div>
        <input aria-label="Elsewhere" />
        <KebabMenu title="Manage" items={[{ key: "a", label: "A", onClick: vi.fn() }]} />
      </div>,
    );
    await user.click(screen.getByRole("button", { name: "Manage" }));
    await user.click(screen.getByRole("textbox", { name: "Elsewhere" }));
    expect(screen.getByRole("textbox", { name: "Elsewhere" })).toHaveFocus();
  });

  it("a press outside on a tabindex=-1 container lets it take focus (a dockview pane)", async () => {
    stubPointer(false);
    const user = userEvent.setup();
    render(
      <div>
        <div tabIndex={-1} data-testid="pane">
          <p>Pane text</p>
        </div>
        <KebabMenu title="Manage" items={[{ key: "a", label: "A", onClick: vi.fn() }]} />
      </div>,
    );
    await user.click(screen.getByRole("button", { name: "Manage" }));
    await user.click(screen.getByText("Pane text"));
    expect(screen.getByTestId("pane")).toHaveFocus();
  });
});

// #3073 — "side" opens the menu beside its trigger (the workspace picker's
// row "⋯"), so the popover the trigger sits in stays visible.
describe('ui/KebabMenu menuPlacement="side"', () => {
  const items = [{ key: "only", label: "Only item", onClick: vi.fn() }];

  function mockGeometry(
    trigger: { top: number; left: number },
    viewport: { width: number; height: number },
  ) {
    const original = { width: window.innerWidth, height: window.innerHeight };
    Object.defineProperty(window, "innerWidth", { value: viewport.width, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: viewport.height, configurable: true });
    const rect = {
      top: trigger.top,
      bottom: trigger.top + 20,
      left: trigger.left,
      right: trigger.left + 20,
      width: 20,
      height: 20,
      x: trigger.left,
      y: trigger.top,
      toJSON: () => ({}),
    };
    const spies = [
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect),
      vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (
        this: HTMLElement,
      ) {
        return this.classList.contains("pane-tab-overflow-menu") ? 180 : 0;
      }),
      vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (
        this: HTMLElement,
      ) {
        return this.classList.contains("pane-tab-overflow-menu") ? 214 : 0;
      }),
    ];
    return () => {
      spies.forEach((s) => s.mockRestore());
      Object.defineProperty(window, "innerWidth", { value: original.width, configurable: true });
      Object.defineProperty(window, "innerHeight", { value: original.height, configurable: true });
    };
  }

  const openMenu = async () => {
    const user = userEvent.setup();
    render(<KebabMenu items={items} menuPlacement="side" menuClassName="extra-menu" />);
    await user.click(screen.getByRole("button"));
    return screen.getByRole("menu");
  };

  it("opens to the right of the trigger, top-aligned with it, with the extra class", async () => {
    const restore = mockGeometry({ top: 100, left: 300 }, { width: 1024, height: 800 });
    try {
      const menu = await openMenu();
      expect(menu).toHaveClass("pane-tab-overflow-menu", "extra-menu");
      expect(menu).toHaveAttribute("data-placement", "side");
      expect(menu.style.left).toBe("324px");
      expect(menu.style.right).toBe("auto");
      expect(menu.style.top).toBe("96px");
      expect(menu.style.bottom).toBe("auto");
    } finally {
      restore();
    }
  });

  it("opens to the left when the right has no room", async () => {
    const restore = mockGeometry({ top: 100, left: 300 }, { width: 500, height: 800 });
    try {
      const menu = await openMenu();
      expect(menu.style.left).toBe("auto");
      expect(menu.style.right).toBe("204px");
      // Grows from the trigger's edge, which is now its right.
      expect(menu).toHaveAttribute("data-placement", "side-left");
    } finally {
      restore();
    }
  });

  it("follows its trigger when a list it sits in scrolls", async () => {
    const restore = mockGeometry({ top: 100, left: 300 }, { width: 1024, height: 800 });
    const rectAt = (top: number) => ({
      top,
      bottom: top + 20,
      left: 300,
      right: 320,
      width: 20,
      height: 20,
      x: 300,
      y: top,
      toJSON: () => ({}),
    });
    try {
      const menu = await openMenu();
      expect(menu.style.top).toBe("96px");
      // The same spy mockGeometry installed: the row scrolled up 60px.
      vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue(rectAt(40));
      act(() => {
        document.body.dispatchEvent(new Event("scroll"));
      });
      expect(menu.style.top).toBe("36px");
      // The menu's own scroll moves nothing it is anchored to.
      vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue(rectAt(300));
      act(() => {
        menu.dispatchEvent(new Event("scroll"));
      });
      expect(menu.style.top).toBe("36px");
    } finally {
      restore();
    }
  });

  it("moves up to stay on screen for a trigger near the bottom", async () => {
    const restore = mockGeometry({ top: 700, left: 300 }, { width: 1024, height: 800 });
    try {
      const menu = await openMenu();
      // 800 - 8 - 180: the menu's bottom edge 8px above the viewport's.
      expect(menu.style.top).toBe("612px");
      expect(menu.style.maxHeight).toBe("180px");
    } finally {
      restore();
    }
  });
});

// PR #3081 review — an `opensOverlay` confirm item suppresses the focus
// restore only on the click that fires it: arming it and then cancelling
// still returns focus to the trigger.
describe("ui/KebabMenu confirm + opensOverlay", () => {
  it("returns focus to the trigger when an armed item is cancelled", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <KebabMenu
        title="Manage"
        items={[
          {
            key: "delete",
            label: "Delete",
            armLabel: "Click again to delete",
            confirm: true,
            opensOverlay: true,
            onClick,
          },
        ]}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Manage" });
    await user.click(trigger);
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(screen.getByRole("menuitem", { name: /Click again/ })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveFocus();
    expect(onClick).not.toHaveBeenCalled();
  });
});
