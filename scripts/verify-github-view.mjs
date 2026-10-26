/**
 * Verifies the GitHub rail view's status-first PR list and PR detail in a real
 * browser (issue #1974).
 *
 * jsdom has no layout engine, so the unit tests cannot say whether the status
 * triad really stays on one line at 260px or whether the compact-density
 * container query really swaps in the short labels. This does, against a
 * throwaway Mullion (the repo's demo harness) whose GitHub endpoints are
 * answered by canned fixtures (the demo has no GitHub token), for each sidebar
 * width (260 = compact density, 340 = regular):
 *
 *   PR list:
 *     - every PR row's CI / Review / Merge triad is on ONE line,
 *     - at 260 the short labels show (`✗1`), at 340 the full ones,
 *     - an opened drilldown is full-bleed at 260 (no side border, accent bar),
 *     - nothing scrolls horizontally.
 *   PR detail:
 *     - the pinned "Latest review" card sits DIRECTLY under the Status card,
 *     - the PR's open-on-GitHub icon is in the header,
 *     - nothing scrolls horizontally.
 *
 * Screenshots of both views at both widths are written to $GITHUB_VIEW_SHOTS
 * (default: the OS temp dir) for eyeballing against
 * docs/design/git-github-sidebar/mockup.html.
 *
 * Usage: `make verify-github-view` (needs Playwright's Chromium once:
 * `npx playwright install chromium`). Not wired into CI, like the other
 * real-browser scripts.
 */
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { startDemo } from "./demo/instance.mjs";
import { withDemo } from "./demo/with-demo.mjs";

const SHOTS = process.env.GITHUB_VIEW_SHOTS ?? tmpdir();
const failures = [];

function check(label, ok, detail = "") {
  console.log(`[verify] ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

const REPO = { owner: "acme", repo: "widgets", htmlUrl: "https://github.com/acme/widgets" };
const ciRun = (id, name, conclusion) => ({
  name,
  status: "completed",
  conclusion,
  htmlUrl: `https://github.com/acme/widgets/actions/runs/${id}`,
  headSha: "abc1234",
});
const summary = (over) => ({
  decision: null,
  approved: [],
  changesRequested: [],
  commented: [],
  requested: [],
  relay: null,
  unresolvedThreads: null,
  latest: [],
  ...over,
});
const PRS = [
  {
    number: 1946,
    title: "fix(bundle): recover from interrupted sync",
    htmlUrl: "https://github.com/acme/widgets/pull/1946",
    author: "bjoern",
    headSha: "abc1234",
    headBranch: "fix-bundle-sync-recovery",
    baseBranch: "main",
    ciStatus: "failure",
    actionsRuns: [ciRun(1, "CI/CD", "failure"), ciRun(2, "CodeQL", "success")],
    prPhase: "ci_failing",
    unresolvedThreads: 2,
    reviewSummary: summary({ commented: ["hermes-bot"], unresolvedThreads: 2 }),
  },
  {
    number: 1960,
    title: "feat(hosts): targeted spawn on child host",
    htmlUrl: "https://github.com/acme/widgets/pull/1960",
    author: "bjoern",
    headSha: "def5678",
    headBranch: "child-target-host",
    baseBranch: "main",
    ciStatus: "success",
    actionsRuns: [ciRun(3, "CI/CD", "success")],
    prPhase: "ready_to_merge",
    reviewSummary: summary({ decision: "APPROVED", approved: ["alice"] }),
  },
  {
    number: 1962,
    title: "docs: draft — palette launcher",
    htmlUrl: "https://github.com/acme/widgets/pull/1962",
    author: "bjoern",
    headSha: "0123456",
    headBranch: "feat/1879",
    baseBranch: "main",
    ciStatus: null,
    actionsRuns: [],
    isDraft: true,
    prPhase: "draft",
  },
];
const STATUS = {
  repo: REPO,
  openIssues: 0,
  issuesHidden: false,
  openPRs: PRS.length,
  pulls: [],
  issues: [],
  actionsRuns: [],
  ciStatus: null,
};
const DETAIL = {
  number: 1946,
  title: PRS[0].title,
  htmlUrl: PRS[0].htmlUrl,
  state: "OPEN",
  isDraft: false,
  author: "bjoern",
  bodyHtml: "<p>Recovers the bundle sync after an interrupted transfer.</p>",
  baseBranch: "main",
  headBranch: "fix-bundle-sync-recovery",
  headSha: "abc1234",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
  additions: 831,
  deletions: 22,
  changedFiles: 16,
  commitCount: 3,
  commits: [
    { oid: "abc1234ffff", headline: "fix", author: null, committedDate: "t" },
    { oid: "bbb", headline: "more", author: null, committedDate: "t" },
    { oid: "ccc", headline: "again", author: null, committedDate: "t" },
  ],
  files: [],
  mergeable: "MERGEABLE",
  mergeStateStatus: "BLOCKED",
  reviewDecision: null,
  requestedReviewers: [],
  // A comment-only PR carries no opinionated reviewers; the summary has the comment.
  reviewers: [],
  reviewSummary: summary({
    commented: ["hermes-bot"],
    unresolvedThreads: 2,
    latest: [
      {
        author: "hermes-bot",
        isBot: true,
        state: "COMMENTED",
        body: "Looks right overall. Two things before this can land: the retry backoff never resets after a successful chunk, and the interrupted-state flag is written after the rename. The e2e failure looks like the second.",
        submittedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
        reviewedSha: "abc1234",
        stale: true,
      },
    ],
  }),
  reviews: [],
  threads: [],
  comments: [],
  ciStatus: "failure",
  ciKnown: true,
  actionsRuns: PRS[0].actionsRuns,
  prPhase: "ci_failing",
};

