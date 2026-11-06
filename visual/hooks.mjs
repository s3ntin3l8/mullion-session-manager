// visual-kit hooks for Mullion's demo (https://github.com/s3ntin3l8/visual-kit,
// CONTRACT.md "visual/scenes.json"). This runs inside the visual-kit image and
// reaches the demo over HTTP only; anything that has to happen on the host goes
// through host() -> visual/host-hooks.sh.
//
// The demo holds the scripted agent transcripts behind release files (see
// agentTranscriptScript) so a shot can show one printed into a terminal that is
// already attached and fitted. These hooks are that wait-then-release step,
// ported from the capture script this replaced.
import { checkTerminalGeometry, parseSttySize } from "../scripts/demo/geometry.mjs";
import { AUTH_TRANSCRIPT, MOBILE_TRANSCRIPT, transcriptEnd } from "../scripts/demo/seed.mjs";

// Scenes that show a held transcript in a terminal, by the script they open.
const HELD_SCRIPT = {
  dashboard: { script: "fake-agent", lines: AUTH_TRANSCRIPT },
  "git-panel": { script: "fake-agent", lines: AUTH_TRANSCRIPT },
  terminal: { script: "mobile-demo", lines: MOBILE_TRANSCRIPT },
  // Same terminal, rendered with normal motion (see scenes.json).
  "terminal-motion": { script: "mobile-demo", lines: MOBILE_TRANSCRIPT },
};

// The landing loop is set up and released in settle() instead: the loop recorder
// never runs settle() after its steps, and the loop-demo script pauses (leadMs)
// after its release so its first lines print after the recording started.
const LOOP_SCRIPT = { "terminal-stream": "loop-demo" };

// How long a terminal's geometry must hold still, and how long a stray second
// terminal may stay mounted before that is an error rather than a remount.
const SETTLE_MS = 1500;
const EXTRA_TERMINAL_GRACE_MS = 5000;

// The backend's GitHub poller answers 204 until its first pass (~20 s after the
// demo starts), and the Tasks and GitHub views read what it caches. Wait for it
// once, from the first scene's settle() (it needs a loaded page to resolve the
// URL against), instead of letting that scene's steps time out.
let warmed;
function warmUp(page) {
  warmed ??= (async () => {
    const api = (path) => page.request.get(new URL(path, page.url()).href);
    await waitUntil(async () => {
      const projects = await (await api("/api/projects")).json();
      for (const project of projects) {
        if ((await api(`/api/projects/${project.id}/github/prs`)).status() !== 200) return false;
      }
      return projects.length > 0;
    }, "the GitHub poller's first pass");
  })();
  return warmed;
}

export async function beforeScene({ context, cfg }) {
  const demoUrl = cfg.demo.url;
  // Writes land now, and the layout the last scene saved (an open pane, say) is
  // stored server-side, so every scene after it would start from that instead of
  // a fresh workspace. Deleting the workspaces and reading the list back
  // re-seeds the one default row with no layout, which is what a first load
  // looks like. Session state is not reset: opening a session in `dashboard`
  // clears its attention, so the bell's count differs between a lone run and a
  // full one. The scenes that follow `dashboard` and are baselines hide the
  // bell's count badge and the phone picker's unread pill (`emphasis.css` in
  // scenes.json) instead. `session-list` and `terminal` still show live state
  // (the Working/Idle chips depend on which held sessions earlier scenes
  // released), so their baselines only match a full run, not a lone ROUTES run.
  const workspaces = await (await context.request.get(`${demoUrl}/api/workspaces`)).json();
  for (const workspace of workspaces) {
    await context.request.delete(`${demoUrl}/api/workspaces/${workspace.id}`);
  }
  await context.request.get(`${demoUrl}/api/workspaces`);
  // The low-disk banner would sit over every shot. The browser clock is frozen
  // by scenes.json `clock`, so Date.now() here is the same instant the app sees.
  await context.addInitScript(() => {
    globalThis.localStorage.setItem("mullion:storage-warning-dismissed-at", String(Date.now()));
  });
  await context.addInitScript(normalizeRunDependentText);
}

/**
 * Runs in the page. Two things the demo prints depend on the run, not on the
 * code, and would make every shot differ from the last: the scratch directory's
 * random name inside a session's script path, and the ages git computes on the
 * server ("82 seconds ago"; the frontend's own relative times follow the frozen
 * browser clock and are already stable). Both are rewritten to fixed text as the
 * page renders, which also reads better in a README than a mktemp name.
 */
