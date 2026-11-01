import { createServer } from "node:http";

/**
 * A loopback fake of the GitHub REST + GraphQL API for the demo instance.
 *
 * The backend reaches GitHub through one configurable base
 * (MULLION_GITHUB_API_URL, src/services/github-fetch.ts), so pointing it here
 * lets the demo show PRs, issues and CI without an account. It answers only
 * what the sidebar/poller path reads (see the per-route notes), and 404s the
 * rest. It never sends rate-limit signals (429, or 403 with Retry-After /
 * x-ratelimit-remaining: 0), which would stop all GitHub calls process-wide.
 *
 * The data is keyed on `acme/<repo>`; scripts/demo/seed.mjs gives each demo
 * checkout a github.com origin with that owner/repo.
 */

export const DEMO_GITHUB_OWNER = "acme";
export const DEMO_GITHUB_LOGIN = "demo-user";

const MIN = 60_000;

function sha(n) {
  return n.toString(16).padStart(40, "0");
}

function iso(minutesAgo, now) {
  return new Date(now - minutesAgo * MIN).toISOString();
}

function esc(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ci: success | failure | pending. review: null | APPROVED | CHANGES_REQUESTED
// | REVIEW_REQUIRED. Reviewers are never the Hermes relay bot (the poller
// would call the relay for it).
function pullsFor(repo) {
  if (repo === "aurora-web")
    return [
      {
        number: 12,
        title: "Add login rate limiting",
        author: "mira",
        branch: "feat/login-rate-limit",
        ci: "failure",
        review: "REVIEW_REQUIRED",
        age: 95,
        body: "Throttles `/login` to 5 attempts per minute per IP.\n\nCloses #10.",
        files: [
          ["src/auth/rateLimit.ts", "added", 64, 0],
          ["src/auth/login.ts", "modified", 9, 2],
        ],
      },
      {
        number: 14,
        title: "Fix focus loss in the login form",
        author: "jonas",
        branch: "fix/login-focus",
        ci: "success",
        review: "APPROVED",
        age: 300,
        body: "Keeps focus on the field that had it when validation re-renders.\n\nCloses #7.",
        files: [["src/ui/LoginForm.tsx", "modified", 11, 4]],
        reviews: [["mira", "APPROVED", "Looks good."]],
      },
      {
        number: 15,
        title: "WIP: dark mode palette",
        author: "mira",
        branch: "feat/dark-palette",
        draft: true,
        ci: "pending",
        review: null,
        age: 40,
        body: "Draft. Contrast pass still to do.",
        files: [["src/ui/theme.ts", "modified", 40, 12]],
      },
      {
        number: 17,
        title: "Cache the session lookup",
        author: "jonas",
        branch: "perf/session-cache",
        ci: "pending",
        // The one PR the live tick moves (pending -> success).
        ticks: true,
        review: "REVIEW_REQUIRED",
        age: 12,
        body: "Memoises the session row for the duration of a request.",
        files: [["src/auth/session.ts", "modified", 22, 6]],
      },
      {
        number: 18,
        title: "Rework the settings page layout",
        author: "mira",
        branch: "feat/settings-layout",
        ci: "success",
        review: "CHANGES_REQUESTED",
        age: 1500,
        body: "Moves the account section to the top.",
        files: [["src/ui/Settings.tsx", "modified", 58, 31]],
        reviews: [["jonas", "CHANGES_REQUESTED", "The mobile layout breaks below 360px."]],
        threads: [
          { path: "src/ui/Settings.tsx", line: 41, author: "jonas", body: "Use the grid here." },
        ],
      },
    ];
  return [
    {
      number: 5,
      title: "Speed up the orders query",
      author: "jonas",
      branch: "perf/orders-query",
      ci: "success",
      review: "REVIEW_REQUIRED",
      age: 70,
      body: "Adds a covering index and drops the N+1 on line items.",
      files: [["src/db/orders.ts", "modified", 18, 27]],
    },
    {
      number: 6,
      title: "Paginate the customers endpoint",
      author: "mira",
      branch: "feat/customers-pagination",
      ci: "failure",
      review: "APPROVED",
      age: 2800,
      conflicting: true,
      body: "Cursor-based pagination. Needs a rebase.",
      files: [["src/routes/customers.ts", "modified", 33, 10]],
      reviews: [["jonas", "APPROVED", "Approved once it rebases."]],
    },
  ];
}

// `task` marks issues that carry the Task Master label.
function issuesFor(repo) {
  if (repo === "aurora-web")
    return [
      {
        number: 7,
        title: "Login form loses focus on validation",
        author: "mira",
        age: 4000,
        labels: ["bug"],
      },
      {
        number: 9,
        title: "Dark mode: low contrast on disabled buttons",
        author: "jonas",
        age: 2600,
        labels: ["ui", "mullion-task"],
      },
      {
        number: 10,
        title: "Add rate limiting to the login route",
        author: "mira",
        age: 1900,
        labels: ["enhancement", "mullion-task"],
      },
      {
        number: 11,
        title: "Document the session cookie lifetime",
        author: "jonas",
        age: 900,
        labels: ["docs"],
      },
    ];
  return [
    {
      number: 3,
      title: "Orders list is slow with >10k rows",
      author: "mira",
      age: 3200,
      labels: ["bug", "mullion-task"],
    },
    {
      number: 4,
      title: "Expose a health endpoint",
      author: "jonas",
      age: 700,
      labels: ["enhancement"],
    },
  ];
}

const LABEL_COLORS = {
  bug: "d73a4a",
  ui: "a2eeef",
  enhancement: "84b6eb",
  docs: "0075ca",
  "mullion-task": "5319e7",
};

function buildState(now) {
  const state = {};
  for (const repo of ["aurora-web", "orbit-api"]) {
    const pulls = pullsFor(repo).map((p) => ({
      ...p,
      sha: sha(p.number * 4099 + repo.length),
      created: iso(p.age, now),
      updated: iso(Math.min(p.age, 30), now),
      reviews: p.reviews ?? [],
      threads: p.threads ?? [],
    }));
    const issues = issuesFor(repo).map((i) => ({
      ...i,
      created: iso(i.age, now),
      updated: iso(Math.min(i.age, 60), now),
      body: `Details for "${i.title}".`,
    }));
    state[repo] = { pulls, issues };
  }
  return state;
}

function ciRun(pr, repoName) {
  const base = {
    name: "CI",
    html_url: `https://github.com/${DEMO_GITHUB_OWNER}/${repoName}/actions/runs/${pr.number}`,
    head_sha: pr.sha,
  };
  if (pr.ci === "pending") return { ...base, status: "in_progress", conclusion: null };
  return { ...base, status: "completed", conclusion: pr.ci === "success" ? "success" : "failure" };
}

const ROLLUP = { success: "SUCCESS", failure: "FAILURE", pending: "PENDING" };

function author(login) {
  return login ? { login } : null;
}

function reviewNode(r, sha) {
  return {
    author: { login: r[0], __typename: "User" },
    state: r[1],
    body: r[2],
    bodyHTML: `<p>${esc(r[2])}</p>`,
    submittedAt: new Date(0).toISOString(),
    commit: { oid: sha },
    comments: { totalCount: 0 },
  };
}

function prListNode(pr) {
  const reviews = pr.reviews.map((r) => reviewNode(r, pr.sha));
  return {
    number: pr.number,
    isDraft: !!pr.draft,
    updatedAt: pr.updated,
    mergeable: pr.conflicting ? "CONFLICTING" : "MERGEABLE",
    mergeStateStatus: pr.conflicting
      ? "DIRTY"
      : pr.ci === "success" && pr.review === "APPROVED"
        ? "CLEAN"
        : "BLOCKED",
    reviewDecision: pr.review,
    reviewRequests: { nodes: [] },
    latestOpinionatedReviews: {
      nodes: reviews.map((r) => ({
        author: { login: r.author.login },
        state: r.state,
        commit: r.commit,
      })),
    },
    latestReviews: { nodes: reviews },
    comments: { totalCount: pr.threads.length },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: ROLLUP[pr.ci] } } }] },
  };
}

