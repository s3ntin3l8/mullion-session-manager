/**
 * Verifies the workspace-restore path against the installed dockview.
 *
 * Why this exists: dockview 8.6.1 added a `closeEmptyGroups` option to
 * `DockviewComponent` that gates whether a group is removed once its last
 * panel is closed (issue #1903). The option defaults to `true`, which is
 * 8.5.1's unconditional behaviour, so the bump itself changes nothing — but
 * "the default is the old behaviour" is a claim about the library, and the
 * only thing that actually protects Mullion is a check that fails when it
 * stops being true.
 *
 * What it checks, in a real Chromium against a throwaway Mullion:
 *
 *   1. Opening a tile creates exactly one dockview group, and the board's
 *      "Nothing tiled here yet" overlay goes away.
 *   2. Closing the only pane of that group removes the group: the group
 *      count drops back to zero, the watermark comes back, and the overlay
 *      returns. This is the `closeEmptyGroups` behaviour.
 *   3. The layout the app autosaves after that close carries no leftover
 *      group — the emptied group is gone from the serialized blob, not just
 *      from the screen.
 *   4. The restore path reads a saved layout back: the blob captured in (1)
 *      is stored server-side and the app restores the tile from it on a
 *      fresh page load; the blob captured in (2) restores to an empty board.
 *
 * Step 4 stores the blobs through the demo's own Node-side API helper rather
 * than through the browser. The demo runs vite on one port and the backend on
 * another, so the browser's `Origin` is not the backend's own origin and
 * plugins/auth.ts rejects every mutating browser request ("cross-origin
 * request rejected") — a demo-topology artifact, not a product behavior. A
 * Node fetch carries no `Origin` header, which the same check deliberately
 * allows. The browser's own autosave is still observed (step 3 reads the
 * payload it sends); only the write is re-routed.
 *
 * Usage: `node scripts/verify-dockview-restore.mjs` (or `make
 * verify-dockview-restore`). Needs Playwright's Chromium once:
 * `npx playwright install chromium`.
 */
import { chromium } from "playwright";
import { startDemo } from "./demo/instance.mjs";
import { withDemo } from "./demo/with-demo.mjs";

/** dockview's own group container. One per tiled group. */
const GROUP = ".dv-groupview";
/** dockview's own empty-state overlay. */
const WATERMARK = ".dv-watermark";
/** Mullion's own empty-grid overlay, drawn when no pane is tiled. */
const EMPTY_OVERLAY = ".empty-grid-dropzone";

const failures = [];

