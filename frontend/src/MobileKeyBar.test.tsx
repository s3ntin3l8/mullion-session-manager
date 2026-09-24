// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MobileKeyBar } from "./MobileKeyBar.js";
import { registerTerminalInput, unregisterTerminalInput } from "./terminalInputRegistry.js";
import type { TerminalInputHandle } from "./terminalInputRegistry.js";
import { publishVoiceControls, unpublishVoiceControls } from "./lib/terminalVoiceRegistry.js";
import type { TerminalVoiceControls } from "./lib/terminalVoiceRegistry.js";

const SESSION_ID = 1;

let handle: TerminalInputHandle;

beforeEach(() => {
  handle = {
    sendInput: vi.fn(),
    sendArrow: vi.fn(),
    sendCtrlC: vi.fn(),
    paste: vi.fn(),
    openCopyMode: vi.fn(),
    setCtrlModifier: vi.fn(),
  };
  registerTerminalInput(SESSION_ID, handle);
  localStorage.clear();
});

async function openMoreKeys(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "More keys" }));
}

afterEach(() => {
  unregisterTerminalInput(SESSION_ID, handle);
});

describe("MobileKeyBar", () => {
  it("renders one fixed row of keys by default, as a labelled toolbar", () => {
    render(<MobileKeyBar sessionId={SESSION_ID} />);
    const toolbar = screen.getByRole("toolbar", { name: "Terminal keys" });
    // Esc, Tab, ⇧Tab, Ctrl, ↑, ↓, ⋯ (no mic without published voice controls).
    expect(toolbar.querySelectorAll(".mobile-key-bar-row")).toHaveLength(1);
    expect(toolbar.querySelectorAll("button")).toHaveLength(7);
  });

  it("toggles a second row with the remaining keys and remembers it", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<MobileKeyBar sessionId={SESSION_ID} />);
    await openMoreKeys(user);
    expect(screen.getByRole("button", { name: "Fewer keys" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(document.querySelectorAll(".mobile-key-bar-row")).toHaveLength(2);
    unmount();

    render(<MobileKeyBar sessionId={SESSION_ID} />);
    expect(screen.getByRole("button", { name: "Paste" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Fewer keys" }));
    expect(screen.queryByRole("button", { name: "Paste" })).toBeNull();
  });

  it.each([
    ["Escape", "\x1b"],
    ["Tab", "\t"],
    ["Shift+Tab", "\x1b[Z"],
    ["Newline (no submit)", "\x1b\r"],
  ])("sends the right sequence for %s", async (ariaLabel, sequence) => {
    const user = userEvent.setup();
    render(<MobileKeyBar sessionId={SESSION_ID} />);
    await openMoreKeys(user);

    await user.click(screen.getByRole("button", { name: ariaLabel }));

    expect(handle.sendInput).toHaveBeenCalledWith(sequence);
  });

  it("routes arrow keys through sendArrow, not a fixed sequence", async () => {
    const user = userEvent.setup();
    render(<MobileKeyBar sessionId={SESSION_ID} />);

    await openMoreKeys(user);
    await user.click(screen.getByRole("button", { name: "Arrow up" }));
    await user.click(screen.getByRole("button", { name: "Arrow down" }));
    await user.click(screen.getByRole("button", { name: "Arrow left" }));
    await user.click(screen.getByRole("button", { name: "Arrow right" }));

    expect(handle.sendArrow).toHaveBeenNthCalledWith(1, "up");
    expect(handle.sendArrow).toHaveBeenNthCalledWith(2, "down");
    expect(handle.sendArrow).toHaveBeenNthCalledWith(3, "left");
    expect(handle.sendArrow).toHaveBeenNthCalledWith(4, "right");
    expect(handle.sendInput).not.toHaveBeenCalled();
  });

  // Independent code review, PR #616 — Ctrl+C is deliberately NOT a raw
  // "\x03" through sendInput: term.input() bypasses TerminalPane's own
  // attachCustomKeyEventHandler (dock-monitor copy-not-kill, opt-in
  // selection-aware copy) entirely, so it has to go through sendCtrlC
  // instead, which replicates that handler's decision inside TerminalPane —
  // see terminalInputRegistry.ts's own comment.
  it("routes Ctrl+C through sendCtrlC, not a raw sequence", async () => {
    const user = userEvent.setup();
    render(<MobileKeyBar sessionId={SESSION_ID} />);
    await openMoreKeys(user);

    await user.click(screen.getByRole("button", { name: "Ctrl+C" }));

    expect(handle.sendCtrlC).toHaveBeenCalledTimes(1);
    expect(handle.sendInput).not.toHaveBeenCalled();
  });

  // The whole reason this exists: without it, a plain click's own mousedown
  // default shifts focus to the button, blurring the terminal and dismissing
  // the on-screen keyboard before the tap even registers as a send. This
  // only proves the handler calls preventDefault() — jsdom doesn't
  // synthesize a real browser's native focus-shift-on-mousedown chain from a
  // dispatched PointerEvent, so it can't verify the actual on-device effect;
  // that's covered by the manual real-device test plan instead (independent
  // code review, PR #616).
  it("prevents the default pointerdown action so the tap can't blur the terminal", () => {
    render(<MobileKeyBar sessionId={SESSION_ID} />);
    const button = screen.getByRole("button", { name: "Escape" });

    const event = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
    const prevented = !button.dispatchEvent(event);

    expect(prevented).toBe(true);
  });

  it("does not throw when no session is registered (e.g. panel torn down mid-tap)", async () => {
    unregisterTerminalInput(SESSION_ID, handle);
    const user = userEvent.setup();
    render(<MobileKeyBar sessionId={SESSION_ID} />);

    await expect(user.click(screen.getByRole("button", { name: "Escape" }))).resolves.not.toThrow();
  });

  it("routes Paste and Copy through the terminal handle", async () => {
    const user = userEvent.setup();
    render(<MobileKeyBar sessionId={SESSION_ID} />);
    await openMoreKeys(user);
    await user.click(screen.getByRole("button", { name: "Paste" }));
    await user.click(screen.getByRole("button", { name: "Copy text" }));
    expect(handle.paste).toHaveBeenCalledTimes(1);
    expect(handle.openCopyMode).toHaveBeenCalledTimes(1);
  });

  it("cycles sticky Ctrl off → once → locked → off and pushes it to the terminal", async () => {
    const user = userEvent.setup();
    render(<MobileKeyBar sessionId={SESSION_ID} />);
    const ctrl = () => screen.getByRole("button", { name: /^Ctrl/ });
    expect(ctrl()).toHaveAttribute("aria-pressed", "false");

    await user.click(ctrl());
    expect(ctrl()).toHaveAccessibleName("Ctrl (next key)");
    expect(handle.setCtrlModifier).toHaveBeenLastCalledWith("once", expect.any(Function));

    await user.click(ctrl());
    expect(ctrl()).toHaveAccessibleName("Ctrl (locked)");
    expect(handle.setCtrlModifier).toHaveBeenLastCalledWith("locked", expect.any(Function));

    await user.click(ctrl());
    expect(ctrl()).toHaveAttribute("aria-pressed", "false");
    expect(handle.setCtrlModifier).toHaveBeenLastCalledWith("off", expect.any(Function));
  });

  it("releases a one-shot Ctrl once the terminal reports it consumed", async () => {
    const user = userEvent.setup();
    render(<MobileKeyBar sessionId={SESSION_ID} />);
    await user.click(screen.getByRole("button", { name: "Ctrl" }));
    const onConsumed = vi.mocked(handle.setCtrlModifier).mock.lastCall![1];
    act(() => onConsumed());
    expect(screen.getByRole("button", { name: "Ctrl" })).toHaveAttribute("aria-pressed", "false");
  });

  it("disarms Ctrl when switching to another session", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<MobileKeyBar sessionId={SESSION_ID} />);
    await user.click(screen.getByRole("button", { name: "Ctrl" }));
    rerender(<MobileKeyBar sessionId={SESSION_ID + 1} />);
    expect(screen.getByRole("button", { name: "Ctrl" })).toHaveAttribute("aria-pressed", "false");
    expect(handle.setCtrlModifier).toHaveBeenLastCalledWith("off", expect.any(Function));
  });

  it("shows the dictation mic as a key when the terminal publishes voice controls", async () => {
    const voice: TerminalVoiceControls = {
      phase: "idle",
      interimText: "",
      disabled: false,
      press: vi.fn(),
      release: vi.fn(),
      cancel: vi.fn(),
    };
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.releasePointerCapture = vi.fn();
    render(<MobileKeyBar sessionId={SESSION_ID} />);
    expect(screen.queryByRole("button", { name: "Start dictation" })).toBeNull();
    act(() => publishVoiceControls(SESSION_ID, voice));
    const mic = screen.getByRole("button", { name: "Start dictation" });
    expect(mic).toHaveClass("mobile-key-bar-btn");
    mic.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    expect(voice.press).toHaveBeenCalled();
    act(() => unpublishVoiceControls(SESSION_ID, voice));
  });
});

describe("MobileKeyBar — terminal remount", () => {
  it("re-applies an armed Ctrl to a remounted terminal's new handle", async () => {
    const first: TerminalInputHandle = {
      sendInput: vi.fn(),
      sendArrow: vi.fn(),
      sendCtrlC: vi.fn(),
      paste: vi.fn(),
      openCopyMode: vi.fn(),
      setCtrlModifier: vi.fn(),
    };
    registerTerminalInput(77, first);
    const user = userEvent.setup();
    render(<MobileKeyBar sessionId={77} />);
    await user.click(screen.getByRole("button", { name: "Ctrl" }));
    await user.click(screen.getByRole("button", { name: /^Ctrl/ }));
    expect(first.setCtrlModifier).toHaveBeenLastCalledWith("locked", expect.any(Function));

    const second: TerminalInputHandle = { ...first, setCtrlModifier: vi.fn() };
    act(() => {
      unregisterTerminalInput(77, first);
      registerTerminalInput(77, second);
    });
    expect(second.setCtrlModifier).toHaveBeenLastCalledWith("locked", expect.any(Function));
    act(() => unregisterTerminalInput(77, second));
  });
});