function prDetailNode(pr, repoName) {
  const list = prListNode(pr);
  const url = `https://github.com/${DEMO_GITHUB_OWNER}/${repoName}/pull/${pr.number}`;
  return {
    number: pr.number,
    title: pr.title,
    url,
    bodyHTML: `<p>${esc(pr.body).replace(/\n\n/g, "</p><p>")}</p>`,
    state: "OPEN",
    isDraft: !!pr.draft,
    isCrossRepository: false,
    baseRefName: "main",
    headRefName: pr.branch,
    headRefOid: pr.sha,
    additions: pr.files.reduce((n, f) => n + f[2], 0),
    deletions: pr.files.reduce((n, f) => n + f[3], 0),
    changedFiles: pr.files.length,
    createdAt: pr.created,
    updatedAt: pr.updated,
    author: author(pr.author),
    mergeable: list.mergeable,
    mergeStateStatus: list.mergeStateStatus,
    reviewDecision: list.reviewDecision,
    commits: {
      totalCount: 1,
      nodes: [
        {
          commit: {
            oid: pr.sha,
            messageHeadline: pr.title,
            committedDate: pr.updated,
            author: { name: pr.author },
          },
        },
      ],
    },
    headCommit: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              state: ROLLUP[pr.ci],
              contexts: { totalCount: 0, nodes: [] },
            },
          },
        },
      ],
    },
    reviewRequests: list.reviewRequests,
    latestOpinionatedReviews: list.latestOpinionatedReviews,
    latestReviews: list.latestReviews,
    reviews: { nodes: pr.reviews.map((r) => reviewNode(r, pr.sha)) },
    reviewThreads: {
      totalCount: pr.threads.length,
      nodes: pr.threads.map((t, i) => ({
        id: `T_${pr.number}_${i}`,
        isResolved: false,
        isOutdated: false,
        path: t.path,
        line: t.line,
        comments: {
          nodes: [
            {
              author: { login: t.author },
              bodyHTML: `<p>${esc(t.body)}</p>`,
              createdAt: pr.updated,
            },
          ],
        },
      })),
    },
    comments: { nodes: [] },
  };
}