/** Answers the GitHub endpoints the view reads; everything else goes to the demo. */
async function mockGitHub(page) {
  await page.route(/\/api\/projects\/\d+\/(github|release)/, async (route) => {
    const { pathname } = new URL(route.request().url());
    const json = (body) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (/\/github\/prs\/\d+\/review$/.test(pathname)) return json({ state: "none" });
    if (/\/github\/prs\/\d+$/.test(pathname)) return json(DETAIL);
    if (/\/github\/prs$/.test(pathname)) {
      return json({
        prs: PRS,
        prSummary: { total: PRS.length, pass: 1, fail: 1, pending: 0, unknown: 1 },
      });
    }
    if (/\/github\/actions\/\d+\/jobs$/.test(pathname)) return json([]);
    if (/\/github\/issues/.test(pathname)) {
      return json({
        issues: [],
        page: 1,
        hasMore: false,
        labels: [],
        taskMasterEnabled: false,
        taskLabel: "mullion-task",
      });
    }
    if (/\/release$/.test(pathname)) {
      return json({
        detection: { kind: "not-configured" },
        pr: null,
        conventionalTitlesWarning: false,
      });
    }
    return json(STATUS);
  });
}

async function setWidth(page, width) {
  await page.evaluate((w) => {
    globalThis.document.querySelector(".right-sidebar-panel").style.width = `${w}px`;
  }, width);
  await page.waitForTimeout(300);
}

const hScroll = (page) =>
  page.evaluate(() => {
    const panel = globalThis.document.querySelector(".right-sidebar-panel");
    return panel.scrollWidth > panel.clientWidth + 1;
  });

