// @vitest-environment jsdom
// Copy-all tests click with fireEvent, not userEvent: userEvent.setup()
// installs its own navigator.clipboard stub, replacing the one each test
// provides.
import { describe, it, expect, vi, afterEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CopyModeSheet } from "./CopyModeSheet.js";

vi.mock("../store/index.js", () => {
  const state = { theme: "light" };
  const useDashboardStore = (selector?: (s: unknown) => unknown) =>
    selector ? selector(state) : state;
  return { useDashboardStore };
});

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
});

function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
}

describe("CopyModeSheet", () => {
  it("shows the text read-only and focused, in a themed dialog", () => {
    render(<CopyModeSheet text={"line 1\nline 2"} onClose={vi.fn()} />);
    const textarea = screen.getByRole("textbox", { name: "Terminal text" });
    expect(textarea).toHaveValue("line 1\nline 2");
    expect(textarea).toHaveAttribute("readonly");
    expect(textarea).toHaveFocus();
    expect(document.querySelector(".copy-mode-backdrop")).toHaveClass("light");
  });

  it("copies everything with Copy all", async () => {
    const writeText = vi.fn(async () => {});
    stubClipboard(writeText);
    render(<CopyModeSheet text="hello" onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy all" }));
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("reports a failed copy", async () => {
    stubClipboard(vi.fn(async () => Promise.reject(new Error("denied"))));
    render(<CopyModeSheet text="hello" onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy all" }));
    expect(await screen.findByRole("button", { name: "Copy failed" })).toBeInTheDocument();
  });

  it("reports failure when there's no clipboard API at all", async () => {
    render(<CopyModeSheet text="hello" onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy all" }));
    expect(screen.getByRole("button", { name: "Copy failed" })).toBeInTheDocument();
  });

  it("closes on Escape, the close button, and a backdrop tap — not a tap inside", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<CopyModeSheet text="hello" onClose={onClose} />);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Close copy view" }));
    expect(onClose).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole("textbox"));
    expect(onClose).toHaveBeenCalledTimes(2);
    await user.click(document.querySelector(".copy-mode-backdrop") as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("doesn't close when a drag starts inside the sheet and ends on the backdrop", () => {
    const onClose = vi.fn();
    render(<CopyModeSheet text="hello" onClose={onClose} />);
    const backdrop = document.querySelector(".copy-mode-backdrop") as HTMLElement;
    fireEvent.pointerDown(screen.getByRole("textbox"));
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
  });
});
