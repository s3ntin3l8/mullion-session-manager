#!/usr/bin/env node
// Reproducible screenshot pipeline. Boots an isolated throwaway Mullion
// (scripts/demo/instance.mjs: scratch DB/SESSIONS_DIR/HOME, clean env, its own
// loopback ports, enforced by scripts/demo/env.mjs), seeds it with the demo
// dataset (scripts/demo/seed.mjs), captures, and tears it all down, including
// the demo's session scopes.
//
//   make screenshots                       # README + PWA manifest set
//   make screenshots-landing OUT=<dir>     # landing-page stills + terminal loop
//
// Profiles:
//   readme  (default) frontend/public/screenshots/*, referenced by README.md
//           and frontend/public/site.webmanifest (sizes must stay in sync).
//   landing Dark 2x desktop and 3x mobile stills plus a short loop of an agent
//           session streaming into the terminal (webm + mp4 + jpg poster;
//           needs ffmpeg), written to --out.
//
// Requires Playwright's Chromium once: `npx playwright install chromium`.
import { chromium } from "playwright";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { startDemo } from "./demo/instance.mjs";
import { AUTH_TRANSCRIPT, MOBILE_TRANSCRIPT, agentTranscriptScript } from "./demo/seed.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const README_DIR = path.join(__dirname, "..", "frontend", "public", "screenshots");

const { values } = parseArgs({
  options: {
    profile: { type: "string", default: "readme" },
    out: { type: "string" },
    keep: { type: "boolean", default: false },
  },
});
if (!["readme", "landing"].includes(values.profile))
  throw new Error(`unknown --profile "${values.profile}" (readme | landing)`);
if (values.profile === "landing" && !values.out)
  throw new Error("--profile landing needs --out <dir>");

const PROFILES = {
  // The manifest declares these exact sizes; change both together.
  readme: {
    outDir: README_DIR,
    desktop: { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 },
    // 375 CSS px is under styles.css's 699px mobile breakpoint, so the mobile
    // layout (drawer sidebar, maximized single group, MobileKeyBar) actually
    // renders. deviceScaleFactor 2 gives the manifest's 750-wide `narrow` files.
    mobile: { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 },
    loop: false,
  },
  // Shared landing-page spec: 1600x1000 @2x desktop, 390x844 @3x phone, dark.
  landing: {
    outDir: values.out && path.resolve(values.out),
    desktop: { viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 },
    mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 },
    loop: true,
  },
};
const profile = PROFILES[values.profile];

async function shot(page, name) {
  await mkdir(profile.outDir, { recursive: true });
  // Write-then-rename so an interrupted run never leaves a half-written file.
  const tmp = path.join(profile.outDir, `.${name}`);
  await page.screenshot({ path: tmp });
  await rename(tmp, path.join(profile.outDir, name));
  console.log(`wrote ${name}`);
}

function ffmpeg(args) {
  const res = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { stdio: "inherit" });
  if (res.error || res.status !== 0) throw new Error(`ffmpeg ${args.join(" ")} failed`);
}

/**
 * The host's real disk usage can trip Mullion's low-disk banner, which would
 * then show in every shot; dismiss it the way a user would (the banner's own
 * localStorage key, see frontend/src/ResourceAlertBanner.tsx).
 */
async function newContext(browser, options) {
  const context = await browser.newContext({ colorScheme: "dark", ...options });
  await context.addInitScript(() =>
    globalThis.localStorage.setItem("mullion:storage-warning-dismissed-at", String(Date.now())),
  );
  return context;
}

/** The demo has no dock monitors, so give its empty panel's space to the terminal. */
async function collapseDock(page) {
  const collapse = page.getByRole("button", { name: "Collapse dock" });
  if (await collapse.isVisible()) {
    await collapse.click();
    await page.waitForTimeout(400);
  }
}

