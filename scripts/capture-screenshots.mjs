#!/usr/bin/env node
// Captures the PWA install-dialogue screenshots referenced from
// frontend/public/site.webmanifest's `screenshots` array. Fully
// self-contained: creates its own scratch git repos, demo "agent
// transcript" scripts, projects, sessions, and tasks through the running
// backend's REST API — nothing pre-seeded, nothing committed elsewhere in
// the repo required.
//
// Prerequisites (not run by this script — see CLAUDE.md's "Dev server can
// hijack the production control socket" note for why a scratch instance is
// required rather than pointing this at a real deployment):
//   1. A throwaway dev backend + frontend, isolated from any real install
//      (own DATABASE_URL/SESSIONS_DIR/PORT, MULLION_* scrubbed from the
//      spawning shell's env). This script assumes the frontend is reachable
//      at FRONTEND_URL (default http://127.0.0.1:5174) and the backend at
//      BACKEND_URL (default http://127.0.0.1:3556).
//   2. Chromium already installed for Playwright (`npx playwright install
//      chromium` — already present in this repo's local browser cache as
//      of authoring).
//
// Regenerate with: node scripts/capture-screenshots.mjs
import { chromium } from "playwright";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "..", "frontend", "public", "screenshots");
const FRONTEND_URL = process.env.FRONTEND_URL ?? "http://127.0.0.1:5174";
const BACKEND_URL = process.env.BACKEND_URL ?? "http://127.0.0.1:3556";

const WIDE = { width: 1920, height: 1080 };
// 375 CSS px is under styles.css's 699px mobile breakpoint, so the mobile
// layout (drawer sidebar, maximized single group, MobileKeyBar) actually
// renders — a plain "750px viewport" would just show the desktop layout
// letterboxed. deviceScaleFactor: 2 gets the file back up to a full-size
// 750-wide image for the manifest's `narrow` entries.
const NARROW = { width: 375, height: 812 };

async function shot(page, name, clip) {
  await mkdir(OUT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(OUT_DIR, name), clip });
  console.log(`wrote ${name}`);
}

async function api(pathname, options = {}) {
  const res = await fetch(`${BACKEND_URL}${pathname}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    throw new Error(`${options.method ?? "GET"} ${pathname} -> ${res.status} ${await res.text()}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : undefined;
}

async function git(cwd, ...args) {
  await execFileAsync("git", args, { cwd });
}

async function seedGitRepo(dir, { readme, files, commitMessages }) {
  await mkdir(dir, { recursive: true });
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "config", "user.email", "demo@example.com");
  await git(dir, "config", "user.name", "Demo");
  await writeFile(path.join(dir, "README.md"), readme);
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", commitMessages[0]);
  for (const [relPath, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, relPath)), { recursive: true });
    await writeFile(path.join(dir, relPath), content);
  }
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", commitMessages[1]);
  // Leave one tracked file modified and one new file untracked, so the Git
  // panel's Changes section has real content instead of "Working tree
  // clean".
  const [firstFile] = Object.keys(files);
  await writeFile(path.join(dir, firstFile), files[firstFile] + "\nconsole.log('debug');\n");
  await writeFile(path.join(dir, "src", "scratch.ts"), "// TODO: wire up the API client\n");
}

