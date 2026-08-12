#!/usr/bin/env node
// Captures the PWA install-dialogue screenshots referenced from
// frontend/public/site.webmanifest's `screenshots` array.
//
// Prerequisites (not run by this script — see the header of the PR this
// shipped in, or docs/architecture.md, for why a scratch instance is
// required rather than pointing this at a real deployment):
//   1. A throwaway dev backend + frontend, isolated from any real install
//      (own DATABASE_URL/SESSIONS_DIR/PORT, MULLION_* scrubbed from the
//      spawning shell's env — see CLAUDE.md's "Dev server can hijack the
//      production control socket" note). This script assumes the frontend
//      is reachable at FRONTEND_URL (default http://127.0.0.1:5174) and
//      talks to a backend that already has a couple of demo projects,
//      sessions, and tasks seeded through the normal REST API — entirely
//      synthetic, no real project data.
//   2. Chromium already installed for Playwright (`npx playwright install
//      chromium` — already present in this repo's local browser cache as
//      of authoring).
//
// Regenerate with: FRONTEND_URL=http://127.0.0.1:5174 node scripts/capture-screenshots.mjs
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

async function main() {
  const browser = await chromium.launch();

  // --- Desktop shots (wide) --------------------------------------------
  const desktop = await browser.newContext({ viewport: WIDE, deviceScaleFactor: 1 });
  const page = await desktop.newPage();
  await page.goto(FRONTEND_URL, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);

  // 1. Tiled dashboard — a live terminal session docked, sidebar populated
  //    with multiple projects/sessions.
  await page.locator(".session-item", { hasText: "fake-agent.sh" }).first().click();
  await page.waitForTimeout(2000);
  await shot(page, "desktop-dashboard.png");

  // 2. Git panel — opened via the sidebar's Source Control section. Floats
  //    as a "peek" over the terminal (see openSessionPanel/hasTiledPanels
  //    in panelUtils.ts — any panel opened once something's already tiled
  //    floats by design), which is itself a real, demonstrable feature
  //    rather than a capture artifact.
  await page.getByText("SOURCE CONTROL").click();
  await page.waitForTimeout(500);
  await page.getByText("Open Git Panel").click();
  await page.waitForTimeout(1000);
  await shot(page, "desktop-git-panel.png");
  // Close the floating peek explicitly — it's a real dockview panel, not a
  // modal, so Escape doesn't dismiss it. Non-terminal panels use dockview's
  // own default tab (no custom tabComponent, see registry.tsx's
  // `tabComponents`), so the close control is dockview's built-in
  // `.dv-default-tab-action`, not PaneHeaderActions' own split buttons.
  await page.locator(".dv-groupview-floating .dv-default-tab-action").click();
  await page.waitForTimeout(300);

  // 3. Kanban task board.
  await page.getByText("Tasks", { exact: true }).click();
  await page.waitForTimeout(1000);
  await shot(page, "desktop-kanban.png");

  // Back to the dockview workspace so the mobile shots below don't inherit
  // the kanban view.
  await page.locator(".workspace-item-name", { hasText: "Default" }).first().click();
  await page.waitForTimeout(500);
  await desktop.close();

  // --- Mobile shots (narrow) --------------------------------------------
  // The mobile terminal shot below needs a session whose PTY has never been
  // sized for anything wider than the phone viewport — see that shot's own
  // comment. Launched here (right before it's attached) rather than
  // pre-seeded earlier so as little as possible prints before the mobile
  // client's own resize takes effect.
  const mobileSession = await fetch(`${BACKEND_URL}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId: 1,
      command: "/tmp/mullion-mock-repos/mobile-demo.sh",
      name: "mobile demo",
    }),
  }).then((r) => r.json());
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

  // 5. Mobile terminal with the key bar — pick a session from the drawer.
  // Deliberately a *separate* session from the desktop shots above (rather
  // than reusing "fake-agent.sh"): a terminal's scrollback is plain
  // characters at whatever column width was live when they were printed —
  // xterm doesn't reflow it — so a session already printed at desktop
  // width shows clipped, mid-word lines once viewed at phone width. A
  // session opened fresh inside the mobile viewport gets its PTY sized to
  // match from the start.
  await mpage.locator(".session-item", { hasText: "mobile-demo.sh" }).first().click();
  await mpage.waitForTimeout(3500);
  await shot(mpage, "mobile-terminal.png");

  await mobile.close();
  await browser.close();
}

await main();
