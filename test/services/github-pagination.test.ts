import { describe, it, expect, vi } from "vitest";
import { fetchAllPages } from "../../src/services/github-pagination.js";

// The helper is deliberately tiny; what it has to get RIGHT is the two
// things the five hand-rolled loops got subtly different about — the
// response shape (a bare array vs an envelope) and the stop condition (a
// SHORT page is the end of the list, an EMPTY page is not).
//
// The five call sites' own constants are covered by their own tests
// (github-write.test.ts, github-merged-prs.test.ts); here the helper is
// exercised against the shapes it has to support, with the page size and cap
// supplied per call.

describe("github-pagination: fetchAllPages", () => {
  describe("bare-array responses", () => {
    it("reads a single page and returns its items", async () => {
      const fetchPage = vi.fn().mockResolvedValue([{ id: 1 }, { id: 2 }]);
      const out = await fetchAllPages(fetchPage, { maxPages: 10, pageSize: 100 });
      expect(out).toEqual([{ id: 1 }, { id: 2 }]);
      expect(fetchPage).toHaveBeenCalledTimes(1);
    });

    it("keeps reading while pages are full, and returns every item in order", async () => {
      const fetchPage = vi
        .fn()
        .mockResolvedValueOnce([{ id: 1 }, { id: 2 }])
        .mockResolvedValueOnce([{ id: 3 }]);
      const out = await fetchAllPages(fetchPage, { maxPages: 10, pageSize: 2 });
      expect(out).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
      expect(fetchPage).toHaveBeenCalledTimes(2);
    });

    it("asks for pages 1, 2, 3 ... in order", async () => {
      // Every page is full, so the walk runs to the cap rather than stopping
      // on a short one.
      const fetchPage = vi.fn().mockResolvedValue([{ id: 1 }, { id: 2 }]);
      await fetchAllPages(fetchPage, { maxPages: 3, pageSize: 2 });
      expect(fetchPage.mock.calls.map((c) => c[0])).toEqual([1, 2, 3]);
    });

    it("stops on the FIRST short page, so an empty first page means one read", async () => {
      const fetchPage = vi.fn().mockResolvedValue([]);
      await fetchAllPages(fetchPage, { maxPages: 3, pageSize: 100 });
      expect(fetchPage.mock.calls.map((c) => c[0])).toEqual([1]);
    });

    it("stops on a SHORT page — not on an empty one", async () => {
      // GitHub's last page holds FEWER than per_page items. Stopping only on
      // an empty page would fetch one extra request per read and, worse,
      // drop the final page's items for every endpoint whose last page is
      // short — which is all of them.
      const fetchPage = vi
        .fn()
        .mockResolvedValueOnce([{ id: 1 }, { id: 2 }])
        .mockResolvedValueOnce([{ id: 3 }]);
      const out = await fetchAllPages(fetchPage, { maxPages: 10, pageSize: 2 });
      expect(out).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
      expect(fetchPage).toHaveBeenCalledTimes(2);
    });

    it("stops at the page cap even when every page read was full", async () => {
      const fetchPage = vi.fn().mockResolvedValue([{ id: 1 }, { id: 2 }]);
      const out = await fetchAllPages(fetchPage, { maxPages: 3, pageSize: 2 });
      expect(fetchPage).toHaveBeenCalledTimes(3);
      expect(out).toHaveLength(6);
    });

    it("returns nothing for an empty first page", async () => {
      const fetchPage = vi.fn().mockResolvedValue([]);
      const out = await fetchAllPages(fetchPage, { maxPages: 10, pageSize: 100 });
      expect(out).toEqual([]);
      expect(fetchPage).toHaveBeenCalledTimes(1);
    });

    it("honours the caller's own page size — a page shorter than it ends the walk", async () => {
      const fetchPage = vi
        .fn()
        .mockResolvedValueOnce([{ id: 1 }, { id: 2 }])
        .mockResolvedValueOnce([{ id: 3 }]);
      // Page size 3: the first page (2 items) is already short, so the walk
      // ends there even though the second page was available.
      const out = await fetchAllPages(fetchPage, { maxPages: 10, pageSize: 3 });
      expect(out).toEqual([{ id: 1 }, { id: 2 }]);
      expect(fetchPage).toHaveBeenCalledTimes(1);
    });

    it("propagates a failed page read instead of returning a partial list", async () => {
      const fetchPage = vi
        .fn()
        .mockResolvedValueOnce([{ id: 1 }])
        .mockRejectedValueOnce(new Error("boom"));
      await expect(fetchAllPages(fetchPage, { maxPages: 10, pageSize: 1 })).rejects.toThrow("boom");
    });
  });

  describe("envelope responses", () => {
    it("unwraps the items held under the envelope key", async () => {
      const fetchPage = vi.fn().mockResolvedValue({ check_runs: [{ id: 1 }, { id: 2 }] });
      const out = await fetchAllPages(fetchPage, {
        maxPages: 10,
        pageSize: 100,
        envelopeKey: "check_runs",
      });
      expect(out).toEqual([{ id: 1 }, { id: 2 }]);
      expect(fetchPage).toHaveBeenCalledTimes(1);
    });

    it("keeps walking while the envelope's inner page is full", async () => {
      const fetchPage = vi
        .fn()
        .mockResolvedValueOnce({ check_runs: [{ id: 1 }, { id: 2 }] })
        .mockResolvedValueOnce({ check_runs: [{ id: 3 }] });
      const out = await fetchAllPages(fetchPage, {
        maxPages: 10,
        pageSize: 2,
        envelopeKey: "check_runs",
      });
      expect(out).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
      expect(fetchPage).toHaveBeenCalledTimes(2);
    });

    it("measures the envelope's INNER array, not the response", async () => {
      // The response object always has one key, so a walk that measured the
      // response would see a page of one item and stop after the first read.
      const fetchPage = vi
        .fn()
        .mockResolvedValueOnce({ check_runs: [{ id: 1 }, { id: 2 }] })
        .mockResolvedValueOnce({ check_runs: [{ id: 3 }] });
      await fetchAllPages(fetchPage, { maxPages: 10, pageSize: 2, envelopeKey: "check_runs" });
      expect(fetchPage).toHaveBeenCalledTimes(2);
    });

    it("contributes no items when the envelope key is missing, ending the walk", async () => {
      const fetchPage = vi.fn().mockResolvedValue({ total_count: 0 });
      const out = await fetchAllPages(fetchPage, {
        maxPages: 10,
        pageSize: 100,
        envelopeKey: "check_runs",
      });
      expect(out).toEqual([]);
      expect(fetchPage).toHaveBeenCalledTimes(1);
    });

    it("stops at the page cap even when every envelope page was full", async () => {
      const fetchPage = vi.fn().mockResolvedValue({ check_runs: [{ id: 1 }, { id: 2 }] });
      const out = await fetchAllPages(fetchPage, {
        maxPages: 2,
        pageSize: 2,
        envelopeKey: "check_runs",
      });
      expect(fetchPage).toHaveBeenCalledTimes(2);
      expect(out).toHaveLength(4);
    });
  });
});