function issueJson(i, repoName, withHtml) {
  const url = `https://github.com/${DEMO_GITHUB_OWNER}/${repoName}/issues/${i.number}`;
  return {
    number: i.number,
    title: i.title,
    html_url: url,
    state: "open",
    user: { login: i.author },
    labels: i.labels.map((name) => ({ name, color: LABEL_COLORS[name] ?? "ededed" })),
    assignees: [],
    comments: 0,
    milestone: null,
    created_at: i.created,
    updated_at: i.updated,
    ...(withHtml ? { body_html: `<p>${esc(i.body)}</p>` } : {}),
  };
}

function pullListItem(pr, repoName) {
  return {
    number: pr.number,
    title: pr.title,
    html_url: `https://github.com/${DEMO_GITHUB_OWNER}/${repoName}/pull/${pr.number}`,
    user: { login: pr.author },
    head: { sha: pr.sha, ref: pr.branch },
    base: { ref: "main" },
    draft: !!pr.draft,
    updated_at: pr.updated,
  };
}

/**
 * Starts the fake on an ephemeral loopback port.
 * `tickMs`: when > 0, the live-tick PR's CI flips pending -> success after
 * that long and its updated_at moves, so the backend's poller sees a change
 * and pushes /ws/github. 0 keeps the data frozen (screenshots).
 * `latestRelease`: the tag the releases endpoint reports, so the update
 * banner does not depend on the network.
 */