async function run(browser, demo) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    await mockGitHub(page);
    await page.goto(demo.frontendUrl, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "GitHub", exact: true }).click();
    await page.locator(".pr-row").first().waitFor({ timeout: 15_000 });

    for (const [width, compact] of [
      [260, true],
      [340, false],
    ]) {
      const tag = `${width}px`;
      await setWidth(page, width);

      // ── PR list ──
      const triads = await page.evaluate(() =>
        [...globalThis.document.querySelectorAll(".pr-row .sb-triad")].map((t) => {
          const chips = [...t.querySelectorAll(".sb-chip")];
          const tops = new Set(chips.map((c) => Math.round(c.getBoundingClientRect().top)));
          const right = t.getBoundingClientRect().right;
          return {
            oneLine: tops.size === 1,
            chips: chips.length,
            // Wrapping onto a second line is fine at 340; spilling out is not.
            contained: chips.every((c) => c.getBoundingClientRect().right <= right + 1),
          };
        }),
      );
      check(`${tag}: ${triads.length} PR rows with a triad`, triads.length === PRS.length);
      check(
        `${tag}: every triad has CI, Review and Merge`,
        triads.every((t) => t.chips === 3),
      );
      // One line at 260 (compact short labels); at 340 the full labels may wrap
      // but must stay inside the row.
      check(
        `${tag}: every triad ${compact ? "is on one line" : "stays inside its row"}`,
        triads.every((t) => (compact ? t.oneLine : t.contained)),
      );
      const ciText = await page
        .locator(
          '.pr-row[data-pr="1946"] .sb-chip[title^="CI:"] .' +
            (compact ? "sb-chip-short" : "sb-chip-full"),
        )
        .innerText();
      check(
        `${tag}: CI chip shows the ${compact ? "short" : "full"} label`,
        ciText.includes("✗"),
        ciText,
      );
      check(`${tag}: list does not scroll horizontally`, !(await hScroll(page)));

      await page.locator('.pr-row[data-pr="1946"] .sb-chip[title^="CI:"]').click();
      await page.locator(".sb-drill").first().waitFor();
      const drill = await page.evaluate(() => {
        const d = globalThis.document.querySelector(".sb-drill");
        const cs = globalThis.getComputedStyle(d);
        return { left: cs.borderLeftWidth, right: cs.borderRightWidth, radius: cs.borderRadius };
      });
      if (compact) {
        check(
          `${tag}: drilldown is full-bleed with an accent bar`,
          drill.left === "2px" && drill.right === "0px" && drill.radius === "0px",
          JSON.stringify(drill),
        );
      }
      check(`${tag}: list with drilldown does not scroll horizontally`, !(await hScroll(page)));
      await page.locator(".right-sidebar-panel").screenshot({
        path: path.join(SHOTS, `github-list-${width}.png`),
      });
      await page.locator('.pr-row[data-pr="1946"] .sb-chip[title^="CI:"]').click();

      // ── PR detail ──
      await page.locator('.pr-row[data-pr="1946"] .sb-row-title--btn').click();
      await page.locator(".pr-card--pin").waitFor({ timeout: 10_000 });
      const order = await page.evaluate(() => {
        const cards = [...globalThis.document.querySelectorAll(".pr-detail-scroll > .pr-card")];
        const status = cards[0]?.querySelector(".pr-card-h")?.textContent;
        return { status, second: cards[1]?.classList.contains("pr-card--pin") };
      });
      check(
        `${tag}: the pinned review sits directly under Status`,
        order.status === "Status" && order.second === true,
        JSON.stringify(order),
      );
      check(
        `${tag}: the PR's own open-on-GitHub icon is in the header`,
        (await page.getByRole("link", { name: "Open PR #1946 on GitHub" }).getAttribute("href")) ===
          PRS[0].htmlUrl,
      );
      await page.getByRole("button", { name: /Reviews/ }).click();
      check(
        `${tag}: a comment-only PR's Reviews drilldown lists the commenter`,
        (
          await page
            .locator('.sb-drill[aria-label="Reviews"], [role="region"][aria-label="Reviews"]')
            .innerText()
        ).includes("hermes-bot"),
      );
      check(`${tag}: detail does not scroll horizontally`, !(await hScroll(page)));
      await page.locator(".right-sidebar-panel").screenshot({
        path: path.join(SHOTS, `github-detail-${width}.png`),
      });
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await page.locator(".pr-row").first().waitFor();
    }
    console.log(`[verify] screenshots in ${SHOTS}`);
  } finally {
    await context.close();
  }
  if (failures.length) {
    console.error(`[verify] ${failures.length} check(s) failed`);
    process.exitCode = 1;
  }
}

await withDemo({
  startDemo: () => startDemo({ quiet: true }),
  launchBrowser: () => chromium.launch(),
  run,
});
