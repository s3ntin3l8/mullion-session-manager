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
