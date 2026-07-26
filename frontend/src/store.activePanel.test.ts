// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { useDashboardStore } from "./store.js";

describe("activePanelId (issue #322)", () => {
  beforeEach(() => {
    useDashboardStore.setState({ activePanelId: null });
  });

  it("setActivePanelId updates activePanelId in the store", () => {
    useDashboardStore.getState().setActivePanelId("session-5");
    expect(useDashboardStore.getState().activePanelId).toBe("session-5");
  });

  it("setActivePanelId(null) clears activePanelId", () => {
    useDashboardStore.getState().setActivePanelId("session-5");
    useDashboardStore.getState().setActivePanelId(null);
    expect(useDashboardStore.getState().activePanelId).toBeNull();
  });
});
