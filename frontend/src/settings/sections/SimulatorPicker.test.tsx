// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { IosSimulator } from "../../api/index.js";
import { SimulatorPicker } from "./SimulatorPicker.js";

const SIMS: IosSimulator[] = [
  { udid: "A", name: "iPhone 18 Pro", runtime: "iOS 27.0", state: "Booted" },
  {
    udid: "B",
    name: "iPhone 17",
    runtime: "iOS 27.0",
    state: "Shutdown",
    lastBootedAt: "2026-11-01T00:00:00Z",
  },
  { udid: "C", name: "iPhone Air", runtime: "iOS 27.0", state: "Shutdown" },
  { udid: "D", name: "iPhone 17 Pro", runtime: "iOS 26.5", state: "Shutdown" },
];

function renderPicker(over: Partial<React.ComponentProps<typeof SimulatorPicker>> = {}) {
  const onChange = vi.fn();
  render(
    <SimulatorPicker
      simulators={SIMS}
      activeUdids={new Set()}
      value="A"
      onChange={onChange}
      {...over}
    />,
  );
  return { onChange, list: () => screen.getByRole("radiogroup", { name: "Simulator" }) };
}

describe("SimulatorPicker", () => {
  it("opens on the simulators in use, with a way to show the rest", async () => {
    const { list } = renderPicker();
    const radios = within(list()).getAllByRole("radio");
    expect(radios.map((r) => r.textContent)).toEqual([
      expect.stringContaining("iPhone 18 Pro"),
      expect.stringContaining("iPhone 17"),
    ]);
    expect(within(list()).getByRole("radio", { name: /iPhone 18 Pro/ })).toBeChecked();
    expect(screen.getByRole("button", { name: "Show all 4" })).toBeInTheDocument();
  });

  it("shows every simulator, grouped by runtime newest first, then goes back", async () => {
    const user = userEvent.setup();
    const { list } = renderPicker();
    await user.click(screen.getByRole("button", { name: "Show all 4" }));
    expect(within(list()).getAllByRole("radio")).toHaveLength(4);
    expect(
      within(list())
        .getAllByRole("group")
        .map((g) => g.getAttribute("aria-label")),
    ).toEqual(["iOS 27.0", "iOS 26.5"]);
    await user.click(screen.getByRole("button", { name: "Show used only" }));
    expect(within(list()).getAllByRole("radio")).toHaveLength(2);
  });

  it("a search reaches simulators the default view leaves out, and says when nothing matches", async () => {
    const user = userEvent.setup();
    const { list } = renderPicker();
    await user.type(screen.getByRole("searchbox", { name: "Search simulators" }), "17 pro");
    expect(within(list()).getAllByRole("radio")).toHaveLength(1);
    expect(within(list()).getByRole("radio", { name: /iPhone 17 Pro/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();

    await user.clear(screen.getByRole("searchbox", { name: "Search simulators" }));
    await user.type(screen.getByRole("searchbox", { name: "Search simulators" }), "zzz");
    expect(screen.getByText(/No simulators match/)).toBeInTheDocument();
  });

  it("selects a simulator, and will not select one that is already added", async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker({ activeUdids: new Set(["B"]) });
    await user.click(screen.getByRole("radio", { name: /iPhone 18 Pro/ }));
    expect(onChange).toHaveBeenCalledWith("A");
    const added = screen.getByRole("radio", { name: /iPhone 17(?! Pro)/ });
    expect(added).toBeDisabled();
    expect(added).toHaveTextContent("already added");
    await user.click(added);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("is one tab stop, and the arrow keys move the choice past rows that cannot be chosen", async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker({ activeUdids: new Set(["B"]) });
    const first = screen.getByRole("radio", { name: /iPhone 18 Pro/ });
    expect(first).toHaveAttribute("tabindex", "0");
    first.focus();
    await user.keyboard("{ArrowDown}");
    // iPhone 17 is already added, so the next row that can be chosen is shown after "Show all".
    expect(onChange).not.toHaveBeenCalledWith("B");
    await user.keyboard("{ArrowUp}");
    expect(onChange).toHaveBeenLastCalledWith("A");
  });

  it("says what is selected when a search hides it", async () => {
    const user = userEvent.setup();
    renderPicker({ value: "D" });
    // D (iPhone 17 Pro) is kept visible in the default view; searching elsewhere hides it.
    await user.type(screen.getByRole("searchbox", { name: "Search simulators" }), "air");
    expect(screen.getByText("Selected: iPhone 17 Pro (iOS 26.5)")).toBeInTheDocument();
  });

  it("offers no toggle when there is nothing to reveal", () => {
    renderPicker({ simulators: SIMS.slice(0, 2) });
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
  });
});