function check(label, ok, detail = "") {
  console.log(`[verify] ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

async function boardState(page) {
  return page.evaluate(
    ({ group, watermark, emptyOverlay }) => {
      // Runs in the page; this file's lint env is Node, hence globalThis.
      const doc = globalThis.document;
      return {
        groups: doc.querySelectorAll(group).length,
        tabs: doc.querySelectorAll(".dv-tab").length,
        watermark: doc.querySelectorAll(watermark).length,
        emptyOverlay: doc.querySelectorAll(emptyOverlay).length,
        emptyText: doc.body.innerText.includes("Nothing tiled here yet"),
        closeButtons: doc.querySelectorAll('[aria-label="Close pane"]').length,
      };
    },
    { group: GROUP, watermark: WATERMARK, emptyOverlay: EMPTY_OVERLAY },
  );
}

/** The layout the app autosaved, captured from the PATCH it sends. */
function captureAutosavedLayout(page) {
  const captured = { body: null };
  page.on("request", (req) => {
    if (req.method() !== "PATCH") return;
    if (!/\/api\/workspaces\/\d+$/.test(new URL(req.url()).pathname)) return;
    try {
      captured.body = JSON.parse(req.postData() ?? "{}")?.layout ?? null;
    } catch {
      captured.body = null;
    }
  });
  return captured;
}

async function run(browser, demo) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const autosaved = captureAutosavedLayout(page);

  await page.goto(demo.frontendUrl, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);

  const initial = await boardState(page);
  check(
    "an empty board shows no group, shows the watermark and Mullion's overlay",
    initial.groups === 0 && initial.watermark === 1 && initial.emptyOverlay === 1,
    JSON.stringify(initial),
  );

  // --- 1. open a tile -----------------------------------------------------
  const session = page.locator(".session-item", { hasText: "fake-agent.sh" }).first();
  await session.waitFor({ timeout: 30_000 });
  await session.click();
  await page.waitForTimeout(3000);

  const opened = await boardState(page);
  check(
    "opening a tile creates exactly one dockview group and clears the empty overlay",
    opened.groups === 1 && opened.tabs === 1 && opened.watermark === 0 && opened.emptyOverlay === 0,
    JSON.stringify(opened),
  );

  // The autosave is debounced 800ms and the payload is what the server would
  // store, so wait for it before reading it.
  await page.waitForTimeout(1500);
  const openLayout = autosaved.body;
  check(
    "the app autosaved a layout for the open tile",
    !!openLayout,
    JSON.stringify(openLayout)?.slice(0, 160),
  );
  check(
    "the saved layout holds the tiled group and its panel",
    !!openLayout &&
      openLayout.grid?.root?.data?.length === 1 &&
      Object.keys(openLayout.panels ?? {}).length === 1,
    JSON.stringify(openLayout?.grid?.root?.data)?.slice(0, 160),
  );

  // --- 2. close the only pane of the only group ---------------------------
  const closePane = page.getByRole("button", { name: "Close pane" });
  check("the open tile exposes a close control", (await closePane.count()) === 1);
  await closePane.first().click();
  await page.waitForTimeout(2500);

  const closed = await boardState(page);
  check(
    "closing the only pane of the only group removes that group",
    closed.groups === 0 && closed.tabs === 0 && closed.watermark === 1 && closed.emptyOverlay === 1,
    JSON.stringify(closed),
  );

  // --- 3. the emptied group is gone from the saved layout -----------------
  await page.waitForTimeout(1500);
  const closedLayout = autosaved.body;
  check(
    "the autosaved layout after the close carries no leftover group",
    !!closedLayout &&
      (closedLayout.grid?.root?.data?.length ?? -1) === 0 &&
      Object.keys(closedLayout.panels ?? {}).length === 0,
    JSON.stringify(closedLayout?.grid?.root?.data)?.slice(0, 160),
  );

  // --- 4. the restore path reads a saved layout back ----------------------
  // Store the blob captured with the tile open, then load the app fresh: the
  // tile must come back from the blob.
  const workspaces = await demo.api("/api/workspaces");
  const workspaceId = workspaces[0]?.id;
  check("the demo has a workspace to store layouts against", typeof workspaceId === "number");
  if (typeof workspaceId !== "number") return;

  await demo.api(`/api/workspaces/${workspaceId}`, {
    method: "PATCH",
    body: JSON.stringify({ layout: openLayout }),
  });
  const stored = await demo.api("/api/workspaces");
  check(
    "the stored workspace row holds the layout blob",
    !!stored[0]?.layout && (stored[0].layout.grid?.root?.data?.length ?? 0) === 1,
    JSON.stringify(stored[0]?.layout?.grid?.root?.data)?.slice(0, 120),
  );

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(4000);
  const restored = await boardState(page);
  check(
    "a fresh load restores the saved tile from the layout blob",
    restored.groups === 1 && restored.tabs === 1,
    JSON.stringify(restored),
  );

  // And the emptied layout restores to an empty board — the removed group
  // must not come back from the blob.
  await demo.api(`/api/workspaces/${workspaceId}`, {
    method: "PATCH",
    body: JSON.stringify({ layout: closedLayout }),
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(4000);
  const restoredEmpty = await boardState(page);
  check(
    "a fresh load of the emptied layout restores an empty board",
    restoredEmpty.groups === 0 &&
      restoredEmpty.watermark === 1 &&
      restoredEmpty.emptyOverlay === 1 &&
      restoredEmpty.emptyText,
    JSON.stringify(restoredEmpty),
  );

  await context.close();
}

async function main() {
  await withDemo({
    startDemo: () => startDemo({ quiet: true }),
    launchBrowser: () => chromium.launch(),
    run: async (browser, demo) => {
      await run(browser, demo);
    },
  });
}

main().then(
  () => {
    if (failures.length > 0) {
      console.error(`[verify] ${failures.length} check(s) failed: ${failures.join(", ")}`);
      process.exit(1);
    }
    console.log("[verify] all checks passed");
  },
  (err) => {
    console.error("[verify] failed:", err);
    process.exit(1);
  },
);
