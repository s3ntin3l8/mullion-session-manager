// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { VoiceMicButton } from "./VoiceMicButton.js";
import type { VoiceMicButtonProps } from "./VoiceMicButton.js";

// jsdom doesn't implement the Pointer Capture APIs at all — stub them once
// on Element.prototype so the component's own setPointerCapture/
// releasePointerCapture calls don't throw "not a function". This only
// verifies the component CALLS them, not that capture actually redirects
// events (jsdom's fireEvent.pointerUp always targets the element it's
// dispatched on regardless).
beforeAll(() => {
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

function renderButton(overrides: Partial<VoiceMicButtonProps> = {}) {
  const props: VoiceMicButtonProps = {
    phase: "idle",
    interimText: "",
    disabled: false,
    coarsePointer: false,
    onPress: vi.fn(),
    onRelease: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  render(<VoiceMicButton {...props} />);
  return props;
}

describe("VoiceMicButton", () => {
  it("calls onPress on pointerdown and onRelease on pointerup", () => {
    const props = renderButton();
    const button = screen.getByRole("button", { name: "Start dictation" });

    fireEvent.pointerDown(button, { pointerId: 1 });
    expect(props.onPress).toHaveBeenCalledTimes(1);

    fireEvent.pointerUp(button, { pointerId: 1 });
    expect(props.onRelease).toHaveBeenCalledTimes(1);
  });

  it("preventDefault()s pointerdown so the terminal keeps focus", () => {
    renderButton();
    const button = screen.getByRole("button", { name: "Start dictation" });
    const event = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
    // Cast: jsdom's PointerEvent lacks a real pointerId in its constructor
    // options in this DOM lib version; setPointerCapture is stubbed above
    // regardless, so the exact value is irrelevant to this assertion.
    Object.defineProperty(event, "pointerId", { value: 1 });
    button.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("captures the pointer on pointerdown and releases it on pointerup", () => {
    renderButton();
    const button = screen.getByRole("button", { name: "Start dictation" });

    fireEvent.pointerDown(button, { pointerId: 7 });
    expect(button.setPointerCapture).toHaveBeenCalledWith(7);

    fireEvent.pointerUp(button, { pointerId: 7 });
    expect(button.releasePointerCapture).toHaveBeenCalledWith(7);
  });

  it("calls onCancel (not onRelease) on pointercancel — an interrupted gesture discards, never inserts", () => {
    const props = renderButton();
    const button = screen.getByRole("button", { name: "Start dictation" });

    fireEvent.pointerDown(button, { pointerId: 1 });
    fireEvent.pointerCancel(button, { pointerId: 1 });

    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(props.onRelease).not.toHaveBeenCalled();
  });

  it("does nothing on any pointer event when disabled", () => {
    const props = renderButton({ disabled: true });
    const button = screen.getByRole("button", { name: "Start dictation" });

    fireEvent.pointerDown(button, { pointerId: 1 });
    fireEvent.pointerUp(button, { pointerId: 1 });

    expect(props.onPress).not.toHaveBeenCalled();
    expect(props.onRelease).not.toHaveBeenCalled();
    expect(button).toBeDisabled();
  });

  it("shows 'Stop dictation' and the interim chip while listening", () => {
    renderButton({ phase: "listening", interimText: "hello wor" });
    expect(screen.getByRole("button", { name: "Stop dictation" })).toBeInTheDocument();
    expect(screen.getByText("hello wor")).toBeInTheDocument();
  });

  it("hides the interim chip when there is no interim text yet", () => {
    renderButton({ phase: "listening", interimText: "" });
    expect(
      screen.queryByText(/./, { selector: ".terminal-voice-interim" }),
    ).not.toBeInTheDocument();
  });

  it("applies the coarse-pointer class for touch targets", () => {
    renderButton({ coarsePointer: true });
    expect(screen.getByRole("button", { name: "Start dictation" })).toHaveClass("coarse");
  });
});
