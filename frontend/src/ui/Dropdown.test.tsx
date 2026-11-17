// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Dropdown, Row } from "./primitives.js";
import { Modal } from "./Modal.js";
import { expectNameHasVisibleText, expectNoNestedInteractive } from "../test/a11y.js";
import { dropdownLabel, dropdownValue, pickDropdownOption } from "../test/dropdown.js";
import { resolvePlacement } from "./selectMenuGeometry.js";

// The shared Dropdown (#3245): a styled listbox under a fine pointer,
// following the WAI-ARIA select-only combobox pattern, and a native <select>
// under a coarse one.

const FRUIT = [
  { value: "apple", label: "Apple" },
  { value: "apricot", label: "Apricot" },
  { value: "banana", label: "Banana" },
  { value: "cherry", label: "Cherry", disabled: true },
  { value: "date", label: "Date" },
];

function Harness({
  initial = "apple",
  onChange,
  ariaLabel = "Fruit",
  options = FRUIT,
  action,
}: {
  initial?: string;
  onChange?: (v: string) => void;
  ariaLabel?: string;
  options?: typeof FRUIT;
  action?: { label: string; onSelect: () => void };
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <Dropdown
        ariaLabel={ariaLabel}
        value={value}
        options={options}
        action={action}
        onChange={(v) => {
          setValue(v);
          onChange?.(v);
        }}
      />
      <button type="button">After</button>
    </>
  );
}

function stubCoarse() {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query === "(pointer: coarse)",
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

const field = () => screen.getByRole("combobox", { name: "Fruit" });
const activeOption = () =>
  document.getElementById(field().getAttribute("aria-activedescendant") ?? "");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Dropdown under a fine pointer: roles and names", () => {
  it("is a combobox that controls a listbox of options", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const combo = field();
    expect(combo.tagName).toBe("BUTTON");
    expect(combo).toHaveAttribute("aria-haspopup", "listbox");
    expect(combo).toHaveAttribute("aria-expanded", "false");
    expect(combo).not.toHaveAttribute("aria-activedescendant");
    expect(dropdownLabel(combo)).toBe("Apple");

    await user.click(combo);
    expect(combo).toHaveAttribute("aria-expanded", "true");
    const listbox = screen.getByRole("listbox", { name: "Fruit" });
    expect(combo).toHaveAttribute("aria-controls", listbox.id);
    const options = within(listbox).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "Apple",
      "Apricot",
      "Banana",
      "Cherry",
      "Date",
    ]);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(options[1]).toHaveAttribute("aria-selected", "false");
    expect(options[3]).toHaveAttribute("aria-disabled", "true");
    // The highlight starts on the value, and the focus stays on the field.
    expect(combo).toHaveAttribute("aria-activedescendant", options[0]!.id);
    expect(combo).toHaveFocus();
  });

  it("an open dropdown passes the a11y rules the unit suite carries", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(field());
    // The list is portaled to <body>, so check the whole document.
    expectNoNestedInteractive(document.body);
    for (const option of screen.getAllByRole("option")) expectNameHasVisibleText(option);
    expect(screen.getByRole("listbox")).toHaveAccessibleName("Fruit");
  });

  it("takes its name from a Row label", () => {
    render(
      <Row label="Terminal font">
        <Dropdown value="a" onChange={() => {}} options={[{ value: "a", label: "Mono" }]} />
      </Row>,
    );
    expect(screen.getByRole("combobox", { name: "Terminal font" })).toBeInTheDocument();
  });

  it("takes its name from an external <label htmlFor>, and a click on that label only focuses it", async () => {
    const user = userEvent.setup();
    render(
      <>
        <label htmlFor="pick-fruit">Pick a fruit</label>
        <Dropdown id="pick-fruit" value="apple" onChange={() => {}} options={FRUIT.slice(0, 2)} />
      </>,
    );
    const combo = screen.getByRole("combobox", { name: "Pick a fruit" });
    await user.click(screen.getByText("Pick a fruit"));
    expect(combo).toHaveFocus();
    expect(combo).toHaveAttribute("aria-expanded", "false");
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("listbox", { name: "Pick a fruit" })).toBeInTheDocument();
  });

  it("forwards title and disabled", async () => {
    const user = userEvent.setup();
    render(
      <Dropdown
        ariaLabel="Fruit"
        title="Choose one"
        disabled
        value="apple"
        onChange={() => {}}
        options={FRUIT}
      />,
    );
    expect(field()).toHaveAttribute("title", "Choose one");
    expect(field()).toBeDisabled();
    await user.click(field());
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("shows the first option when the value matches none, as a native select does", () => {
    render(<Dropdown ariaLabel="Fruit" value="kiwi" onChange={() => {}} options={FRUIT} />);
    expect(dropdownLabel(field())).toBe("Apple");
    // Read as a native select reports it.
    expect(dropdownValue(field())).toBe("apple");
  });
});

