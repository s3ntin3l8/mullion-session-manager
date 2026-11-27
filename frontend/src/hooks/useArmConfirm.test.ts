// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { ARM_CONFIRM_SECONDS, useArmConfirm } from "./useArmConfirm.js";

describe("hooks/useArmConfirm", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("arms a key, counts down once per second, and disarms after 3s", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useArmConfirm());

    expect(result.current.armedKey).toBeNull();
    expect(result.current.secondsLeft).toBe(ARM_CONFIRM_SECONDS);

    act(() => {
      result.current.arm("host-1");
    });
    expect(result.current.armedKey).toBe("host-1");
    expect(result.current.secondsLeft).toBe(3);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.armedKey).toBe("host-1");
    expect(result.current.secondsLeft).toBe(2);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.armedKey).toBe("host-1");
    expect(result.current.secondsLeft).toBe(1);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.armedKey).toBeNull();
    expect(result.current.secondsLeft).toBe(3);
  });

  it("disarms immediately when disarm() is called", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useArmConfirm());

    act(() => {
      result.current.arm("host-1");
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.secondsLeft).toBe(2);

    act(() => {
      result.current.disarm();
    });
    expect(result.current.armedKey).toBeNull();
    expect(result.current.secondsLeft).toBe(3);
  });

  it("re-arms cleanly for another key", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useArmConfirm());

    act(() => {
      result.current.arm("host-1");
      vi.advanceTimersByTime(2000);
    });
    expect(result.current.secondsLeft).toBe(1);

    act(() => {
      result.current.arm("host-2");
    });
    expect(result.current.armedKey).toBe("host-2");
    expect(result.current.secondsLeft).toBe(3);
  });
});
