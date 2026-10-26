/**
 * Verifies the History rail view's layout in a real browser (issue #1973).
 *
 * jsdom has no layout engine, so the unit tests cannot say whether the subject
 * column really survives a wide graph or whether the compact-density container
 * query really folds the ref chips. This does, against a throwaway Mullion
 * (the repo's demo harness) whose seeded repo is given a deliberately wide
 * history -- eleven branches forked from one commit, so `All branches` draws
 * eleven lanes at its widest:
 *
 *   for each sidebar width (260 = compact density, 340 = regular):
 *     - every row is exactly one line tall (no wrapped chips),
 *     - the widest graph column stays within the 6-lane cap,
 *     - the text column (everything right of the graph: subject, refs, time)
 *       keeps >= 60% of the row, and every subject keeps >= 30% of it, so
 *       none is ellipsised away,
 *     - nothing scrolls horizontally,
 *     - at 260 the ref chips are folded into one count chip, at 340 the
 *       inline chips show.
 *
 * Screenshots of both widths are written to $HISTORY_VIEW_SHOTS (default: the
 * OS temp dir) for eyeballing against docs/design/git-github-sidebar/mockup.html.
 *
 * Usage: `make verify-history-view` (needs Playwright's Chromium once:
 * `npx playwright install chromium`). Not wired into CI, like the other
 * real-browser scripts.
 */
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { GIT_NO_AUTO_GC, gitEnv } from "./git-env.mjs";
import { startDemo } from "./demo/instance.mjs";
import { withDemo } from "./demo/with-demo.mjs";

const execFileAsync = promisify(execFile);
const SHOTS = process.env.HISTORY_VIEW_SHOTS ?? tmpdir();
const failures = [];
const IDENTITY = {
  GIT_AUTHOR_NAME: "Demo",
  GIT_AUTHOR_EMAIL: "demo@example.invalid",
  GIT_COMMITTER_NAME: "Demo",
  GIT_COMMITTER_EMAIL: "demo@example.invalid",
};

function check(label, ok, detail = "") {
  console.log(`[verify] ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

/**
 * Eleven branches off the first commit, one commit each, one with a long name.
 * Built with plumbing: the seeded work tree is deliberately dirty, so a
 * checkout would refuse.
 */
async function widenHistory(repo) {
  const out = async (...args) => {
    const { stdout } = await execFileAsync("git", [...GIT_NO_AUTO_GC, ...args], {
      cwd: repo,
      env: { ...gitEnv(), ...IDENTITY },
    });
    return stdout.trim();
  };
  const root = await out("rev-list", "--max-parents=0", "HEAD");
  const tree = await out("rev-parse", `${root}^{tree}`);
  for (let i = 0; i < 11; i += 1) {
    const name = i === 3 ? "feat/1877-sidebar-workspace-scope" : `topic-${i}`;
    const sha = await out(
      "commit-tree",
      tree,
      "-p",
      root,
      "-m",
      `topic ${i}: a reasonably long subject`,
    );
    await out("branch", name, sha);
  }
}

async function measure(page) {
  return page.evaluate(() => {
    const doc = globalThis.document;
    const rows = [...doc.querySelectorAll(".gh-commit-row")];
    const panel = doc.querySelector(".right-sidebar-panel");
    return {
      rows: rows.length,
      tall: rows.filter((r) => r.getBoundingClientRect().height > 30).length,
      maxGraph: Math.max(
        ...rows.map((r) => r.querySelector(".gh-graph").getBoundingClientRect().width),
      ),
      minTextShare: Math.min(
        ...rows.map(
          (r) =>
            1 -
            r.querySelector(".gh-graph").getBoundingClientRect().width /
              r.getBoundingClientRect().width,
        ),
      ),
      minSubjectShare: Math.min(
        ...rows.map(
          (r) =>
            r.querySelector(".gh-commit-subject").getBoundingClientRect().width /
            r.getBoundingClientRect().width,
        ),
      ),
      hScroll: panel.scrollWidth > panel.clientWidth + 1,
      inlineVisible: rows.some((r) => {
        const el = r.querySelector(".gh-commit-refs--inline");
        return el && globalThis.getComputedStyle(el).display !== "none";
      }),
      countVisible: rows.some((r) => {
        const el = r.querySelector(".gh-commit-refs--count");
        return el && globalThis.getComputedStyle(el).display !== "none";
      }),
    };
  });
}

async function run(browser, demo) {
  const repo = path.join(demo.demoDir, "projects", "aurora-web");
  await widenHistory(repo);

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    await page.goto(demo.frontendUrl, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "History", exact: true }).click();
    await page.locator(".history-sidebar-view").waitFor();
    await page.getByLabel("History scope").selectOption("all");
    await page.locator(".gh-commit-row").first().waitFor({ timeout: 15_000 });

    for (const [width, compact] of [
      [260, true],
      [340, false],
    ]) {
      await page.evaluate((w) => {
        globalThis.document.querySelector(".right-sidebar-panel").style.width = `${w}px`;
      }, width);
      await page.waitForTimeout(300);
      const m = await measure(page);
      const tag = `${width}px`;
      check(`${tag}: rows rendered`, m.rows >= 12, `${m.rows} rows`);
      check(`${tag}: every row is one line`, m.tall === 0, `${m.tall} tall rows`);
      check(`${tag}: graph column within the 6-lane cap`, m.maxGraph <= 76, `${m.maxGraph}px`);
      check(
        `${tag}: text column keeps >= 60% of the row`,
        m.minTextShare >= 0.6,
        `${(m.minTextShare * 100).toFixed(0)}%`,
      );
      check(
        `${tag}: every subject keeps >= 30% of the row`,
        m.minSubjectShare >= 0.3,
        `${(m.minSubjectShare * 100).toFixed(0)}%`,
      );
      check(`${tag}: no horizontal scroll`, !m.hScroll);
      check(
        `${tag}: ${compact ? "refs folded into a count" : "inline ref chips shown"}`,
        compact ? m.countVisible && !m.inlineVisible : m.inlineVisible && !m.countVisible,
      );
      await page.locator(".right-sidebar-panel").screenshot({
        path: path.join(SHOTS, `history-${width}.png`),
      });
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