describe("Dropdown under a fine pointer: keyboard", () => {
  it.each(["{Enter}", " ", "{ArrowDown}", "{ArrowUp}"])("%s opens the list", async (key) => {
    const user = userEvent.setup();
    render(<Harness initial="banana" />);
    field().focus();
    await user.keyboard(key);
    expect(field()).toHaveAttribute("aria-expanded", "true");
    expect(activeOption()).toHaveTextContent("Banana");
  });

  it("Home and End open the list on the first and last option", async () => {
    const user = userEvent.setup();
    render(<Harness initial="banana" />);
    field().focus();
    await user.keyboard("{End}");
    expect(activeOption()).toHaveTextContent("Date");
    await user.keyboard("{Escape}{Home}");
    expect(activeOption()).toHaveTextContent("Apple");
  });

  it("arrows move the highlight, skip disabled options and stop at the ends", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial="banana" onChange={onChange} />);
    field().focus();
    await user.keyboard("{ArrowDown}{ArrowDown}");
    // Cherry is disabled: the highlight goes past it.
    expect(activeOption()).toHaveTextContent("Date");
    await user.keyboard("{ArrowDown}");
    expect(activeOption()).toHaveTextContent("Date");
    await user.keyboard("{ArrowUp}");
    expect(activeOption()).toHaveTextContent("Banana");
    await user.keyboard("{Home}");
    expect(activeOption()).toHaveTextContent("Apple");
    await user.keyboard("{ArrowUp}");
    expect(activeOption()).toHaveTextContent("Apple");
    await user.keyboard("{End}{PageUp}");
    expect(activeOption()).toHaveTextContent("Apple");
    await user.keyboard("{PageDown}");
    expect(activeOption()).toHaveTextContent("Date");
    // Moving the highlight does not change the value.
    expect(onChange).not.toHaveBeenCalled();
  });

  it("Enter commits the highlighted option and closes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    field().focus();
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenCalledWith("apricot");
    expect(field()).toHaveAttribute("aria-expanded", "false");
    expect(dropdownLabel(field())).toBe("Apricot");
    expect(field()).toHaveFocus();
  });

  it("Space commits too, and Alt+ArrowUp commits and closes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    field().focus();
    await user.keyboard("{ArrowDown}{ArrowDown} ");
    expect(onChange).toHaveBeenLastCalledWith("apricot");
    await user.keyboard("{ArrowDown}{ArrowDown}{Alt>}{ArrowUp}{/Alt}");
    expect(onChange).toHaveBeenLastCalledWith("banana");
    expect(field()).toHaveAttribute("aria-expanded", "false");
  });

  it("Escape closes and keeps the value", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    field().focus();
    await user.keyboard("{ArrowDown}{ArrowDown}{Escape}");
    expect(field()).toHaveAttribute("aria-expanded", "false");
    expect(onChange).not.toHaveBeenCalled();
    expect(dropdownLabel(field())).toBe("Apple");
    expect(field()).toHaveFocus();
  });

  it("Tab commits the highlighted option and moves the focus on", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    field().focus();
    await user.keyboard("{ArrowDown}{ArrowDown}");
    await user.tab();
    expect(onChange).toHaveBeenCalledWith("apricot");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("button", { name: "After" })).toHaveFocus();
  });

  it("typeahead opens the list, cycles a repeated letter and narrows by more letters", () => {
    render(<Harness initial="date" />);
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    act(() => {
      fireEvent.keyDown(field(), { key: "a" });
    });
    expect(field()).toHaveAttribute("aria-expanded", "true");
    expect(activeOption()).toHaveTextContent("Apple");
    now.mockReturnValue(1_100);
    act(() => {
      fireEvent.keyDown(field(), { key: "a" });
    });
    expect(activeOption()).toHaveTextContent("Apricot");
    // A new search after the window closes: "ap" then "r" narrows to Apricot.
    now.mockReturnValue(5_000);
    act(() => {
      fireEvent.keyDown(field(), { key: "b" });
    });
    expect(activeOption()).toHaveTextContent("Banana");
    now.mockReturnValue(9_000);
    act(() => {
      fireEvent.keyDown(field(), { key: "a" });
    });
    now.mockReturnValue(9_100);
    act(() => {
      fireEvent.keyDown(field(), { key: "p" });
    });
    now.mockReturnValue(9_200);
    act(() => {
      fireEvent.keyDown(field(), { key: "r" });
    });
    expect(activeOption()).toHaveTextContent("Apricot");
    // A disabled option is never a match.
    now.mockReturnValue(20_000);
    act(() => {
      fireEvent.keyDown(field(), { key: "c" });
    });
    expect(activeOption()).toHaveTextContent("Apricot");
  });

  it("a space inside a typeahead run searches rather than commits", () => {
    const onChange = vi.fn();
    render(
      <Harness
        onChange={onChange}
        options={[
          { value: "a", label: "my app" },
          { value: "b", label: "my api" },
        ]}
      />,
    );
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    for (const [i, key] of [..."my a"].entries()) {
      now.mockReturnValue(1_000 + i * 50);
      act(() => {
        fireEvent.keyDown(field(), { key });
      });
    }
    expect(onChange).not.toHaveBeenCalled();
    expect(field()).toHaveAttribute("aria-expanded", "true");
  });

  it("closed, a modified key or Escape is left to the page", () => {
    render(<Harness />);
    expect(fireEvent.keyDown(field(), { key: "a", ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(field(), { key: "Escape" })).toBe(true);
    expect(field()).toHaveAttribute("aria-expanded", "false");
  });
});

