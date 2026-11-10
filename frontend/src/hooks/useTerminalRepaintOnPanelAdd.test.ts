// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import type { DockviewApi } from "dockview-react";
import { useTerminalRepaintOnPanelAdd } from "./useTerminalRepaintOnPanelAdd.js";

const { repaintAllTerminals } = vi.hoisted(() => ({ repaintAllTerminals: vi.fn() }));

vi.mock("../terminalRepaintRegistry.js", () => ({ repaintAllTerminals }));

afterEach(() => {
  repaintAllTerminals.mockClear();
  vi.unstubAllGlobals();
});

describe("useTerminalRepaintOnPanelAdd", () => {
  it("does nothing without a dockview api", () => {
    const onDidAddPanel = vi.fn();
    renderHook(() =>
      useTerminalRepaintOnPanelAdd({
        dockviewApi: null,
      }),
    );
    expect(onDidAddPanel).not.toHaveBeenCalled();
  });

  it("repaints other terminals on the next frame after a panel is added", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    const dispose = vi.fn();
    let onAdd: (panel: { params?: { sessionId?: number } }) => void = () => {};
    const api = {
      onDidAddPanel: (cb: typeof onAdd) => {
        onAdd = cb;
        return { dispose };
      },
    };
    const { unmount } = renderHook(() =>
      useTerminalRepaintOnPanelAdd({ dockviewApi: api as unknown as DockviewApi }),
    );

    onAdd({ params: { sessionId: 4 } });
    expect(repaintAllTerminals).not.toHaveBeenCalled();
    frames[0](0);
    expect(repaintAllTerminals).toHaveBeenCalledWith(4);

    onAdd({});
    frames[1](0);
    expect(repaintAllTerminals).toHaveBeenLastCalledWith(undefined);

    unmount();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