export async function startFakeGithub({ tickMs = 0, latestRelease = "v99.0.0" } = {}) {
  const state = buildState(Date.now());
  const repoOf = (name) => state[name];

  let tickTimer;
  if (tickMs > 0) {
    tickTimer = setTimeout(() => {
      for (const { pulls } of Object.values(state))
        for (const pr of pulls)
          if (pr.ticks) {
            pr.ci = "success";
            pr.updated = new Date().toISOString();
          }
    }, tickMs);
    tickTimer.unref();
  }

  const json = (res, body, status = 200, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };

  function graphql(body) {
    const { query = "", variables = {} } = body;
    if (query.includes("viewer { login }"))
      return { data: { viewer: { login: DEMO_GITHUB_LOGIN } } };
    const repo = repoOf(variables.repo);
    if (!repo) return { data: { repository: null } };
    const data = { repository: {} };
    if (query.includes("pullRequests(states: OPEN")) {
      data.repository.pullRequests = { nodes: repo.pulls.map(prListNode) };
      return { data };
    }
    // Thread counts: aliases like `p12: pullRequest(number: 12) {...}`.
    const aliases = [...query.matchAll(/(p\d+): pullRequest\(number: (\d+)\)/g)];
    if (aliases.length > 0) {
      for (const [, alias, num] of aliases) {
        const pr = repo.pulls.find((p) => p.number === Number(num));
        data.repository[alias] = pr
          ? { reviewThreads: { nodes: pr.threads.map(() => ({ isResolved: false })) } }
          : null;
      }
      return { data };
    }
    if (query.includes("pullRequest(number: $number)")) {
      const pr = repo.pulls.find((p) => p.number === Number(variables.number));
      data.repository.pullRequest = pr ? prDetailNode(pr, variables.repo) : null;
      return { data };
    }
    return { data: {} };
  }

  function rest(url, res) {
    const { pathname, searchParams: q } = url;
    if (pathname === "/user")
      return json(res, { login: DEMO_GITHUB_LOGIN }, 200, { "x-oauth-scopes": "repo, read:org" });

    const rel = pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/releases$/);
    if (rel)
      return json(res, [
        {
          tag_name: latestRelease,
          html_url: `https://github.com/${rel[1]}/${rel[2]}/releases/tag/${latestRelease}`,
          draft: false,
          prerelease: false,
          assets: [],
        },
      ]);

    const m = pathname.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
    const repoName = m?.[2];
    const repo = repoOf(repoName);
    if (!m || m[1] !== DEMO_GITHUB_OWNER || !repo) return json(res, { message: "Not Found" }, 404);
    const sub = m[3] ?? "";

    if (sub === "")
      return json(res, {
        default_branch: "main",
        private: false,
        open_issues_count: repo.issues.length + repo.pulls.length,
        permissions: { push: true, maintain: false, admin: false },
      });

    if (sub === "/issues") {
      const wanted = (q.get("labels") ?? "").split(",").filter(Boolean);
      const perPage = Number(q.get("per_page") ?? 30);
      const page = Number(q.get("page") ?? 1);
      const issues = repo.issues.filter((i) => wanted.every((l) => i.labels.includes(l)));
      // The unlabelled list is what getRepoStatus reads: PRs show up in it
      // too, marked by `pull_request`.
      const prs = wanted.length === 0 ? repo.pulls : [];
      const items = [
        ...issues.map((i) => issueJson(i, repoName, false)),
        ...prs.map((p) => ({
          number: p.number,
          title: p.title,
          html_url: pullListItem(p, repoName).html_url,
          user: { login: p.author },
          labels: [],
          assignees: [],
          comments: 0,
          milestone: null,
          created_at: p.created,
          updated_at: p.updated,
          state: "open",
          pull_request: {},
        })),
      ];
      return json(res, page === 1 ? items.slice(0, perPage) : []);
    }

    const issueMatch = sub.match(/^\/issues\/(\d+)(\/comments)?$/);
    if (issueMatch) {
      const issue = repo.issues.find((i) => i.number === Number(issueMatch[1]));
      if (!issue) return json(res, { message: "Not Found" }, 404);
      return json(res, issueMatch[2] ? [] : issueJson(issue, repoName, true));
    }

    if (sub === "/pulls")
      return json(
        res,
        repo.pulls.map((p) => pullListItem(p, repoName)),
      );

    const prMatch = sub.match(/^\/pulls\/(\d+)(\/files|\/reviews)?$/);
    if (prMatch) {
      const pr = repo.pulls.find((p) => p.number === Number(prMatch[1]));
      if (!pr) return json(res, { message: "Not Found" }, 404);
      if (prMatch[2] === "/reviews") return json(res, []);
      if (prMatch[2] === "/files")
        return json(
          res,
          pr.files.map(([filename, status, additions, deletions]) => ({
            filename,
            status,
            additions,
            deletions,
          })),
        );
      return json(res, {
        ...pullListItem(pr, repoName),
        state: "open",
        merged: false,
        created_at: pr.created,
        additions: pr.files.reduce((n, f) => n + f[2], 0),
        deletions: pr.files.reduce((n, f) => n + f[3], 0),
        changed_files: pr.files.length,
        commits: 1,
        mergeable: !pr.conflicting,
        head: {
          ref: pr.branch,
          sha: pr.sha,
          repo: { full_name: `${DEMO_GITHUB_OWNER}/${repoName}` },
        },
      });
    }

    if (sub === "/actions/runs") {
      const head = q.get("head_sha");
      const pr = head ? repo.pulls.find((p) => p.sha === head) : null;
      // The default branch's run is always green; a PR head gets its own.
      const run = pr
        ? ciRun(pr, repoName)
        : {
            name: "CI",
            status: "completed",
            conclusion: "success",
            html_url: `https://github.com/${DEMO_GITHUB_OWNER}/${repoName}/actions`,
            head_sha: sha(1),
          };
      return json(res, { workflow_runs: head && !pr ? [] : [run] });
    }

    if (sub.startsWith("/compare/")) return json(res, { behind_by: 0 });
    if (sub === "/contents") return json(res, []);
    if (sub === "/actions/workflows") return json(res, { workflows: [] });
    if (/^\/commits\/[^/]+\/check-runs$/.test(sub)) return json(res, { check_runs: [] });
    return json(res, { message: "Not Found" }, 404);
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "POST" && url.pathname === "/graphql") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        try {
          json(res, graphql(JSON.parse(Buffer.concat(chunks).toString() || "{}")));
        } catch {
          json(res, { message: "Bad Request" }, 400);
        }
      });
      return;
    }
    if (req.method !== "GET") return json(res, { message: "Not Found" }, 404);
    rest(url, res);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    state,
    async stop() {
      clearTimeout(tickTimer);
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
