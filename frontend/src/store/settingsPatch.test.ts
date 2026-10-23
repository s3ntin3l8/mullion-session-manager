import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { useDashboardStore } from "./index.js";
import {
  __discardPendingSettingsPatchForTests,
  __flushPendingSettingsPatchForTests,
} from "./slices/ui.js";
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
// The global test setup (src/testSetup.ts) DISCARDS the pending patch after
// every test, which closes (2) at the source. These tests pin that — and
// pin that it discards rather than sends, because the teardown runs after
// each file's own `vi.unstubAllGlobals()`, so a send there would go out
// through the REAL fetch.
describe("the settings PATCH debounce", () => {
  // A SPY, not a stub, and installed ONCE for the file: `vi.unstubAllGlobals()`
  // (which a test file's own afterEach usually calls) reverts `vi.stubGlobal`
  // but NOT `vi.spyOn` — so this keeps recording after the test's own mock is
  // gone, which is exactly the window the global teardown runs in. A fresh spy
  // per test would record nothing and the assertion below would be vacuous.
  const calls: string[] = [];

  beforeAll(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input: RequestInfo | URL) => {
      calls.push(String(input));
      return Promise.resolve(jsonResponse(200, DEFAULT_SETTINGS));
    });
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it("does not send the PATCH immediately — it is debounced", () => {
    useDashboardStore.getState().updateSettings({ theme: "light" });
    // The local state is applied at once; the PATCH is not.
    expect(useDashboardStore.getState().settings.theme).toBe("light");
    expect(calls).toEqual([]);
  });

  it("does not let the previous test's pending PATCH escape through the real fetch", () => {
    // The previous test armed a patch, and the global teardown ran after that
    // test's own afterEach — i.e. with the file's own mock already gone. A
    // SEND there would be a real request; the spy above is still installed
    // and records it. The teardown DISCARDS, so nothing was sent.
    expect(calls).toEqual([]);
  });

  it("discards the pending PATCH without sending it", () => {
    useDashboardStore.getState().updateSettings({ theme: "light" });
    __discardPendingSettingsPatchForTests();
    // Nothing was sent — the teardown's job is that nothing is left to fire
    // later, not that the patch is delivered.
    expect(calls).toEqual([]);
  });

  it("sends the PATCH once the pending patch is flushed", () => {
    useDashboardStore.getState().updateSettings({ theme: "light" });
    __flushPendingSettingsPatchForTests();
    // Flushed, not waited for: api.patchSettings reaches fetch()
    // synchronously, so the call has already been made here.
    expect(calls).toContain("/api/settings");
  });
});