async function captureDesktop(browser, demo) {
  const context = await newContext(browser, profile.desktop);
  const page = await context.newPage();
  await page.goto(demo.frontendUrl, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  await collapseDock(page);

  // 1. Tiled dashboard: a live terminal session docked, sidebar populated with
  //    multiple projects/sessions and a real, undiscovered project suggestion.
  await page.locator(".session-item", { hasText: "fake-agent.sh" }).first().click();
  await page.waitForTimeout(2000);
  await shot(page, "desktop-dashboard.png");

  // 2. Git panel, from the right-hand rail; toggled closed again afterwards so
  //    it doesn't sit over the sidebar for the next shot.
  await page.getByRole("button", { name: "Git", exact: true }).click();
  await page.waitForTimeout(1200);
  await shot(page, "desktop-git-panel.png");
  await page.getByRole("button", { name: "Git", exact: true }).click();
  await page.waitForTimeout(500);

  // 3. Kanban task board.
  await page.getByText("Tasks", { exact: true }).click();
  await page.waitForTimeout(1000);
  await shot(page, "desktop-kanban.png");

  // Back to the dockview workspace so later shots don't inherit the kanban view.
  await context.close();
}

async function captureMobile(browser, demo) {
  // A dedicated session, gated behind a startDelay (see agentTranscriptScript)
  // so nothing prints before the mobile client attaches and resizes the PTY.
  const { scriptsDir, auroraProject } = demo.seeded;
  const mobileScriptPath = path.join(scriptsDir, "mobile-demo.sh");
  await writeFile(
    mobileScriptPath,
    agentTranscriptScript({ startDelay: 1, lines: MOBILE_TRANSCRIPT }),
    {
      mode: 0o755,
    },
  );
  await demo.api("/api/sessions", {
    method: "POST",
    body: JSON.stringify({
      projectId: auroraProject.id,
      command: mobileScriptPath,
      name: "mobile demo",
    }),
  });

  const context = await newContext(browser, { ...profile.mobile, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.goto(demo.frontendUrl, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);

  // 4. Mobile session list: open the drawer.
  await page.locator('[class*="toolbar"] button').first().click();
  await page.waitForTimeout(800);
  await shot(page, "mobile-session-list.png");

  // 5. Mobile terminal with the key bar. The session's startDelay has elapsed
  //    during page load and drawer opening, so its attach/resize is done
  //    before the transcript starts printing.
  await page.locator(".session-item", { hasText: "mobile-demo.sh" }).first().click();
  await page.waitForTimeout(5000);
  await shot(page, "mobile-terminal.png");
  await context.close();
}

/** An agent session streaming into the terminal, recorded from session start. */
async function recordLoop(browser, demo) {
  if (spawnSync("ffmpeg", ["-version"]).status !== 0) {
    console.warn("ffmpeg not found; skipping the landing loop");
    return;
  }
  const { scriptsDir, auroraProject } = demo.seeded;
  const scriptPath = path.join(scriptsDir, "loop-demo.sh");
  // startDelay leaves time to open the session before the first line prints.
  await writeFile(scriptPath, agentTranscriptScript({ startDelay: 3, lines: AUTH_TRANSCRIPT }), {
    mode: 0o755,
  });

  // Playwright records in viewport (CSS) pixels regardless of deviceScaleFactor,
  // so the loop is 1x while the stills are 2x; fine for a muted loop.
  const size = profile.desktop.viewport;
  const videoDir = await mkdtemp(path.join(tmpdir(), "mullion-loop-"));
  const context = await newContext(browser, {
    viewport: size,
    recordVideo: { dir: videoDir, size },
  });
  // Recording starts with the context; everything before `offset` (page load,
  // opening the session) is trimmed off below.
  const recordingStarted = Date.now();
  const page = await context.newPage();
  await page.goto(demo.frontendUrl, { waitUntil: "networkidle" });
  await collapseDock(page);
  await demo.api("/api/sessions", {
    method: "POST",
    body: JSON.stringify({
      projectId: auroraProject.id,
      command: scriptPath,
      name: "Add login rate limiting",
    }),
  });
  await page.locator(".session-item", { hasText: "loop-demo.sh" }).first().click();
  await page.waitForTimeout(1500);
  // Taken once the session is open, still inside the script's startDelay, so
  // the trimmed loop begins on an empty terminal just before the first line.
  const offset = (Date.now() - recordingStarted) / 1000;
  // 35 transcript lines at 0.25 s each, plus a beat at the end.
  await page.waitForTimeout(3000 + AUTH_TRANSCRIPT.length * 250 + 1500);
  await context.close();

  const [raw] = await readdir(videoDir);
  const src = path.join(videoDir, raw);
  const base = path.join(profile.outDir, "terminal-stream");
  const input = ["-ss", offset.toFixed(2), "-i", src, "-an"];
  ffmpeg([
    ...input,
    "-c:v",
    "libvpx-vp9",
    "-crf",
    "36",
    "-b:v",
    "0",
    "-row-mt",
    "1",
    `${base}.webm`,
  ]);
  ffmpeg([
    ...input,
    "-c:v",
    "libx264",
    "-crf",
    "26",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    `${base}.mp4`,
  ]);
  // Poster: the finished transcript, so reduced-motion users see the result.
  ffmpeg(["-sseof", "-0.5", "-i", src, "-frames:v", "1", "-q:v", "3", `${base}.jpg`]);
  await rm(videoDir, { recursive: true, force: true });
  console.log("wrote terminal-stream.{webm,mp4,jpg}");
}

async function main() {
  const demo = await startDemo({ quiet: true, keep: values.keep });
  const browser = await chromium.launch();
  try {
    await captureDesktop(browser, demo);
    await captureMobile(browser, demo);
    if (profile.loop) await recordLoop(browser, demo);
    console.log(`[screenshots] done: ${profile.outDir}`);
  } finally {
    await browser.close();
    console.log("[screenshots] tearing down the demo...");
    await demo.stop();
  }
}

main().catch((err) => {
  console.error("[screenshots] failed:", err);
  process.exitCode = 1;
});