function normalizeRunDependentText() {
  const rewrite = (text) =>
    text
      .replace(/\/tmp\/mullion-demo-[A-Za-z0-9]+\//g, "/tmp/mullion-demo/")
      .replace(/\b\d+ (?:second|minute|hour)s? ago\b/g, "2 minutes ago");
  const walk = (root) => {
    const walker = globalThis.document.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const next = rewrite(node.nodeValue ?? "");
      if (next !== node.nodeValue) node.nodeValue = next;
    }
  };
  const start = () => {
    walk(globalThis.document.body);
    new globalThis.MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "characterData") {
          const next = rewrite(record.target.nodeValue ?? "");
          if (next !== record.target.nodeValue) record.target.nodeValue = next;
        } else {
          for (const added of record.addedNodes) {
            if (added.nodeType === 3) {
              const next = rewrite(added.nodeValue ?? "");
              if (next !== added.nodeValue) added.nodeValue = next;
            } else walk(added);
          }
        }
      }
    }).observe(globalThis.document.body, { childList: true, characterData: true, subtree: true });
  };
  if (globalThis.document.body) start();
  else globalThis.addEventListener("DOMContentLoaded", start);
}

export async function settle({ page, scene, host }) {
  await warmUp(page);
  await projectsLoaded(page);
  const api = (path) => page.request.get(new URL(path, page.url()).href).then((r) => r.json());
  const sessionRunning = (script) => async () =>
    (await api("/api/sessions")).find((s) => s.command?.endsWith(`/${script}.sh`));

  const loop = LOOP_SCRIPT[scene.name];
  if (loop) {
    // The loop recorder runs no settle() after its steps and trims everything
    // before they start, so the setup lives here: open the session, let its
    // terminal settle, release the transcript. It prints leadMs later, inside
    // the recording, and the scene's wait steps keep recording until it is done.
    await page.addStyleTag({ content: ".discover-block { display: none !important; }" });
    await page.click('role=button[name="Add project"] >> nth=-1');
    await page.click('text="aurora-web" >> nth=-1');
    await page.click('role=button[name="Collapse dock"]');
    await page.click(`.session-item:has-text("${loop}.sh")`);
    await waitForSettledTerminal(page, sessionRunning(loop), loop);
    await host("release", loop);
    return;
  }
  const held = HELD_SCRIPT[scene.name];
  if (!held) return;
  // settle() also runs right after the page loads, before the scene's steps
  // open the session: only act once there is a terminal to settle.
  if ((await page.locator(".xterm-screen").count()) === 0) return;

  const find = sessionRunning(held.script);

  await waitForSettledTerminal(page, find, held.script);
  await host("release", held.script);
  // The last line and the blank lines after it: the script prints them 0.25 s apart, and a shot taken between
  // them has the cursor one row higher than one taken after (a 384 px difference on the README terminal shot).
  const { last, lineBreaks } = transcriptEnd(held.lines);
  const finished = new RegExp(
    `${last.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\r?\\n){${lineBreaks}}`,
  );
  await waitUntil(async () => {
    const session = await find();
    if (!session) return false;
    const { b64 } = await api(`/api/sessions/${session.id}/scrollback`);
    return finished.test(Buffer.from(b64, "base64").toString("utf8"));
  }, `${held.script} to finish its transcript`);
  // The scrollback being complete is the server's view. A terminal that replays it on attach (every variant after
  // the first) can still be drawing the last lines, so wait for the cursor to sit where the transcript leaves it.
  await waitUntil(
    () =>
      page.evaluate(
        ({ tail, breaks }) => {
          const rows = [...globalThis.document.querySelectorAll(".xterm-rows > div")];
          const cursor = rows.findIndex((r) => r.querySelector(".xterm-cursor"));
          if (cursor < 0) return true; // no cursor to read (another renderer): nothing to wait for
          const text = (r) => r.textContent.replaceAll("\u00a0", " ").trim();
          const lastText = rows.findLastIndex((r) => text(r) !== "");
          return (
            lastText >= 0 && text(rows[lastText]).includes(tail) && cursor - lastText === breaks
          );
        },
        { tail: last.slice(-6), breaks: lineBreaks },
      ),
    `the terminal to draw the end of ${held.script}'s transcript`,
  );

  const { terminal } = await api("/api/settings");
  const pty = parseSttySize(await host("size", held.script));
  await checkTerminalGeometry({
    name: scene.name,
    measure: () => measureTerminal(page),
    // xterm rescales its canvases when the device pixel ratio changes, not when
    // the window does: a replayed transcript (every variant after the first)
    // otherwise leaves the text layer drawn at 1x on a 2x display. Toggle the
    // ratio through the DevTools protocol, then put the emulation back.
    refit: async () => {
      const viewport = page.viewportSize();
      const { dpr, mobile } = await page.evaluate(() => ({
        dpr: globalThis.devicePixelRatio,
        mobile: globalThis.matchMedia("(pointer: coarse)").matches,
      }));
      const cdp = await page.context().newCDPSession(page);
      const emulate = (deviceScaleFactor) =>
        cdp.send("Emulation.setDeviceMetricsOverride", {
          width: viewport.width,
          height: viewport.height,
          deviceScaleFactor,
          mobile,
        });
      await emulate(1);
      await page.waitForTimeout(500);
      await emulate(dpr);
      await page.waitForTimeout(500);
      await cdp.detach();
      await waitForSettledTerminal(page, find, held.script);
    },
    pty,
    fontSize: terminal.fontSize,
    log: (line) => console.log(line),
  });
}

