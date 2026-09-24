// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  publishVoiceControls,
  unpublishVoiceControls,
  useVoiceControls,
} from "./terminalVoiceRegistry.js";
import type { TerminalVoiceControls } from "./terminalVoiceRegistry.js";

function controls(overrides: Partial<TerminalVoiceControls> = {}): TerminalVoiceControls {
  return {
    phase: "idle",
    interimText: "",
    disabled: false,
    press: vi.fn(),
    release: vi.fn(),
    cancel: vi.fn(),
    ...overrides,
  };
}

describe("terminalVoiceRegistry", () => {
  it("delivers published controls to subscribers and clears them on unpublish", () => {
    const { result } = renderHook(() => useVoiceControls(101));
    expect(result.current).toBeUndefined();
    const c = controls();
    act(() => publishVoiceControls(101, c));
    expect(result.current).toBe(c);
    act(() => unpublishVoiceControls(101, c));
    expect(result.current).toBeUndefined();
  });

  it("removing an earlier publisher keeps the latest one current", () => {
    const { result } = renderHook(() => useVoiceControls(102));
    const first = controls();
    const second = controls({ phase: "listening" });
    act(() => publishVoiceControls(102, first));
    act(() => publishVoiceControls(102, second));
    act(() => unpublishVoiceControls(102, first));
    expect(result.current).toBe(second);
    act(() => unpublishVoiceControls(102, second));
    expect(result.current).toBeUndefined();
  });

  it("removing the latest publisher falls back to the earlier one", () => {
    const { result } = renderHook(() => useVoiceControls(103));
    const first = controls();
    const second = controls();
    act(() => publishVoiceControls(103, first));
    act(() => publishVoiceControls(103, second));
    act(() => unpublishVoiceControls(103, second));
    expect(result.current).toBe(first);
    // Unknown controls are a no-op.
    act(() => unpublishVoiceControls(103, controls()));
    expect(result.current).toBe(first);
    act(() => unpublishVoiceControls(103, first));
  });
});
