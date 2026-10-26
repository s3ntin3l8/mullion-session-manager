import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useDashboardStore } from "./index.js";
import {
  __discardPendingSettingsPatchForTests,
  __flushPendingSettingsPatchForTests,
} from "./slices/ui.js";
import { DEFAULT_SETTINGS } from "../api/index.js";
import { jsonResponse } from "../test/jsonResponse.js";

// runway.providerMap's KEYS are operator data, so the base-keys-only deepMerge
// the store uses for every other setting must not clamp it (issue #1841): an
// added provider has to reach local state, and a removed one has to leave it.
describe("updateSettings and runway.providerMap", () => {
  beforeEach(() => {
    __discardPendingSettingsPatchForTests();
    useDashboardStore.setState({ settings: { ...DEFAULT_SETTINGS }, settingsLoaded: true });
  });

  it("keeps a provider the operator added", () => {
    const map = { ...DEFAULT_SETTINGS.runway.providerMap, gemini: "gemini" };
    useDashboardStore.getState().updateSettings({ runway: { providerMap: map } });
    expect(useDashboardStore.getState().settings.runway.providerMap).toEqual(map);
  });

  it("drops a provider the operator removed", () => {
    useDashboardStore
      .getState()
      .updateSettings({ runway: { providerMap: { anthropic: "claude" } } });
    expect(useDashboardStore.getState().settings.runway.providerMap).toEqual({
      anthropic: "claude",
    });
  });

  it("leaves the map alone when the patch carries none", () => {
    useDashboardStore.getState().updateSettings({ runway: { pollSeconds: 30 } });
    expect(useDashboardStore.getState().settings.runway.providerMap).toEqual(
      DEFAULT_SETTINGS.runway.providerMap,
    );
  });

  describe("two edits inside one debounce window", () => {
    let bodies: string[];
    beforeEach(() => {
      bodies = [];
      vi.stubGlobal(
        "fetch",
        vi.fn((_url: string, init?: RequestInit) => {
          bodies.push(String(init?.body));
          return Promise.resolve(jsonResponse(200, DEFAULT_SETTINGS));
        }),
      );
    });
    afterEach(() => vi.unstubAllGlobals());

    it("sends the LAST map, not the union — a removal must survive", () => {
      const { updateSettings } = useDashboardStore.getState();
      updateSettings({ runway: { providerMap: { anthropic: "claude", gemini: "gemini" } } });
      updateSettings({ runway: { providerMap: { anthropic: "claude" } } });
      __flushPendingSettingsPatchForTests();
      expect(JSON.parse(bodies[0])).toEqual({ runway: { providerMap: { anthropic: "claude" } } });
    });
  });
});
