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
import { lastChangeSeconds, loopEnd } from "./demo/freeze.mjs";
import { withDemo } from "./demo/with-demo.mjs";
import {
  AUTH_TRANSCRIPT,
  MOBILE_TRANSCRIPT,
  ORDERS_TRANSCRIPT,
  agentTranscriptScript,
  lastTranscriptLine,
} from "./demo/seed.mjs";

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
    // 375 CSS px is under mobile.css's 699.98px breakpoint, so the mobile
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
 * When the video at `src` last changed, in seconds, or null if it never
 * settles (see lastChangeSeconds). The loop is cut from this rather than from
 * when the backend's scrollback reports the last line, which on a loaded host
 * trails the page by many seconds.
 */
function videoLastChange(src) {
  const res = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-i",
      src,
      "-vf",
      "freezedetect=n=-60dB:d=1",
      "-map",
      "0:v",
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8" },
  );
  if (res.error || res.status !== 0) throw new Error(`ffmpeg freezedetect on ${src} failed`);
  return lastChangeSeconds(res.stderr);
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

/** Aborts when withDemo is interrupted or tearing down (set in main). */
let captureSignal;

/**
 * Polls until `check` returns a truthy value or `timeoutMs` elapses. Every
 * shot below waits on a real condition rather than a fixed sleep alone: on a
 * loaded host a fixed sleep lands mid-render (a half-printed transcript, a
 * panel still loading), which is exactly what the stills must never show.
 */
