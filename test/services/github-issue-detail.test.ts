import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.fn();
vi.mock("../../src/services/github-fetch.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, githubApiFetch: mockFetch };
});

const { getIssueDetail } = await import("../../src/services/github-issues.js");

const issue = (comments: number) => ({
  number: 7,
  title: "t",
  html_url: "https://github.com/o/r/issues/7",
  user: { login: "a" },
  comments,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  state: "open",
  body_html: "<p>b</p>",
});

// Comment ids 1..n, oldest first, as GitHub lists them.
const page = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => ({
    id: from + i,
    user: { login: "u" },
    body_html: `<p>${from + i}</p>`,
    created_at: "2026-01-02T00:00:00Z",
    html_url: `https://github.com/o/r/issues/7#c${from + i}`,
  }));

function serve(commentCount: number) {
  mockFetch.mockImplementation(async (path: string) => {
    const m = /comments\?per_page=100(?:&page=(\d+))?$/.exec(path);
    const n = m ? Number(m[1] ?? 1) : 0;
    const body = m ? page((n - 1) * 100 + 1, Math.min(n * 100, commentCount)) : issue(commentCount);
    return { ok: true, status: 200, json: async () => body };
  });
}

const ids = async () =>
  (await getIssueDetail("tok", "o", "r", 7).then((d) => d.comments)).map((c) => c.id);

describe("getIssueDetail's comments", () => {
  beforeEach(() => mockFetch.mockReset());

  it("returns a short thread whole, in one request for the comments", async () => {
    serve(3);
    expect(await ids()).toEqual([1, 2, 3]);
    expect(mockFetch.mock.calls.filter(([p]) => String(p).includes("/comments"))).toHaveLength(1);
  });

  it("returns the LATEST 100 of a long thread, not the first 100", async () => {
    serve(250);
    const got = await ids();
    expect(got).toHaveLength(100);
    expect(got[0]).toBe(151);
    expect(got[99]).toBe(250);
  });

  it("tops a short last page up from the page before it", async () => {
    serve(105);
    const got = await ids();
    expect(got).toHaveLength(100);
    expect(got[0]).toBe(6);
    expect(got[99]).toBe(105);
  });

  it("does not need a second request when the last page is full", async () => {
    serve(200);
    const got = await ids();
    expect(got[0]).toBe(101);
    expect(got[99]).toBe(200);
    expect(mockFetch.mock.calls.filter(([p]) => String(p).includes("/comments"))).toHaveLength(2);
  });
});
