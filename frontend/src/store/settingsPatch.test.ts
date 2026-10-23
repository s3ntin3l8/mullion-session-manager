import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useDashboardStore } from "./index.js";
import { __flushPendingSettingsPatchForTests } from "./slices/ui.js";
import { DEFAULT_SETTINGS } from "../api/index.js";
import { jsonResponse } from "../test/jsonResponse.js";

// The settings PATCH is DEBOUNCED (SETTINGS_PATCH_DEBOUNCE_MS) and the
// pending patch is closure state inside the ui slice, not store state — so
// the store's own resetStore() cannot reach it.
//
// That made two failures possible, both of which only show up under
// full-suite load:
//
//   1. A test that waits for the PATCH with waitFor is racing a 400ms
//      debounce against the runner's own load; when the runner is slow the
//      PATCH lands after the wait's timeout.
//   2. A patch left PENDING by one test fires during a LATER test in the
//      same file — the debounce timer outlives the test that armed it, and
//      by then that later test has installed its own fetch mock, so the
//      previous test's PATCH shows up in this one's assertions.
//
// The global test setup (src/testSetup.ts) flushes the pending patch after
// every test, which closes (2) at the source. These tests pin that.
describe("the settings PATCH debounce", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(() => Promise.resolve(jsonResponse(200, DEFAULT_SETTINGS)));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not send the PATCH immediately — it is debounced", () => {
    useDashboardStore.getState().updateSettings({ theme: "light" });
    // The local state is applied at once; the PATCH is not.
    expect(useDashboardStore.getState().settings.theme).toBe("light");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not leak the previous test's pending PATCH into this test's mock", async () => {
    // Long enough for the 400ms debounce to have fired. Without the global
    // flush, the patch the previous test armed would fire HERE — into this
    // test's freshly-installed mock — and this assertion would be red.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the PATCH once the pending patch is flushed", async () => {
    useDashboardStore.getState().updateSettings({ theme: "light" });
    __flushPendingSettingsPatchForTests();
    // Flushed, not waited for: api.patchSettings reaches fetch()
    // synchronously, so the call has already been made here.
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/settings",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ theme: "light" }),
      }),
    );
  });
});
