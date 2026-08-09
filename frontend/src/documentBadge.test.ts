// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  countAttentionRequired,
  formatDocumentTitle,
  updateFaviconBadge,
  clearFaviconBadgeCacheForTests,
  BASE_TITLE,
} from "./documentBadge.js";

describe("countAttentionRequired", () => {
  it("returns 0 for no sessions", () => {
    expect(countAttentionRequired([])).toBe(0);
  });

  it("counts only sessions with sessionStatusAttentionRequired true", () => {
    const sessions = [
      { sessionStatusAttentionRequired: true },
      { sessionStatusAttentionRequired: false },
      { sessionStatusAttentionRequired: true },
    ];
    expect(countAttentionRequired(sessions)).toBe(2);
  });
});

describe("formatDocumentTitle", () => {
  it("returns the bare base title when count is zero", () => {
    expect(formatDocumentTitle(0)).toBe(BASE_TITLE);
  });

  it("prefixes the count when positive", () => {
    expect(formatDocumentTitle(3)).toBe(`(3) ${BASE_TITLE}`);
  });

  it("caps the visible count at 9+", () => {
    expect(formatDocumentTitle(10)).toBe(`(9+) ${BASE_TITLE}`);
    expect(formatDocumentTitle(9)).toBe(`(9) ${BASE_TITLE}`);
  });

  it("accepts a custom base title", () => {
    expect(formatDocumentTitle(2, "Custom")).toBe("(2) Custom");
    expect(formatDocumentTitle(0, "Custom")).toBe("Custom");
  });
});

// P4 perf fix — updateFaviconBadge must bail out (no canvas rebuild, no
// toDataURL re-decode) when called again with the same count/color, which is
// exactly what happens on every idle 4s poll tick (App.tsx's effect deps are
// `[sessions]`, whose identity changes every tick regardless of content —
// see store.ts's refreshSessions). getContext/toDataURL are stubbed since
// jsdom has no real canvas backend; call counts on those stubs are the only
// observable signal that the "did we actually rebuild the badge" work ran.
describe("updateFaviconBadge", () => {
  let getContextSpy: ReturnType<typeof vi.spyOn>;
  let toDataURLSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearFaviconBadgeCacheForTests();
    document.head.innerHTML = '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />';
    getContextSpy = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      beginPath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      fillStyle: "",
    } as unknown as CanvasRenderingContext2D);
    toDataURLSpy = vi
      .spyOn(HTMLCanvasElement.prototype, "toDataURL")
      .mockReturnValue("data:image/png;base64,stub");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rebuilds the canvas badge on the first call with a positive count", () => {
    updateFaviconBadge(3);
    expect(getContextSpy).toHaveBeenCalledTimes(1);
    expect(toDataURLSpy).toHaveBeenCalledTimes(1);
  });

  it("bails out on a repeat call with the same count — the idle-poll-tick case", () => {
    updateFaviconBadge(3);
    updateFaviconBadge(3);
    updateFaviconBadge(3);
    expect(getContextSpy).toHaveBeenCalledTimes(1);
    expect(toDataURLSpy).toHaveBeenCalledTimes(1);
  });

  it("rebuilds again once the count actually changes", () => {
    updateFaviconBadge(3);
    updateFaviconBadge(3);
    updateFaviconBadge(5);
    expect(getContextSpy).toHaveBeenCalledTimes(2);
    expect(toDataURLSpy).toHaveBeenCalledTimes(2);
  });

  it("restores the original favicon when the count returns to zero, and does so only once", () => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')!;
    const original = link.href;
    updateFaviconBadge(2);
    expect(link.href).not.toBe(original);
    updateFaviconBadge(0);
    expect(link.href).toBe(original);
    // Repeat zero calls must not re-touch the link or rebuild anything.
    const hrefAfterRestore = link.href;
    updateFaviconBadge(0);
    expect(link.href).toBe(hrefAfterRestore);
    expect(getContextSpy).toHaveBeenCalledTimes(1);
  });

  it("treats a different dotColor as a real change, not a cache hit", () => {
    updateFaviconBadge(3, "#ff0000");
    updateFaviconBadge(3, "#00ff00");
    expect(getContextSpy).toHaveBeenCalledTimes(2);
  });
});