// A plausible-looking agent transcript, entirely synthetic — printed with
// small delays so it looks live rather than dumped instantly. `startDelay`
// (seconds) is critical for the mobile shot: dtach starts this script
// running the instant the session is created, before any client has
// attached — a client's terminal-fit resize only affects output printed
// *after* it lands, xterm doesn't reflow already-printed scrollback. A
// long enough pre-print pause lets the mobile client attach and resize the
// PTY before any of these lines exist, so what's on screen isn't clipped
// mid-word to a stale (desktop-sized) column count.
// Single-quoted, not JSON.stringify'd (double-quoted): several transcript
// lines below contain literal `$`/backtick characters (e.g. template-literal
// snippets in the fake diffs), and bash still expands `$…`/`` ` `` inside
// double quotes — a JSON-stringified `echo "..."` line reads those as real
// parameter expansions ("bad substitution") instead of printing them
// verbatim. Single quotes disable all of that; only a literal `'` needs
// escaping, via the standard close-quote/escaped-quote/reopen-quote trick.
function shellSingleQuote(s) {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

function agentTranscriptScript({ startDelay, lines }) {
  const body = lines
    .map((l) => (l === "" ? "echo" : `echo ${shellSingleQuote(l)}`))
    .join("\nsleep 0.25\n");
  return `#!/usr/bin/env bash\nset -u\nclear\nsleep ${startDelay}\n${body}\nsleep 100000 &\nwait\n`;
}

const AUTH_TRANSCRIPT = [
  "Claude Code v2.1.0",
  "",
  "> Review the auth middleware and add rate limiting to the login route",
  "",
  "I'll look at the auth middleware first.",
  "",
  "  Read src/middleware/auth.ts",
  "  Read src/routes/login.ts",
  "",
  "Found it — the login route has no rate limiting. Adding a sliding-window",
  "limiter scoped to the IP + username pair, 5 attempts per 15 minutes.",
  "",
  "  Edit src/middleware/rate-limit.ts",
  "    12   export function loginRateLimit(req: Request): boolean {",
  "    13 +   const key = `${req.ip}:${req.body.username}`;",
  "    14 +   return slidingWindow.check(key, 5, 15 * 60_000);",
  "    15   }",
  "",
  "  Edit src/routes/login.ts",
  '     8   router.post("/login", async (req, res) => {',
  "     9 +   if (!loginRateLimit(req)) {",
  '    10 +     return res.status(429).json({ error: "too many attempts" });',
  "    11 +   }",
  "    12     const user = await authenticate(req.body);",
  "",
  "Running the auth test suite...",
  "  ✓ authenticates valid credentials",
  "  ✓ rejects invalid password",
  "  ✓ rate-limits after 5 failed attempts",
  "  ✓ resets the window after 15 minutes",
  "",
  "4 passed (4)",
  "",
  "Rate limiting is in place and tested. Want me to open a PR?",
  "",
];

// Deliberately short lines (well under the ~20-25 visible columns a 375px
// phone screen fits) — unlike the two transcripts above, which are fine at
// desktop width. Long lines here would run off-screen regardless of
// whether the terminal's own reflow is working correctly for a
// freshly-attached mobile client, and this script has no reliable way to
// assert that from the outside; keeping every line short sidesteps the
// question entirely rather than risking a misleading screenshot.
const MOBILE_TRANSCRIPT = [
  "Claude Code v2.1.0",
  "",
  "> fix the flaky login test",
  "",
  "Looking at the test file.",
  "",
  "  Read auth.test.ts",
  "",
  "Found it — a race on the",
  "mock clock. Awaiting the",
  "timer flush now.",
  "",
  "  Edit auth.test.ts",
  "    12 + await flush();",
  "",
  "Running the suite...",
  "  ✓ 12 passed",
  "",
  "Fixed and green. Want a",
  "PR opened?",
  "",
];

const ORDERS_TRANSCRIPT = [
  "Codex CLI",
  "",
  "> Add an index on orders.customer_id, queries are slow",
  "",
  "Checking the current schema...",
  "  Read db/schema.sql",
  "",
  "  Edit db/migrations/0012_add_customer_id_index.sql",
  "     1 + CREATE INDEX idx_orders_customer_id ON orders (customer_id);",
  "",
  "Migration written. Running it against the dev database...",
  "Applying migration 0012_add_customer_id_index... done (38ms)",
  "",
];

async function main() {
  // Deliberately left on disk after this script exits, not cleaned up here:
  // the sessions it seeds keep running (dtach, independent of this process)
  // and reference these script files by path for as long as they're alive —
  // deleting out from under a running session's command is asking for
  // trouble. Falls to the OS's own tmp reaper, same as every other stray
  // file under os.tmpdir().
  const scratchRoot = await mkdtemp(path.join(tmpdir(), "mullion-screenshots-"));
  const scriptsDir = path.join(scratchRoot, "scripts");
  await mkdir(scriptsDir, { recursive: true });

  // --- Seed data ---------------------------------------------------------
  await seedGitRepo(path.join(scratchRoot, "aurora-web"), {
    readme: "# Aurora Web\n\nA demo project used only to generate PWA install screenshots.\n",
    files: { "src/index.ts": 'export function hello() {\n  return "hello";\n}\n' },
    commitMessages: ["Initial commit", "Add version export"],
  });
  await seedGitRepo(path.join(scratchRoot, "orbit-api"), {
    readme: "# Orbit API\n\nA demo project used only to generate PWA install screenshots.\n",
    files: { "src/index.ts": 'export const version = "1.0.0";\n' },
    commitMessages: ["Initial commit", "Bump version"],
  });
  // A third repo, deliberately never registered as a project below — the
  // sidebar's project-discovery panel (Sidebar.tsx's "Configure search
  // roots" empty state) needs at least one genuinely undiscovered
  // candidate under projectRoots to show real "add this project" content
  // instead of an empty/unconfigured state.
  await seedGitRepo(path.join(scratchRoot, "beacon-cli"), {
    readme: "# Beacon CLI\n\nA demo project used only to generate PWA install screenshots.\n",
    files: { "src/index.ts": 'export const name = "beacon";\n' },
    commitMessages: ["Initial commit", "Add CLI entrypoint"],
  });

  await api("/api/settings", {
    method: "PATCH",
    body: JSON.stringify({ projectRoots: [scratchRoot] }),
  });

  const auroraProject = await api("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: "aurora-web", cwd: path.join(scratchRoot, "aurora-web") }),
  });
  const orbitProject = await api("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: "orbit-api", cwd: path.join(scratchRoot, "orbit-api") }),
  });

  const authScriptPath = path.join(scriptsDir, "fake-agent.sh");
  const ordersScriptPath = path.join(scriptsDir, "fake-agent2.sh");
  await writeFile(
    authScriptPath,
    agentTranscriptScript({ startDelay: 0, lines: AUTH_TRANSCRIPT }),
    { mode: 0o755 },
  );
  await writeFile(
    ordersScriptPath,
    agentTranscriptScript({ startDelay: 0, lines: ORDERS_TRANSCRIPT }),
    { mode: 0o755 },
  );
  await api("/api/sessions", {
    method: "POST",
    body: JSON.stringify({
      projectId: auroraProject.id,
      command: authScriptPath,
      name: "Add login rate limiting",
    }),
  });
  await api("/api/sessions", {
    method: "POST",
    body: JSON.stringify({
      projectId: orbitProject.id,
      command: ordersScriptPath,
      name: "Speed up orders query",
    }),
  });

  // Task Master board — deliberately backlog/ready only. Every other
  // status (claimed/in_progress/reviewing/done) is a real lifecycle
  // transition that spins up an actual worker session/worktree; faking
  // that state without the automation behind it would mean this script
  // either runs a real agent CLI (slow, needs credentials, not
  // reproducible in CI) or writes the database directly (silently false
  // to what "regenerate with this script" promises). Staying inside the
  // plain creatable set keeps the whole board honestly reproducible from
  // this file alone, at the cost of a less visually varied column spread.
  const backlogTasks = [
    "Add dark mode toggle to Settings",
    "Fix flaky session-reconciler test",
    "Document the webhook retry policy",
    "Migrate PR badge polling to WS push",
    "Investigate slow cold-start on Preview panel",
    "Add keyboard shortcut for Command Palette history",
  ];
  for (const title of backlogTasks) {
    await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({ projectId: auroraProject.id, title, status: "backlog" }),
    });
  }
  const readyTasks = [
    "Speed up orders query with an index",
    "Add rate limiting to the login route",
  ];
  for (const title of readyTasks) {
    await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({ projectId: orbitProject.id, title, status: "ready" }),
    });
  }

  const browser = await chromium.launch();
  try {
    // --- Desktop shots (wide) ---------------------------------------------
    const desktop = await browser.newContext({ viewport: WIDE, deviceScaleFactor: 1 });
    const page = await desktop.newPage();
    await page.goto(FRONTEND_URL, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    // 1. Tiled dashboard — a live terminal session docked, sidebar
    //    populated with multiple projects/sessions and a real, undiscovered
    //    project suggestion.
    await page.locator(".session-item", { hasText: "fake-agent.sh" }).first().click();
    await page.waitForTimeout(2000);
    await shot(page, "desktop-dashboard.png");

    // 2. Git panel — opened via the sidebar's Source Control section.
    //    Floats as a "peek" over the terminal (see
    //    openSessionPanel/hasTiledPanels in panelUtils.ts — any panel
    //    opened once something's already tiled floats by design), which
    //    is itself a real, demonstrable feature rather than a capture
    //    artifact.
    await page.getByText("SOURCE CONTROL").click();
    await page.waitForTimeout(500);
    await page.getByText("Open Git Panel").click();
    await page.waitForTimeout(1000);
    await shot(page, "desktop-git-panel.png");
    // Close the floating peek explicitly — it's a real dockview panel, not
    // a modal, so Escape doesn't dismiss it. Non-terminal panels use
    // dockview's own default tab (no custom tabComponent, see registry.tsx's
    // `tabComponents`), so the close control is dockview's built-in
    // `.dv-default-tab-action`, not PaneHeaderActions' own split buttons.
    await page.locator(".dv-groupview-floating .dv-default-tab-action").click();
    await page.waitForTimeout(300);

    // 3. Kanban task board.
    await page.getByText("Tasks", { exact: true }).click();
    await page.waitForTimeout(1000);
    await shot(page, "desktop-kanban.png");

    // Back to the dockview workspace so the mobile shots below don't
    // inherit the kanban view.
    await page.locator(".workspace-item-name", { hasText: "Default" }).first().click();
    await page.waitForTimeout(500);
    await desktop.close();

    // --- Mobile shots (narrow) ---------------------------------------------
    // A dedicated session, its script gated behind a startDelay (see
    // agentTranscriptScript's own comment) so nothing prints before the
    // mobile client attaches and resizes the PTY to the phone's column
    // count — unlike the desktop sessions above, whose scrollback is
    // fine staying desktop-width since only desktop shots use them.
    const mobileScriptPath = path.join(scriptsDir, "mobile-demo.sh");
    await writeFile(
      mobileScriptPath,
      agentTranscriptScript({ startDelay: 1, lines: MOBILE_TRANSCRIPT }),
      { mode: 0o755 },
    );
    const mobileSession = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        projectId: auroraProject.id,
        command: mobileScriptPath,
        name: "mobile demo",
      }),
    });
    console.log(`created mobile session ${mobileSession.id}`);

    const mobile = await browser.newContext({
      viewport: NARROW,
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    const mpage = await mobile.newPage();
    await mpage.goto(FRONTEND_URL, { waitUntil: "networkidle" });
    await mpage.waitForTimeout(1200);

    // 4. Mobile session list — open the drawer.
    await mpage.locator('[class*="toolbar"] button').first().click();
    await mpage.waitForTimeout(800);
    await shot(mpage, "mobile-session-list.png");

    // 5. Mobile terminal with the key bar — pick the mobile-only session
    //    from the drawer. By the time this click lands, the session's
    //    3-second startDelay has had the whole page-load-plus-drawer-open
    //    sequence above to elapse, so its own WS attach/resize is already
    //    long done before the transcript starts printing.
    await mpage.locator(".session-item", { hasText: "mobile-demo.sh" }).first().click();
    await mpage.waitForTimeout(5000);
    await shot(mpage, "mobile-terminal.png");

    await mobile.close();
  } finally {
    await browser.close();
  }
}

await main();
