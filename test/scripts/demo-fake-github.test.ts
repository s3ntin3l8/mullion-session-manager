import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeGithub } from "../../scripts/demo/fake-github.mjs";

// The fake only has to answer what the backend's sidebar/poller path reads;
// these pin the shapes that path depends on (src/services/github*.ts).

let fake: Awaited<ReturnType<typeof startFakeGithub>>;
beforeAll(async () => {
  fake = await startFakeGithub({ latestRelease: "v1.2.3" });
});
afterAll(() => fake.stop());

const get = async (p: string) => {
  const res = await fetch(fake.url + p);
  return { status: res.status, headers: res.headers, body: (await res.json()) as Row & Row[] };
};
const gql = async (query: string, variables: Record<string, unknown>) => {
  const res = await fetch(fake.url + "/graphql", {
    method: "POST",
    body: JSON.stringify({ query, variables }),
  });
  return (await res.json()) as { data: { repository: Record<string, Row> } };
};
// The slice of the fake's payloads these tests read.
type Row = {
  number: number;
  pull_request?: unknown;
  head: { sha: string };
  workflow_runs: Row[];
  reviewDecision?: string;
  reviewThreads: { nodes: unknown[] };
  nodes: Row[];
  pullRequests: Row;
  pullRequest: Row | null;
  [key: string]: unknown;
};
const vars = { owner: "acme", repo: "aurora-web" };

describe("fake GitHub API", () => {
  it("serves /user with the scopes header the PAT check reads", async () => {
    const r = await get("/user");
    expect(r.body.login).toBe("demo-user");
    expect(r.headers.get("x-oauth-scopes")).toContain("repo");
  });

  it("keeps open_issues_count consistent with the issue + PR lists", async () => {
    const repo = await get("/repos/acme/aurora-web");
    const all = await get("/repos/acme/aurora-web/issues?state=open&per_page=100");
    expect(repo.body.default_branch).toBe("main");
    expect(repo.body.open_issues_count).toBe(all.body.length);
    const prs = all.body.filter((i: Row) => i.pull_request);
    expect(prs.length).toBe((await get("/repos/acme/aurora-web/pulls?state=open")).body.length);
  });

  it("filters issues by label and hides PRs from a labelled list", async () => {
    const r = await get("/repos/acme/aurora-web/issues?state=open&labels=mullion-task");
    expect(r.body.map((i: Row) => i.number)).toEqual([9, 10]);
    expect(r.body.every((i: Row) => !i.pull_request)).toBe(true);
  });

  it("returns issue detail with body_html and an empty comment list", async () => {
    expect((await get("/repos/acme/aurora-web/issues/7")).body.body_html).toContain("<p>");
    expect((await get("/repos/acme/aurora-web/issues/7/comments")).body).toEqual([]);
    expect((await get("/repos/acme/aurora-web/issues/999")).status).toBe(404);
  });

  it("gives each PR a head sha its runs endpoint resolves", async () => {
    const pulls = (await get("/repos/acme/aurora-web/pulls")).body;
    const failing = pulls.find((p: Row) => p.number === 12);
    const runs = await get(`/repos/acme/aurora-web/actions/runs?head_sha=${failing!.head.sha}`);
    expect(runs.body.workflow_runs[0]).toMatchObject({
      status: "completed",
      conclusion: "failure",
    });
    const unknown = await get("/repos/acme/aurora-web/actions/runs?head_sha=deadbeef");
    expect(unknown.body.workflow_runs).toEqual([]);
  });

  it("answers the PR list, thread-count and detail GraphQL queries", async () => {
    const list = await gql(
      "{ repository { pullRequests(states: OPEN, first: 50) { nodes { number } } } }",
      vars,
    );
    const nodes = list.data.repository.pullRequests.nodes;
    expect(nodes.map((n: Row) => n.number)).toEqual([12, 14, 15, 17, 18]);
    expect(nodes.find((n: Row) => n.number === 14)?.reviewDecision).toBe("APPROVED");

    const threads = await gql(
      "{ repository { p18: pullRequest(number: 18) { reviewThreads(last: 50) { nodes { isResolved } } } } }",
      vars,
    );
    expect(threads.data.repository.p18.reviewThreads.nodes).toHaveLength(1);

    const detail = await gql(
      "query($owner:String!,$repo:String!,$number:Int!){ repository { pullRequest(number: $number) { number } } }",
      { ...vars, number: 12 },
    );
    expect(detail.data.repository.pullRequest).toMatchObject({ number: 12, state: "OPEN" });
    const missing = await gql("query { repository { pullRequest(number: $number) { number } } }", {
      ...vars,
      number: 404,
    });
    expect(missing.data.repository.pullRequest).toBeNull();
  });

  it("reports the configured release and 404s unknown paths without rate-limit signals", async () => {
    const rel = await get("/repos/s3ntin3l8/mullion-session-manager/releases?per_page=10");
    expect(rel.body[0].tag_name).toBe("v1.2.3");
    const nope = await get("/repos/other/repo/pulls");
    expect(nope.status).toBe(404);
    expect(nope.headers.get("retry-after")).toBeNull();
    expect(nope.headers.get("x-ratelimit-remaining")).toBeNull();
  });

  it("flips the live-tick PR's CI only when tickMs is set", async () => {
    const frozen = (await get("/repos/acme/aurora-web/pulls")).body.find(
      (p: Row) => p.number === 17,
    );
    expect(
      (await get(`/repos/acme/aurora-web/actions/runs?head_sha=${frozen!.head.sha}`)).body
        .workflow_runs[0].status,
    ).toBe("in_progress");

    const ticking = await startFakeGithub({ tickMs: 20 });
    try {
      await new Promise((r) => setTimeout(r, 80));
      const pulls = (await (
        await fetch(ticking.url + "/repos/acme/aurora-web/pulls")
      ).json()) as Row[];
      const pr = pulls.find((p: Row) => p.number === 17);
      const run = (await (
        await fetch(`${ticking.url}/repos/acme/aurora-web/actions/runs?head_sha=${pr!.head.sha}`)
      ).json()) as Row;
      expect(run.workflow_runs[0]).toMatchObject({ status: "completed", conclusion: "success" });
    } finally {
      await ticking.stop();
    }
  });
});
