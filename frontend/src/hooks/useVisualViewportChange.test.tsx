// @vitest-environment jsdom
//
// jsdom because the hook coalesces via requestAnimationFrame — same reasoning
// as useVisualViewportInset.test.tsx's own header comment.
import { describe, it, expect, afterEach, vi } from "vitest";
import { act, render, cleanup } from "@testing-library/react";
import { useVisualViewportChange, visibleViewport } from "./useVisualViewportChange.js";
import {
  flushRaf,
  installFakeVisualViewport,
  uninstallFakeVisualViewport,
} from "../test/fakeVisualViewport.js";

function Harness({ active, onChange }: { active: boolean; onChange: () => void }) {
  useVisualViewportChange(active, onChange);
  return null;
}

afterEach(() => {
  cleanup();
  uninstallFakeVisualViewport();
});

describe("useVisualViewportChange", () => {
  it("coalesces a burst of resize/scroll events into one call per frame", async () => {
    const vv = installFakeVisualViewport();
    const onChange = vi.fn();
    render(<Harness active onChange={onChange} />);

    await act(async () => {
      vv.resizeTo(500);
      vv.panTo(120);
      vv.panTo(140);
      await flushRaf();
    });
    expect(onChange).toHaveBeenCalledTimes(1);

    await act(async () => {
      vv.panTo(0);
      await flushRaf();
    });
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("fires on a window resize, even without a visualViewport", async () => {
    const onChange = vi.fn();
    render(<Harness active onChange={onChange} />);

    await act(async () => {
      window.dispatchEvent(new Event("resize"));
      window.dispatchEvent(new Event("resize"));
      await flushRaf();
    });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("does not subscribe while inactive", async () => {
    const vv = installFakeVisualViewport();
    const onChange = vi.fn();
    render(<Harness active={false} onChange={onChange} />);

    await act(async () => {
      vv.panTo(120);
      await flushRaf();
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("unsubscribes and drops a pending frame when deactivated", async () => {
    const vv = installFakeVisualViewport();
    const onChange = vi.fn();
    const { rerender } = render(<Harness active onChange={onChange} />);

    // Synchronous act, so the effect cleanup runs before the queued frame.
    act(() => {
      vv.panTo(120);
      rerender(<Harness active={false} onChange={onChange} />);
    });
    await act(async () => {
      await flushRaf();
    });
    await act(async () => {
      vv.panTo(0);
      await flushRaf();
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("unsubscribes on unmount", async () => {
    const vv = installFakeVisualViewport();
    const onChange = vi.fn();
    const { unmount } = render(<Harness active onChange={onChange} />);
    unmount();

    await act(async () => {
      vv.resizeTo(500);
      await flushRaf();
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("is a no-op when window.visualViewport is unavailable", () => {
    uninstallFakeVisualViewport();
    expect(() => render(<Harness active onChange={vi.fn()} />)).not.toThrow();
  });

  it("calls the latest onChange without needing to re-subscribe", async () => {
    const vv = installFakeVisualViewport();
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Harness active onChange={first} />);
    rerender(<Harness active onChange={second} />);

    await act(async () => {
      vv.panTo(120);
      await flushRaf();
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe("visibleViewport", () => {
  it("falls back to innerHeight when visualViewport is missing", () => {
    uninstallFakeVisualViewport();
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", { value: 640, configurable: true });
    try {
      expect(visibleViewport()).toEqual({ top: 0, bottom: 640, height: 640 });
    } finally {
      Object.defineProperty(window, "innerHeight", {
        value: originalInnerHeight,
        configurable: true,
      });
    }
  });

  it("reports offsetTop + height when visualViewport exists", () => {
    installFakeVisualViewport(400, 100);
    expect(visibleViewport()).toEqual({ top: 100, bottom: 500, height: 400 });
  });
});
