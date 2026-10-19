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
      const menu = screen.getByRole("listbox");
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
      expect(screen.getByRole("listbox").style.maxHeight).toBe("120px");
    } finally {
      rectSpy.mockRestore();
    }
  });
});
