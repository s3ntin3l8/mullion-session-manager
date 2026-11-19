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

  it("walks back past a last page that comes back empty, rather than falling to page 1", async () => {
    // The issue says 250, but the listing has already lost the last 50 (deleted).
    serve(250);
    const real = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation(async (path: string) =>
      /page=3$/.test(path) ? { ok: true, status: 200, json: async () => [] } : real(path),
    );
    const got = await ids();
    expect(got).toHaveLength(100);
    expect(got[0]).toBe(101);
    expect(got[99]).toBe(200);
  });

  it("does not need a second request when the last page is full", async () => {
    serve(200);
    const got = await ids();
    expect(got[0]).toBe(101);
    expect(got[99]).toBe(200);
    expect(mockFetch.mock.calls.filter(([p]) => String(p).includes("/comments"))).toHaveLength(2);
  });
});

describe("getIssueDetail's relations", () => {
  beforeEach(() => mockFetch.mockReset());

  const route = (raw: object, extra: Record<string, unknown>) =>
    mockFetch.mockImplementation(async (path: string) => {
      const hit = Object.entries(extra).find(([k]) => String(path).includes(k));
      const body = hit ? hit[1] : /comments\?/.test(String(path)) ? [] : raw;
      if (body instanceof Error) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => body };
    });

  it("returns the children and the parent", async () => {
    route(
      {
        ...issue(0),
        parent_issue_url: "https://api.github.com/repos/o/r/issues/3",
        sub_issues_summary: { total: 2, completed: 1 },
      },
      {
        "/issues/7/sub_issues": [
          { number: 11, title: "a", state: "open" },
          { number: 12, title: "b", state: "closed" },
        ],
        "/issues/3": { number: 3, title: "epic", state: "open" },
      },
    );
    const d = await getIssueDetail("tok", "o", "r", 7);
    expect(d.subIssues).toEqual([
      { number: 11, title: "a", state: "open" },
      { number: 12, title: "b", state: "closed" },
    ]);
    expect(d.subIssuesSummary).toEqual({ total: 2, completed: 1 });
    expect(d.parent).toEqual({ number: 3, title: "epic", state: "open" });
  });

  it("makes no relation requests for an unrelated issue", async () => {
    route(issue(0), {});
    const d = await getIssueDetail("tok", "o", "r", 7);
    expect(d).toMatchObject({ subIssues: [], subIssuesSummary: null, parent: null });
    expect(mockFetch.mock.calls.some(([p]) => String(p).includes("sub_issues"))).toBe(false);
  });

  it("hides the relations rather than failing the detail when GitHub errors", async () => {
    route(
      {
        ...issue(0),
        parent_issue_url: "https://api.github.com/repos/o/r/issues/3",
        sub_issues_summary: { total: 1, completed: 0 },
      },
      { "/sub_issues": new Error("x"), "/issues/3": new Error("x") },
    );
    const d = await getIssueDetail("tok", "o", "r", 7);
    expect(d.subIssues).toEqual([]);
    expect(d.parent).toBeNull();
  });

  it("fetches a cross-repo parent from its own repo and marks it, same for sibling-repo children", async () => {
    route(
      {
        ...issue(0),
        parent_issue_url: "https://api.github.com/repos/o/other/issues/3",
        sub_issues_summary: { total: 2, completed: 0 },
      },
      {
        "/issues/7/sub_issues": [
          {
            number: 5,
            title: "same repo",
            state: "open",
            repository_url: "https://api.github.com/repos/o/r",
          },
          {
            number: 5,
            title: "sibling",
            state: "open",
            repository_url: "https://api.github.com/repos/o/other",
          },
        ],
        "/repos/o/other/issues/3": { number: 3, title: "epic elsewhere", state: "open" },
      },
    );
    const d = await getIssueDetail("tok", "o", "r", 7);
    expect(d.parent).toEqual({
      number: 3,
      title: "epic elsewhere",
      state: "open",
      repo: "o/other",
    });
    expect(d.subIssues[0]).not.toHaveProperty("repo");
    expect(d.subIssues[1]).toMatchObject({ number: 5, repo: "o/other" });
    expect(mockFetch.mock.calls.some(([p]) => String(p) === "/repos/o/r/issues/3")).toBe(false);
  });
});
