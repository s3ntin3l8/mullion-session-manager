// @vitest-environment jsdom
// Copy-all tests click with fireEvent, not userEvent: userEvent.setup()
// installs its own navigator.clipboard stub, replacing the one each test
// provides.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
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

  it("honors a custom title for the scrollback case (Codex question/dialog)", () => {
    render(<CopyModeSheet text="history" title="Scrollback" onClose={vi.fn()} />);
    expect(screen.getByText("Scrollback")).toBeInTheDocument();
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

// #3019 — TerminalPane keeps the sheet mounted and drives `open`, so closing
// plays BottomSheet's spring exit with the content still in it. jsdom has no
// layout: the sheet gets a 400px travel, and frames are driven by hand.
describe("CopyModeSheet exit", () => {
  let frames: Map<number, FrameRequestCallback>;
  let now: number;
  let nextFrame: number;

  function frame(ms = 16) {
    now += ms;
    const callbacks = [...frames.values()];
    frames.clear();
    act(() => {
      for (const callback of callbacks) callback(now);
    });
  }
  function runToRest() {
    for (let i = 0; i < 1000 && frames.size > 0; i++) frame();
  }

  beforeEach(() => {
    frames = new Map();
    now = 0;
    nextFrame = 1;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => void frames.delete(id));
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockReturnValue(400);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // The TerminalPane shape: the last snapshot is kept, only `open` flips.
  function Harness() {
    const [sheet, setSheet] = useState({ text: "kept output", open: true });
    return (
      <>
        <button onClick={() => setSheet({ text: "fresh output", open: true })}>Reopen</button>
        <CopyModeSheet
          open={sheet.open}
          text={sheet.text}
          onClose={() => setSheet((s) => ({ ...s, open: false }))}
        />
      </>
    );
  }
  const sheetEl = () => document.querySelector(".copy-mode-sheet");

  it("closing flips open instead of unmounting, and leaves with its content", () => {
    render(<Harness />);
    runToRest();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    // Still on screen for the exit, with the text it showed, but no longer a
    // dialog anyone can reach.
    expect(sheetEl()).not.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector(".copy-mode-text")).toHaveValue("kept output");
    frame();
    frame();
    expect(sheetEl()).not.toBeNull();
    runToRest();
    expect(sheetEl()).toBeNull();
  });

  it("each open starts afresh: no leftover Copied, the new text shown", async () => {
    const writeText = vi.fn(async () => {});
    stubClipboard(writeText);
    render(<Harness />);
    runToRest();
    fireEvent.click(screen.getByRole("button", { name: "Copy all" }));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    runToRest();
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    expect(screen.getByRole("button", { name: "Copy all" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Terminal text" })).toHaveValue("fresh output");
  });
});