async function waitUntil(check, what, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // Interrupted or torn down: stop polling a closed browser until the deadline.
    captureSignal?.throwIfAborted();
    // A transient API error on a loaded host is "not yet", not a failure.
    const value = await check().catch(() => false);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Waits until the session running `scriptName` has printed its whole
 * transcript (its last line is in the backend's scrollback). The seeded
 * agents start printing the moment the demo boots, so without this the
 * dashboard and git-panel shots catch them at whatever point the host's load
 * allows, sometimes still scrolling.
 */
async function findSession(demo, scriptName) {
  const sessions = await demo.api("/api/sessions");
  return sessions.find((s) => s.command?.endsWith(`/${scriptName}`));
}

async function waitForTranscript(demo, scriptName, lines) {
  const last = lastTranscriptLine(lines);
  await waitUntil(async () => {
    const session = await findSession(demo, scriptName);
    if (!session) return false;
    const { b64 } = await demo.api(`/api/sessions/${session.id}/scrollback`);
    return Buffer.from(b64, "base64").toString("utf8").includes(last);
  }, `${scriptName} to finish its transcript`);
}

/**
 * Waits until the browser's terminal is attached to `scriptName`'s session (a
 * live subscriber on its PTY, no "Connecting…" overlay) and its geometry has
 * held still for SETTLE_MS: web fonts loaded and the `.xterm-screen` box (cell
 * size × cols/rows) unchanged. The PTY's own size isn't in the sessions API,
 * so the fitted terminal in the page is what's measured. Output printed before
 * then lands at an interim geometry (a pre-fit row count or font size) and the
 * shot shows it scrolled or clipped.
 *
 * The page has no per-session marker on a terminal pane, so the gate requires
 * exactly one mounted terminal (every shot that uses it shows one) and fails
 * on more, rather than measuring a pane other than the attached one. It fails
 * only once extra terminals have stayed mounted for EXTRA_TERMINAL_GRACE_MS,
 * so a pane remounting during a slow layout change doesn't abort the run.
 * A box that hasn't been laid out yet (0×0) doesn't count as settled.
 */
const SETTLE_MS = 1500;
const EXTRA_TERMINAL_GRACE_MS = 5000;
async function waitForSettledTerminal(page, demo, scriptName) {
  let last = null;
  let since = 0;
  let terminals = 0;
  let extraSince = null;
  let extraPersisted = false;
  await waitUntil(async () => {
    const session = await findSession(demo, scriptName);
    const measured = await page.evaluate(() => {
      // Runs in the page; this file's lint env is Node, hence globalThis.
      const doc = globalThis.document;
      const screens = doc.querySelectorAll(".xterm-screen");
      if (screens.length !== 1) return { terminals: screens.length, geometry: null };
      const [screen] = screens;
      const ready =
        !doc.querySelector(".terminal-status-overlay") &&
        doc.fonts.status === "loaded" &&
        screen.offsetWidth > 0 &&
        screen.offsetHeight > 0;
      const geometry = ready ? `${screen.offsetWidth}x${screen.offsetHeight}` : null;
      return { terminals: 1, geometry };
    });
    terminals = measured.terminals;
    if (terminals > 1) {
      extraSince ??= Date.now();
      last = null;
      // Ends the wait so the throw below fails loudly. Throwing here instead
      // would be swallowed by waitUntil's catch into a slow, misleading timeout.
      extraPersisted = Date.now() - extraSince >= EXTRA_TERMINAL_GRACE_MS;
      return extraPersisted;
    }
    extraSince = null;
    const { geometry } = measured;
    if (!(session?.subscriberCount > 0) || geometry === null) {
      last = null;
      return false;
    }
    if (geometry !== last) {
      last = geometry;
      since = Date.now();
      return false;
    }
    return Date.now() - since >= SETTLE_MS;
  }, `the terminal attached to ${scriptName} to settle`);
  if (extraPersisted) {
    throw new Error(
      `expected one mounted terminal while waiting for ${scriptName}, found ${terminals}`,
    );
  }
}

/**
 * The contract both terminal shots share: the session (already opened in the
 * page) holds its transcript until its terminal has settled, is released
 * through `releaseFile`, and the shot waits for the whole transcript.
 */
async function releaseIntoSettledTerminal(page, demo, scriptName, lines, releaseFile) {
  await waitForSettledTerminal(page, demo, scriptName);
  await writeFile(releaseFile, "");
  await waitForTranscript(demo, scriptName, lines);
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
  // fake-agent2.sh isn't opened in any shot, only listed; let it finish so
  // its row is in its final state.
  await waitForTranscript(demo, "fake-agent2.sh", ORDERS_TRANSCRIPT);
  const context = await newContext(browser, profile.desktop);
  const page = await context.newPage();
  await page.goto(demo.frontendUrl, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  await collapseDock(page);

  // 1. Tiled dashboard: a live terminal session docked, sidebar populated with
  //    multiple projects/sessions and a real, undiscovered project suggestion.
  // The seeded agent holds its transcript (startDemo's holdTranscripts) until
  // the session is open here and its terminal sized, then prints it into the
  // live terminal; the shot waits for the whole transcript.
  await page.locator(".session-item", { hasText: "fake-agent.sh" }).first().click();
  await releaseIntoSettledTerminal(
    page,
    demo,
    "fake-agent.sh",
    AUTH_TRANSCRIPT,
    demo.seeded.authReleaseFile,
  );
  await page.waitForTimeout(1000);
  await shot(page, "desktop-dashboard.png");

  // 2. Git panel, from the right-hand rail; toggled closed again afterwards so
  //    it doesn't sit over the sidebar for the next shot.
  await page.getByRole("button", { name: "Git", exact: true }).click();
  await page.getByText("Initial commit").first().waitFor();
  await page.waitForTimeout(500);
  await shot(page, "desktop-git-panel.png");
  await page.getByRole("button", { name: "Git", exact: true }).click();
  await page.waitForTimeout(500);

  // 3. Kanban task board.
  await page.getByText("Tasks", { exact: true }).click();
  await page.getByText("Add rate limiting to the login route").first().waitFor();
  await page.waitForTimeout(500);
  await shot(page, "desktop-kanban.png");

  await context.close();
}

async function captureMobile(browser, demo) {
  // A dedicated session that holds its transcript until the mobile client
  // has attached and fitted its terminal (see agentTranscriptScript).
  const { scriptsDir, auroraProject } = demo.seeded;
  const mobileScriptPath = path.join(scriptsDir, "mobile-demo.sh");
  const mobileReleaseFile = path.join(scriptsDir, "mobile-demo.release");
  await writeFile(
    mobileScriptPath,
    agentTranscriptScript({
      lines: MOBILE_TRANSCRIPT,
      releaseFile: mobileReleaseFile,
    }),
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

  // 5. Mobile terminal with the key bar, released through the same settled
  //    gate as the dashboard so the transcript prints at the fitted width.
  await page.locator(".session-item", { hasText: "mobile-demo.sh" }).first().click();
  await releaseIntoSettledTerminal(
    page,
    demo,
    "mobile-demo.sh",
    MOBILE_TRANSCRIPT,
    mobileReleaseFile,
  );
  await page.waitForTimeout(1000);
  await shot(page, "mobile-terminal.png");
  await context.close();
}

const LOOP_LEAD_MS = 1000;
// A beat on the finished transcript before the loop restarts.
const LOOP_TAIL_S = 1.5;

/** An agent session streaming into the terminal, recorded from session start. */
async function recordLoop(browser, demo) {
  if (spawnSync("ffmpeg", ["-version"]).status !== 0) {
    console.warn("ffmpeg not found; skipping the landing loop");
    return;
  }
  const { scriptsDir, auroraProject } = demo.seeded;
  const scriptPath = path.join(scriptsDir, "loop-demo.sh");
  const releaseFile = path.join(scriptsDir, "loop-demo.release");
  // Held until the session is open and its terminal settled, like the stills.
  await writeFile(scriptPath, agentTranscriptScript({ lines: AUTH_TRANSCRIPT, releaseFile }), {
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
  await waitForSettledTerminal(page, demo, "loop-demo.sh");
  // The trimmed loop starts here, on the settled empty terminal, LOOP_LEAD_MS
  // before the release; the transcript can't print before then whatever the
  // host's load, so the trim never cuts into it.
  const offset = (Date.now() - recordingStarted) / 1000;
  await page.waitForTimeout(LOOP_LEAD_MS);
  await writeFile(releaseFile, "");
  // The recording must hold the whole transcript plus its tail; the encode
  // below cuts the end back to the last on-screen change + LOOP_TAIL_S.
  await waitForTranscript(demo, "loop-demo.sh", AUTH_TRANSCRIPT);
  await page.waitForTimeout(LOOP_TAIL_S * 1000);
  await context.close();

  const [raw] = await readdir(videoDir);
  const src = path.join(videoDir, raw);
  const base = path.join(profile.outDir, "terminal-stream");
  // End LOOP_TAIL_S after the transcript's last line landed on screen.
  const end = loopEnd(videoLastChange(src), offset, LOOP_TAIL_S);
  const input = ["-ss", offset.toFixed(2), ...end, "-i", src, "-an"];
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
  // withDemo stops the demo on every exit path, including a failed browser
  // launch and Ctrl-C, which would otherwise leave its servers and session
  // scopes running on the demo ports.
  await withDemo({
    startDemo: () => startDemo({ quiet: true, keep: values.keep, holdTranscripts: true }),
    launchBrowser: () => chromium.launch(),
    run: async (browser, demo, signal) => {
      captureSignal = signal;
      await captureDesktop(browser, demo);
      await captureMobile(browser, demo);
      if (profile.loop) await recordLoop(browser, demo);
      console.log(`[screenshots] done: ${profile.outDir}`);
    },
  });
}

main().catch((err) => {
  console.error("[screenshots] failed:", err);
  // The demo is already down (withDemo awaits its teardown before rejecting);
  // exit now rather than wait on whatever capture step was abandoned.
  process.exit(1);
});