describe("Dropdown under a fine pointer: pointer", () => {
  it("a click on an option commits it; a click outside closes without a change", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.click(field());
    await user.click(screen.getByRole("option", { name: "Banana" }));
    expect(onChange).toHaveBeenCalledWith("banana");
    expect(field()).toHaveFocus();
    await user.click(field());
    await user.click(screen.getByRole("button", { name: "After" }));
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("a disabled option ignores the click", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.click(field());
    await user.click(screen.getByRole("option", { name: "Cherry" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a press on an option or the list keeps the focus on the field", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(field());
    const option = screen.getByRole("option", { name: "Banana" });
    expect(fireEvent.mouseDown(option)).toBe(false);
    expect(fireEvent.mouseDown(screen.getByRole("listbox").parentElement!)).toBe(false);
    expect(field()).toHaveFocus();
  });

  it("the list closes when the focus leaves the field", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.click(field());
    act(() => screen.getByRole("button", { name: "After" }).focus());
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("options that change while the list is open put the highlight back on the value", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const { rerender } = render(
      <Harness options={FRUIT.slice(0, 2)} action={{ label: "Add fruit…", onSelect }} />,
    );
    field().focus();
    await user.keyboard("{End}");
    expect(activeOption()).toHaveTextContent("Add fruit…");
    // A third option arrives: the old action index now points at Banana.
    rerender(<Harness options={FRUIT.slice(0, 3)} action={{ label: "Add fruit…", onSelect }} />);
    expect(activeOption()).toHaveTextContent("Apple");
    await user.keyboard("{Enter}");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("a closing list keeps its side and position while it leaves", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    vi.spyOn(field(), "getBoundingClientRect").mockReturnValue({
      top: 540,
      bottom: 570,
      left: 100,
      right: 280,
      width: 180,
      height: 30,
      x: 100,
      y: 540,
      toJSON: () => ({}),
    } as DOMRect);
    vi.stubGlobal("innerHeight", 600);
    await user.click(field());
    const menu = screen.getByRole("listbox").parentElement!;
    expect(menu).toHaveAttribute("data-placement", "top");
    // Played out: jsdom has no animations, so the menu unmounts at once;
    // what it rendered on its way out is what the exit would play from.
    const seen: Array<string | null> = [];
    const observer = new MutationObserver(() => seen.push(menu.getAttribute("data-placement")));
    observer.observe(menu, { attributes: true });
    await user.keyboard("{Escape}");
    observer.disconnect();
    expect(seen.every((p) => p === "top")).toBe(true);
  });

  it("a second click on the field closes the list", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(field());
    await user.click(field());
    expect(field()).toHaveAttribute("aria-expanded", "false");
  });

  it("an action row runs its command and never becomes the value", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onSelect = vi.fn();
    render(<Harness onChange={onChange} action={{ label: "Add fruit…", onSelect }} />);
    await user.click(field());
    await user.click(screen.getByRole("option", { name: "Add fruit…" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
    // Tab past the action row only closes the list.
    field().focus();
    await user.keyboard("{End}");
    expect(activeOption()).toHaveTextContent("Add fruit…");
    await user.tab();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("Dropdown inside a modal", () => {
  it("the first Escape closes the list, the second the dialog", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Modal title="Settings" onClose={onClose}>
        <Harness />
      </Modal>,
    );
    field().focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(field()).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a window Escape listener does not see the Escape that closed the list", async () => {
    const user = userEvent.setup();
    const onWindowEscape = vi.fn();
    const listener = (e: KeyboardEvent) => {
      if (e.key === "Escape") onWindowEscape();
    };
    window.addEventListener("keydown", listener);
    render(<Harness />);
    field().focus();
    await user.keyboard("{ArrowDown}{Escape}");
    expect(onWindowEscape).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(onWindowEscape).toHaveBeenCalledTimes(1);
    window.removeEventListener("keydown", listener);
  });
});

describe("Dropdown list placement", () => {
  beforeEach(() => {
    vi.stubGlobal("innerHeight", 600);
    vi.stubGlobal("innerWidth", 800);
  });

  const rect = (top: number, height = 30, left = 100, width = 180) =>
    ({
      top,
      bottom: top + height,
      left,
      right: left + width,
      width,
      height,
      x: left,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;

  it("opens below when the list fits there, above near the bottom of the screen", () => {
    expect(resolvePlacement(rect(100), "auto", 5)).toBe("bottom");
    expect(resolvePlacement(rect(540), "auto", 5)).toBe("top");
    // A fixed placement is kept as asked.
    expect(resolvePlacement(rect(540), "bottom", 5)).toBe("bottom");
  });

  it("the open list is as wide as its field, drawn fixed to the viewport, and above near the bottom", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    vi.spyOn(field(), "getBoundingClientRect").mockReturnValue(rect(540));
    await user.click(field());
    const menu = screen.getByRole("listbox").parentElement!;
    expect(menu.style.position).toBe("fixed");
    expect(menu.style.minWidth).toBe("180px");
    expect(menu).toHaveAttribute("data-placement", "top");
    // Never past the viewport: the room right of the field, less the margin.
    expect(menu.style.maxWidth).toBe("692px");
    // Portaled to <body>: no scrolling ancestor of the field can clip it.
    expect(menu.parentElement).toBe(document.body);
  });
});

describe("Dropdown under a coarse pointer", () => {
  beforeEach(stubCoarse);

  it("stays a native select with the same options, name and value", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const select = field();
    expect(select).toBeInstanceOf(HTMLSelectElement);
    expect([...(select as HTMLSelectElement).options].map((o) => o.textContent)).toEqual([
      "Apple",
      "Apricot",
      "Banana",
      "Cherry",
      "Date",
    ]);
    expect((select as HTMLSelectElement).options[3]!.disabled).toBe(true);
    pickDropdownOption(select, "banana");
    expect(onChange).toHaveBeenCalledWith("banana");
    expect(dropdownValue(select)).toBe("banana");
  });

  it("the action row is the last native option and runs its command", () => {
    const onChange = vi.fn();
    const onSelect = vi.fn();
    render(<Harness onChange={onChange} action={{ label: "Add fruit…", onSelect }} />);
    const select = field() as HTMLSelectElement;
    expect(select.options[select.options.length - 1]!.textContent).toBe("Add fruit…");
    pickDropdownOption(select, "Add fruit…");
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
    expect(select.value).toBe("apple");
  });

  it("an external <label htmlFor> names it", () => {
    render(
      <>
        <label htmlFor="pick">Pick</label>
        <Dropdown id="pick" value="apple" onChange={() => {}} options={FRUIT} />
      </>,
    );
    expect(screen.getByRole("combobox", { name: "Pick" })).toBeInstanceOf(HTMLSelectElement);
  });
});
