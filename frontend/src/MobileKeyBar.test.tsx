// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MobileKeyBar } from "./MobileKeyBar.js";
import { registerTerminalInput, unregisterTerminalInput } from "./terminalInputRegistry.js";
import type { TerminalInputHandle } from "./terminalInputRegistry.js";

const SESSION_ID = 1;

let handle: TerminalInputHandle;

beforeEach(() => {
  handle = { sendInput: vi.fn(), sendArrow: vi.fn(), sendCtrlC: vi.fn() };
  registerTerminalInput(SESSION_ID, handle);
});

afterEach(() => {
  unregisterTerminalInput(SESSION_ID, handle);
});

describe("MobileKeyBar", () => {
  it("renders one button per key, as a labelled toolbar", () => {
    render(<MobileKeyBar sessionId={SESSION_ID} />);
    const toolbar = screen.getByRole("toolbar", { name: "Terminal keys" });
    expect(toolbar.querySelectorAll("button")).toHaveLength(7);
  });

  it.each([
    ["Escape", "\x1b"],
    ["Tab", "\t"],
    ["Shift+Tab", "\x1b[Z"],
    ["Newline (no submit)", "\x1b\r"],
  ])("sends the right sequence for %s", async (ariaLabel, sequence) => {
    const user = userEvent.setup();
    render(<MobileKeyBar sessionId={SESSION_ID} />);

    await user.click(screen.getByRole("button", { name: ariaLabel }));

    expect(handle.sendInput).toHaveBeenCalledWith(sequence);
  });

  it("routes arrow keys through sendArrow, not a fixed sequence", async () => {
    const user = userEvent.setup();
    render(<MobileKeyBar sessionId={SESSION_ID} />);

    await user.click(screen.getByRole("button", { name: "Arrow up" }));
    await user.click(screen.getByRole("button", { name: "Arrow down" }));

    expect(handle.sendArrow).toHaveBeenNthCalledWith(1, "up");
    expect(handle.sendArrow).toHaveBeenNthCalledWith(2, "down");
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
});
