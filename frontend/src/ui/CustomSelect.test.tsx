// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CustomSelect } from "./CustomSelect.js";
import {
  installFakeVisualViewport,
  uninstallFakeVisualViewport,
  type FakeVisualViewport,
} from "../test/fakeVisualViewport.js";

vi.mock("../store/index.js", () => ({
  useDashboardStore: (selector: (s: unknown) => unknown) => selector({ theme: "dark" }),
}));

const OPTIONS = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
];

// Issue #1399 — an iOS visual-viewport pan (keyboard open) moves the toolbar
// since #1398 without reliably firing a window `scroll`/`resize`, which is
// all CustomSelect used to close on; its portaled listbox would otherwise
// stay behind while its trigger moves.
describe("ui/CustomSelect closes on a visual-viewport change", () => {
  let vv: FakeVisualViewport;

  beforeEach(() => {
    vv = installFakeVisualViewport();
  });

  afterEach(() => {
    uninstallFakeVisualViewport();
  });

  async function openSelect() {
    render(<CustomSelect value="a" onChange={vi.fn()} options={OPTIONS} label="Pick" />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Pick" }));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  }

  it("closes the open listbox on a visual-viewport scroll (pan)", async () => {
    await openSelect();
    act(() => vv.panTo(140));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("closes the open listbox on a visual-viewport resize", async () => {
    await openSelect();
    act(() => vv.resizeTo(500));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("still closes on a window resize", async () => {
    await openSelect();
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});

describe("ui/CustomSelect caps against the visible viewport", () => {
  afterEach(() => {
    uninstallFakeVisualViewport();
  });

  it("caps maxHeight at the visible bottom, not innerHeight", async () => {
    installFakeVisualViewport(400, 100);
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      top: 160,
      bottom: 200,
      left: 0,
      right: 120,
      width: 120,
      height: 40,
      x: 0,
      y: 160,
      toJSON: () => ({}),
    });
    try {
      render(<CustomSelect value="a" onChange={vi.fn()} options={OPTIONS} label="Pick" />);
      await userEvent.setup().click(screen.getByRole("button", { name: "Pick" }));
      // The style lives on the portaled MENU (the listbox is a child of it
      // now — the filter input above the options is not an option itself).
      const menu = document.querySelector(".custom-select-menu") as HTMLElement;
      expect(menu.style.maxHeight).toBe(`${100 + 400 - 200 - 8}px`);
      expect(menu.style.overflowY).toBe("auto");
    } finally {
      rectSpy.mockRestore();
      Object.defineProperty(window, "innerHeight", {
        value: originalInnerHeight,
        configurable: true,
      });
    }
  });

  it("floors maxHeight when the trigger is flush with the visible edge", async () => {
    installFakeVisualViewport(400, 100);
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      top: 460,
      bottom: 500,
      left: 0,
      right: 120,
      width: 120,
      height: 40,
      x: 0,
      y: 460,
      toJSON: () => ({}),
    });
    try {
      render(<CustomSelect value="a" onChange={vi.fn()} options={OPTIONS} label="Pick" />);
      await userEvent.setup().click(screen.getByRole("button", { name: "Pick" }));
      const menu = document.querySelector(".custom-select-menu") as HTMLElement;
      expect(menu.style.maxHeight).toBe("120px");
    } finally {
      rectSpy.mockRestore();
    }
  });
});

// Issue #2495 — the dock's branch picker opened a list that ran off the left
// edge of the screen, with long branch names clipped on that side and no way
// to find one branch among dozens. The fixes live in CustomSelect itself
// (opt-in `searchable`), so every long list can adopt them.
describe("ui/CustomSelect keeps the menu inside the viewport (issue #2495)", () => {
  const originalInnerWidth = window.innerWidth;

  afterEach(() => {
    uninstallFakeVisualViewport();
    Object.defineProperty(window, "innerWidth", {
      value: originalInnerWidth,
      configurable: true,
    });
    vi.restoreAllMocks();
  });

  function mockTriggerRect(rect: Partial<DOMRect>) {
    return vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      top: 160,
      bottom: 200,
      left: 0,
      right: 120,
      width: 120,
      height: 40,
      x: 0,
      y: 160,
      toJSON: () => ({}),
      ...rect,
    } as DOMRect);
  }

  it("caps the menu's width to the room it has, so it cannot run past the viewport edge", async () => {
    Object.defineProperty(window, "innerWidth", { value: 500, configurable: true });
    // A trigger near the RIGHT edge, with a right-aligned menu: the menu
    // grows to the trigger's LEFT, which is where it used to leave the
    // screen.
    mockTriggerRect({ left: 420, right: 490, width: 70, x: 420 });
    const user = userEvent.setup();
    render(
      <CustomSelect
        value="a"
        onChange={vi.fn()}
        options={OPTIONS}
        label="Pick"
        menuAlign="right"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Pick" }));

    const menu = document.querySelector(".custom-select-menu") as HTMLElement;
    const maxWidth = Number.parseFloat(menu.style.maxWidth);
    expect(maxWidth).toBeGreaterThan(0);
    // Right-aligned: the menu's LEFT edge is the trigger's right edge minus
    // its width, and that must stay on screen.
    expect(490 - maxWidth).toBeGreaterThanOrEqual(0);
    expect(maxWidth).toBeLessThanOrEqual(500);
  });

  it("flips to the other side of the trigger when the preferred side cannot fit the menu", async () => {
    Object.defineProperty(window, "innerWidth", { value: 500, configurable: true });
    // A trigger hard against the LEFT edge with a right-aligned menu: there
    // is no room to the left, so the menu opens to the right instead.
    mockTriggerRect({ left: 4, right: 44, width: 40, x: 4 });
    const user = userEvent.setup();
    render(
      <CustomSelect
        value="a"
        onChange={vi.fn()}
        options={OPTIONS}
        label="Pick"
        menuAlign="right"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Pick" }));

    const menu = document.querySelector(".custom-select-menu") as HTMLElement;
    expect(menu.style.right).toBe("auto");
    expect(menu.style.left).toBe("4px");
    expect(Number.parseFloat(menu.style.maxWidth)).toBeGreaterThanOrEqual(140);
  });
});

describe("ui/CustomSelect's searchable menu (issue #2495)", () => {
  const LONG_BRANCH = "fix(dock): the dock branch picker runs off-screen and can't be searched";

  const originalInnerWidth = window.innerWidth;

  afterEach(() => {
    uninstallFakeVisualViewport();
    vi.restoreAllMocks();
    Object.defineProperty(window, "innerWidth", {
      value: originalInnerWidth,
      configurable: true,
    });
  });

  async function openSearchable(
    options = OPTIONS,
    props: { emptyMessage?: string; onChange?: (value: string) => void } = {},
  ) {
    const user = userEvent.setup();
    render(
      <CustomSelect
        value="a"
        onChange={props.onChange ?? vi.fn()}
        options={options}
        label="Pick"
        searchable
        emptyMessage={props.emptyMessage}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Pick" }));
    return user;
  }

  it("is opt-in — a plain select keeps the list it has today", async () => {
    const user = userEvent.setup();
    render(<CustomSelect value="a" onChange={vi.fn()} options={OPTIONS} label="Pick" />);
    await user.click(screen.getByRole("button", { name: "Pick" }));

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("is opt-in — a plain select with no options gets no empty state either", async () => {
    const user = userEvent.setup();
    render(<CustomSelect value="" onChange={vi.fn()} options={[]} label="Pick" />);
    await user.click(screen.getByRole("button", { name: "Pick" }));

    expect(screen.queryByText("No matching options")).not.toBeInTheDocument();
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("puts the focus in the filter input, so typing filters right away", async () => {
    await openSearchable();
    expect(screen.getByRole("combobox")).toHaveFocus();
  });

  it("narrows the options as the user types (case-insensitive substring)", async () => {
    const user = await openSearchable();
    await user.type(screen.getByRole("combobox"), "BET");

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("Beta");
  });

  it("keeps the arrow keys and Enter working on the filtered list", async () => {
    const onChange = vi.fn();
    const user = await openSearchable(OPTIONS, { onChange });
    await user.type(screen.getByRole("combobox"), "alph");
    expect(screen.getAllByRole("option")).toHaveLength(1);

    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("a");
    // The menu closes on the selection.
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("moves the highlight with the arrow keys over the filtered list", async () => {
    const user = await openSearchable([
      { value: "a", label: "Alpha" },
      { value: "b", label: "Beta" },
      { value: "c", label: "Alphabet" },
    ]);
    await user.type(screen.getByRole("combobox"), "alph");
    expect(screen.getAllByRole("option")).toHaveLength(2);

    await user.keyboard("{ArrowDown}");
    expect(document.querySelectorAll(".custom-select-item.focused")).toHaveLength(1);
    expect(screen.getByRole("combobox").getAttribute("aria-activedescendant")).toBe(
      "custom-select-opt-1",
    );
  });

  it("clears the filter on the first Escape and closes the menu on the second", async () => {
    const user = await openSearchable();
    const input = screen.getByRole("combobox");
    await user.type(input, "bet");
    expect(screen.getAllByRole("option")).toHaveLength(1);

    await user.keyboard("{Escape}");
    // The filter is cleared, the menu stays open, and the full list is back.
    expect(screen.getByRole("combobox")).toHaveValue("");
    expect(screen.getAllByRole("option")).toHaveLength(2);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("hands the focus on with Tab instead of dropping it to <body>", async () => {
    const user = userEvent.setup();
    render(
      <>
        <CustomSelect value="a" onChange={vi.fn()} options={OPTIONS} label="Pick" searchable />
        <button type="button">after</button>
      </>,
    );
    await user.click(screen.getByRole("button", { name: "Pick" }));
    expect(screen.getByRole("combobox")).toHaveFocus();

    await user.keyboard("{Tab}");

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    // The filter input unmounts with the menu; the focus must continue from
    // the trigger to the next control rather than land on <body>.
    expect(screen.getByRole("button", { name: "after" })).toHaveFocus();
  });

  it("shows the empty state when the filter matches nothing", async () => {
    const user = await openSearchable();
    await user.type(screen.getByRole("combobox"), "zzz");

    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("No matching options")).toBeInTheDocument();
  });

  it("shows the caller's own empty message", async () => {
    const user = await openSearchable(OPTIONS, { emptyMessage: "No matching branches" });
    await user.type(screen.getByRole("combobox"), "zzz");

    expect(screen.getByText("No matching branches")).toBeInTheDocument();
  });

  it("middle-truncates a long label and keeps the full name in the tooltip and the accessible name", async () => {
    Object.defineProperty(window, "innerWidth", { value: 400, configurable: true });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      top: 160,
      bottom: 200,
      left: 300,
      right: 380,
      width: 80,
      height: 40,
      x: 300,
      y: 160,
      toJSON: () => ({}),
    } as DOMRect);
    await openSearchable([{ value: "x", label: LONG_BRANCH }]);

    const option = screen.getByRole("option");
    const shown = option.textContent ?? "";
    // Cut in the middle: the start stays readable and the distinctive tail
    // survives next to the ellipsis.
    expect(shown).toContain("…");
    expect(shown.startsWith("fix(dock): the")).toBe(true);
    expect(shown.endsWith("searched")).toBe(true);
    expect(shown.length).toBeLessThan(LONG_BRANCH.length);
    // The full name is still there — for the tooltip and for assistive tech.
    expect(option).toHaveAttribute("title", LONG_BRANCH);
    expect(option).toHaveAttribute("aria-label", LONG_BRANCH);
  });
});