// visual-kit's own stylesheet (animations and transitions off), which it adds
// after navigation and which a reload drops.
const KIT_STYLE = `*, *::before, *::after { animation-delay: 0s !important; animation-duration: 0s !important; transition: none !important; caret-color: transparent !important; scroll-behavior: auto !important; }`;

/**
 * Waits for the sidebar's project list. The Dock's "Add project" stays disabled
 * and mobile's drawer lists no sessions until it has loaded, and on a loaded
 * host the first fetch can fail or come back late, which left a scene's first
 * click waiting out its whole timeout. A failed load gets a reload, up to
 * three times.
 */
async function projectsLoaded(page) {
  for (let attempt = 0; ; attempt++) {
    const ready = await page
      .waitForFunction(
        () => {
          const text = globalThis.document.body.textContent ?? "";
          return !text.includes("Loading projects") && !text.includes("Could not load projects");
        },
        null,
        { timeout: 20_000 },
      )
      .then(
        () => true,
        () => false,
      );
    if (ready) return;
    if (attempt >= 2) throw new Error("the project list did not load after 3 attempts");
    await page.reload({ waitUntil: "load" });
    await page.addStyleTag({ content: KIT_STYLE });
  }
}

/** Polls until `check` returns a truthy value; an API error on a loaded host is "not yet". */
async function waitUntil(check, what, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check().catch(() => false);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Waits until the page's terminal is attached to `script`'s session (a live
 * subscriber on its PTY, no "Connecting..." overlay) and its geometry has held
 * still for SETTLE_MS: fonts loaded and the `.xterm-screen` box unchanged.
 * Output printed before then lands at an interim geometry and shows scrolled or
 * clipped. Exactly one terminal must be mounted (the page has no per-session
 * marker); more than one for EXTRA_TERMINAL_GRACE_MS is an error.
 */
async function waitForSettledTerminal(page, find, script) {
  let last = null;
  let since = 0;
  let terminals = 0;
  let extraSince = null;
  let extraPersisted = false;
  await waitUntil(async () => {
    const session = await find();
    const measured = await page.evaluate(() => {
      const doc = globalThis.document;
      const screens = doc.querySelectorAll(".xterm-screen");
      if (screens.length !== 1) return { terminals: screens.length, geometry: null };
      const [screen] = screens;
      const ready =
        !doc.querySelector(".terminal-status-overlay") &&
        doc.fonts.status === "loaded" &&
        screen.offsetWidth > 0 &&
        screen.offsetHeight > 0;
      return {
        terminals: 1,
        geometry: ready ? `${screen.offsetWidth}x${screen.offsetHeight}` : null,
      };
    });
    terminals = measured.terminals;
    if (terminals > 1) {
      extraSince ??= Date.now();
      last = null;
      // Ends the wait so the throw below fails loudly; throwing here would be
      // swallowed by waitUntil's catch into a slow, misleading timeout.
      extraPersisted = Date.now() - extraSince >= EXTRA_TERMINAL_GRACE_MS;
      return extraPersisted;
    }
    extraSince = null;
    if (!(session?.subscriberCount > 0) || measured.geometry === null) {
      last = null;
      return false;
    }
    if (measured.geometry !== last) {
      last = measured.geometry;
      since = Date.now();
      return false;
    }
    return Date.now() - since >= SETTLE_MS;
  }, `the terminal attached to ${script} to settle`);
  if (extraPersisted) {
    throw new Error(
      `expected one mounted terminal while waiting for ${script}, found ${terminals}`,
    );
  }
}

/** The page's terminals and, when there is exactly one, its geometry. */
function measureTerminal(page) {
  return page.evaluate(() => {
    const screens = globalThis.document.querySelectorAll(".xterm-screen");
    if (screens.length !== 1) return { terminals: screens.length };
    const [screen] = screens;
    return {
      terminals: 1,
      screen: { width: screen.offsetWidth, height: screen.offsetHeight },
      canvases: [...screen.querySelectorAll("canvas")].map((c) => ({
        cssWidth: c.getBoundingClientRect().width,
        cssHeight: c.getBoundingClientRect().height,
        width: c.width,
        height: c.height,
      })),
      dpr: globalThis.devicePixelRatio,
    };
  });
}
