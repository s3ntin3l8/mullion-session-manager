// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { DockviewApi } from "dockview-react";
import { makeSession } from "../test/fixtures.js";
import { useCloseKilledSessionPanels } from "./useCloseKilledSessionPanels.js";

function panel(id: string, params?: { sessionId?: number }) {
  const close = vi.fn();
  return { id, params, close, api: { close } };
}

function makeApi(panels: ReturnType<typeof panel>[]) {
  return {
    panels,
    getPanel: (id: string) => panels.find((item) => item.id === id),
  } as unknown as DockviewApi & { panels: ReturnType<typeof panel>[] };
}

describe("useCloseKilledSessionPanels", () => {
  it("does nothing without a dockview api", () => {
    expect(() =>
      renderHook(() =>
        useCloseKilledSessionPanels({
          sessions: [makeSession({ id: 1, status: "killed" })],
          dockviewApi: null,
        }),
      ),
    ).not.toThrow();
  });

  it("closes killed session terminals and stale timeline or browser panes", () => {
    const killedTerminal = panel("session-1");
    const liveTerminal = panel("session-2");
    const missingTimeline = panel("timeline-3", { sessionId: 3 });
    const killedTimeline = panel("timeline-1", { sessionId: 1 });
    const exitedBrowser = panel("browserPane-4");
    const liveTimeline = panel("timeline-2", { sessionId: 2 });
    const undecodable = panel("timeline-nope");
    const activeParsed = panel("browserPane-2");
    const api = makeApi([
      killedTerminal,
      liveTerminal,
      missingTimeline,
      killedTimeline,
      exitedBrowser,
      liveTimeline,
      undecodable,
      activeParsed,
    ]);

    renderHook(() =>
      useCloseKilledSessionPanels({
        sessions: [
          makeSession({ id: 1, status: "killed" }),
          makeSession({ id: 2, status: "active" }),
          makeSession({ id: 4, status: "exited" }),
          makeSession({ id: 8, status: "killed" }),
        ],
        dockviewApi: api,
      }),
    );

    expect(killedTerminal.close).toHaveBeenCalledTimes(1);
    expect(liveTerminal.close).not.toHaveBeenCalled();
    expect(missingTimeline.close).toHaveBeenCalledTimes(1);
    expect(killedTimeline.close).toHaveBeenCalledTimes(1);
    expect(exitedBrowser.close).toHaveBeenCalledTimes(1);
    expect(liveTimeline.close).not.toHaveBeenCalled();
    expect(undecodable.close).not.toHaveBeenCalled();
    // browserPane-2 has no params, so the id is parsed; session 2 is active.
    expect(activeParsed.close).not.toHaveBeenCalled();
  });

  it("prefers params.sessionId over the id when both are present", () => {
    // Id says session 4 (exited) but params point at the live session.
    const browser = panel("browserPane-4", { sessionId: 2 });
    const api = makeApi([browser]);
    renderHook(() =>
      useCloseKilledSessionPanels({
        sessions: [
          makeSession({ id: 2, status: "active" }),
          makeSession({ id: 4, status: "exited" }),
        ],
        dockviewApi: api,
      }),
    );
    expect(browser.close).not.toHaveBeenCalled();
  });
});
