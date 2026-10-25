#!/usr/bin/env node
/**
 * Real-browser verification of the five runtime checks the UI/UX audit
 * (docs/audit/2026-10-frontend-ui-ux.md) owed.
 *
 * The audit was static — no browser was ever running — so five things it
 * could not settle by reading code were left open in its "Runtime
 * verification" section:
 *
 *   C1  where focus lands after a palette-initiated workspace switch
 *       (audit finding 43, deferred to #1884 — MEASURED here, not fixed)
 *   C2  that the `inert` drawer is genuinely unreachable by Tab on a
 *       phone-sized viewport
 *   C3  the rendered contrast of the text-role tokens (--dim, --muted, --fg)
 *       over the tinted and hovered backgrounds (the shipped guard compares
 *       token against token, so it cannot see a semi-transparent tint layered
 *       over a surface), plus three targets asserted BY NAME, so the fixes
 *       this series shipped stay guarded even though they moved their targets
 *       off `--dim` and out of the token sweep
 *   C4  whether the 1040x720 Settings modal clips content at 200% zoom
 *   C5  that a failed Dock kill is visibly reported on the row (PR2's
 *       `showCheckStatus` change)
 *
 *   make verify-ui
 *
 * C3's arithmetic lives in scripts/lib/color-math.mjs and is pinned by
 * test/scripts/color-math.test.ts: a parser that quietly stops understanding
 * the `color(srgb …)` form Chromium reports `color-mix()` as would drop every
 * tinted surface from the measurement, and the run would still say "pass".
 *
 * Boots a throwaway Mullion (scripts/demo/instance.mjs: scratch DB, scratch
 * SESSIONS_DIR/HOME, clean env, its own loopback ports), drives it with real
 * Chromium, and tears everything down again — including the demo's session
 * scopes. Requires Playwright's Chromium once: `npx playwright install chromium`.
 *
 * Exit code is 1 when any check fails, so this works as a manual gate even
 * though it is deliberately NOT wired into CI (the browser e2e suite,
 * `make test-e2e`, is not a required status check either).
 *
 * Flags:
 *   --keep             leave the demo running for inspection afterwards
 *   --report <path>    where to write the JSON report (default
 *                      ui-verify-report.json, gitignored — a run artifact)
 *   --only <id>        run a single check (C1..C5) — for debugging
 */
import { chromium } from "playwright";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { startDemo } from "./demo/instance.mjs";
import { withDemo } from "./demo/with-demo.mjs";
import { judgeStates, parseColor, renderSample } from "./lib/color-math.mjs";

const { values } = parseArgs({
  options: {
    keep: { type: "boolean", default: false },
    report: { type: "string", default: "ui-verify-report.json" },
    only: { type: "string" },
  },
});

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 375, height: 812 };
/**
 * 200% browser zoom, two regimes:
 *
 *   - 720x450 CSS px is a 1440x900 window at 200% — the common case. It
 *     lands in the TABLET tier (700-1279.98px), so the app's responsive
 *     layout takes over.
 *   - 1280x720 CSS px is a 2560x1440 window at 200% — still the DESKTOP
 *     tier, so the audit's named 1040x720 modal is the one that renders.
 *
 * Chromium's real browser zoom is not settable from Playwright
 * (`Emulation.setPageScaleFactor` is pinch-zoom and does not change layout;
 * `--force-device-scale-factor` changes the device pixel ratio, not the CSS
 * layout), so halving the CSS viewport is the standard equivalent — it
 * reproduces the 200% layout exactly.
 */
const ZOOM_200 = [
  { name: "1280x720 (desktop tier)", viewport: { width: 1280, height: 720 } },
  { name: "720x450 (tablet tier)", viewport: { width: 720, height: 450 } },
];

/** The control the C5 check writes into the demo project's `.crs/dock.json`. */
const DOCK_CONTROL = {
  id: "ui-verify-logs",
  title: "UI Verify Logs",
  command: "sleep 600",
};

/** The threshold WCAG asks for, by what the sample paints. */
const thresholdFor = (kind) => (kind === "text" ? 4.5 : 3);

/** Round a ratio to two decimals, the precision the report quotes. */
const round2 = (n) =>
  typeof n === "number" && Number.isFinite(n) ? Math.round(n * 100) / 100 : null;

/**
 * The elements whose contrast this check is specifically responsible for.
 *
 * The token sweep only sees elements painted in `--dim`, `--muted` or `--fg`.
 * The two fixes this series shipped deliberately moved their targets OFF
 * `--dim` — the keycap chips to `--fg`, the active row's drag handle to
 * plain white — so once fixed they leave the token sample set entirely. A
 * full revert is caught (the colour goes back to `--dim`). A partial revert
 * of the handle's opacity used to be caught too: dropping only `opacity: 1`
 * left a white icon at the old resting 40% over the emerald fill, 2.10:1
 * (dark) / 2.29:1 (light). That is no longer true. The inactive handle now
 * rests at 0.75 (#1908), and white at 75% over the same fill clears 3:1
 * (3.74:1 dark / 4.28:1 light), so this check would report a pass. The lint
 * guard in `scripts/check-token-contrast.mjs` pins `opacity: 1` on the
 * active rule, which is what still catches that drop — this check cannot.
 *
 * So these targets are asserted by name, against a stated minimum, in every
 * theme — and they are judged on the state they are ACTUALLY painted in, with
 * no "the fade lifts on hover" allowance. That is what makes the shipped
 * fixes actually guarded.
 */
const GUARDED_TARGETS = [
  {
    id: "active-workspace-drag-handle",
    selector: ".workspace-item.active .ws-drag-handle",
    kind: "graphics",
    minRatio: 3,
    scopes: ["app"],
    what: "the active workspace row's drag handle",
  },
  {
    id: "kbd-chip",
    selector: ".kbd",
    kind: "text",
    minRatio: 4.5,
    scopes: ["app", "command palette"],
    what: "the keycap chip (the toolbar's shortcut hint and the palette's)",
  },
  {
    id: "kbd-btn",
    selector: ".kbd-btn",
    kind: "text",
    minRatio: 4.5,
    scopes: ["command palette"],
    what: "the keycap button in the palette footer",
  },
];

/**
 * A scope that measures fewer samples than this is not measuring anything
 * useful — and a sweep that silently stopped finding elements would still
 * report "all clear". C4 has the same floor for the same reason.
 */
const MIN_SAMPLES_PER_SCOPE = 25;

/** Two themes x two scopes. */
const EXPECTED_SCOPE_COUNT = 4;

/**
 * Load the app and wait until it has actually rendered.
 *
 * The readiness signal has to be tier-agnostic: the sidebar is a closed
 * drawer on the phone and tablet tiers, so the project list is not visible
 * there and waiting for it would time out on exactly the viewports C2 and C4
 * care about.
 */
async function openApp(page, demo, { waitForData = false } = {}) {
  await page.goto(demo.frontendUrl, { waitUntil: "networkidle" });
  await page.locator(".cmux-root").waitFor({ state: "attached", timeout: 30_000 });
  await page.locator(".cmux-root").waitFor({ state: "visible", timeout: 30_000 });
  if (waitForData) {
    // The desktop tier only — used by the checks that need the project list.
    // On the phone and tablet tiers the sidebar is a closed drawer, so the
    // project list is not rendered there and waiting for it would time out
    // on exactly the viewports C2 and C4 care about.
    await page.locator(".project-row-name").first().waitFor({ state: "visible", timeout: 30_000 });
  }
  // Let the first polls land so the DOM is not still filling up.
  await page.waitForTimeout(2000);
}

/** Describe whatever currently holds DOM focus. */
const describeActiveElement = () => {
  // Runs in the page; this file's lint env is Node, hence globalThis.
  const el = globalThis.document.activeElement;
  if (!el) return { tag: "(none)", id: "", className: "", text: "", isBody: false };
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || "",
    className: typeof el.className === "string" ? el.className : "",
    text: (el.textContent || "").trim().slice(0, 60),
    isBody: el === globalThis.document.body,
  };
};

/**
 * Installs the measurement helpers on the page.
 *
 * They live on `window` rather than being re-serialized per call because the
 * hover sweep needs two separate evaluations that must agree on WHICH element
 * they are talking about: the first marks the `--dim` elements with a stable
 * id, the second re-measures those SAME marked elements while a hover target
 * is hovered. Matching by collection index instead would silently compare
 * different elements whenever the DOM shifted between the two passes.
 */
function installDimHelpers() {
  // Runs in the page; this file's lint env is Node, hence globalThis.
  const root = globalThis.document.querySelector(".cmux-root");
  if (!root) return false;

  // Resolve the text-role tokens through the browser rather than parsing
  // them ourselves, so the comparison is against the values the browser
  // actually paints with. `--dim` and `--muted` are the two "subtle text"
  // roles; both are used over tinted and hovered surfaces, so both are
  // measured.
  const TEXT_ROLE_TOKENS = ["--dim", "--muted", "--fg"];
  const probe = globalThis.document.createElement("span");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  root.appendChild(probe);
  const tokenColors = {};
  for (const token of TEXT_ROLE_TOKENS) {
    probe.style.color = `var(${token})`;
    tokenColors[token] = globalThis.getComputedStyle(probe).color;
  }
  probe.remove();
  const dimColor = tokenColors["--dim"];

  // The colour arithmetic itself lives in Node (scripts/lib/color-math.mjs),
  // where it can be pinned against known WCAG pairs without a browser. The
  // page only COLLECTS raw colour strings and layer lists.

  const cssPath = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 5) {
      let s = node.tagName.toLowerCase();
      if (node.classList.length) s += "." + Array.from(node.classList).slice(0, 2).join(".");
      const parent = node.parentElement;
      if (parent) {
        const twins = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (twins.length > 1) s += `:nth-of-type(${twins.indexOf(node) + 1})`;
      }
      parts.unshift(s);
      node = node.parentElement;
    }
    return parts.join(" > ");
  };

  /**
   * The opacity actually in effect for an element — the product of its own
   * opacity and every ancestor's, since opacity does not inherit but a faded
   * ancestor fades its whole subtree.
   */
  const effectiveOpacity = (el) => {
    let o = 1;
    let node = el;
    while (node) {
      o *= Number(globalThis.getComputedStyle(node).opacity);
      if (o < 0.05) return o;
      node = node.parentElement;
    }
    return o;
  };

  /**
   * The background layers painted behind `el`, innermost first.
   *
   * Returned as raw computed colour strings — the compositing happens in Node
   * (scripts/lib/color-math.mjs) where it can be unit-tested against known
   * WCAG pairs. The innermost layer is the one painted on top of the others.
   */
  const backgroundLayers = (el) => {
    const layers = [];
    let hasImage = false;
    let node = el;
    while (node) {
      const cs = globalThis.getComputedStyle(node);
      layers.push(cs.backgroundColor);
      if (cs.backgroundImage && cs.backgroundImage !== "none") {
        hasImage = true;
        break;
      }
      node = node.parentElement;
    }
    return { layers, hasImage };
  };

  const isRendered = (el) => {
    if (!el.getClientRects().length) return false;
    const cs = globalThis.getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.visibility === "collapse") return false;
    return effectiveOpacity(el) >= 0.05;
  };

  const HOVERABLE = "a[href], button, [role='button'], [role='tab'], summary, label";

  /**
   * The element a `:hover` rule would actually repaint for `el`.
   *
   * Not every hoverable thing in this app is a `<button>` — plenty of rows
   * and section headers are plain elements with `cursor: pointer` and their
   * own `:hover` background. `cursor` inherits, so the element that
   * *introduced* the pointer cursor is the one carrying the hover style;
   * that is the element to hover.
   */
  const hoverAncestor = (el) => {
    let node = el;
    let last = null;
    while (
      node &&
      node !== globalThis.document.body &&
      node !== globalThis.document.documentElement
    ) {
      if (node.matches(HOVERABLE)) return node;
      const cursor = globalThis.getComputedStyle(node).cursor;
      if (cursor === "pointer") {
        // Keep walking: the cursor may have been introduced further up.
        last = node;
      } else if (last) {
        return last;
      }
      node = node.parentElement;
    }
    return last;
  };

  /**
   * Does this element actually PAINT anything in its own colour?
   *
   * An element's computed `color` matters only if something is drawn with it:
   * a text node of its own, or a graphical object that inherits the colour.
   * A container that merely carries a colour for its children (the workspace
   * row's actions wrapper, say) paints nothing itself, and measuring it would
   * report a failure for a pixel that is never drawn.
   *
   * The kind also decides the threshold WCAG asks for: 4.5:1 for text
   * (1.4.3), 3:1 for a graphical object (1.4.11).
   */
  const sampleKind = (el) => {
    // Inside an <svg>: the svg's host is the sample, not its parts.
    if (el.closest("svg")) return null;
    for (const node of el.childNodes) {
      if (node.nodeType === 3 && node.textContent.trim().length > 0) return "text";
    }
    const elColor = globalThis.getComputedStyle(el).color;
    for (const svg of el.querySelectorAll("svg")) {
      // Painted in some other colour (a child that overrides it) — not ours.
      if (globalThis.getComputedStyle(svg).color !== elColor) continue;
      const stroke = globalThis.getComputedStyle(svg).stroke;
      const fill = globalThis.getComputedStyle(svg).fill;
      const painted =
        stroke.toLowerCase() === "currentcolor" ||
        fill.toLowerCase() === "currentcolor" ||
        stroke === elColor ||
        fill === elColor;
      if (painted) return "graphics";
    }
    return null;
  };

  /**
   * The raw painting facts about one element.
   *
   * Deliberately uninterpreted: the page hands back colour strings and layer
   * lists, and Node does the arithmetic (scripts/lib/color-math.mjs), where it
   * can be pinned against known WCAG pairs.
   */
  const describe = (el, key) => {
    const bg = backgroundLayers(el);
    return {
      key,
      kind: sampleKind(el),
      token: el.getAttribute("data-ui-verify-token"),
      path: cssPath(el),
      text: (el.textContent || "").trim().slice(0, 40),
      color: globalThis.getComputedStyle(el).color,
      opacity: effectiveOpacity(el),
      layers: bg.layers,
      hasImage: bg.hasImage,
    };
  };

  globalThis.__uiVerifyDim = {
    dimColor,
    /**
     * Mark the elements to measure.
     *
     * Two populations:
     *  - every rendered element painted in one of the three text-role tokens
     *    (`--dim`, `--muted`, `--fg`), and
     *  - the explicitly GUARDED targets, whose colour is deliberately NOT a
     *    token (the fixes moved them off `--dim`), so the token sweep on its
     *    own would never see them again.
     *
     * `rootSelector` scopes the sweep to ONE surface. It matters: with the
     * command palette open, the app chrome behind it is covered by the
     * palette's backdrop, so it cannot be hovered and the user cannot see
     * it — measuring it there would judge the same element differently in
     * two scopes (its de-emphasis lifts on hover in the app scope, and
     * cannot lift behind an overlay). The app chrome is measured in the app
     * scope, where it is visible; the palette is measured in the palette
     * scope.
     */
    mark(rootSelector, guards) {
      globalThis.document
        .querySelectorAll(
          "[data-ui-verify-dim], [data-ui-verify-hover], [data-ui-verify-token], [data-ui-verify-guard]",
        )
        .forEach((el) => {
          el.removeAttribute("data-ui-verify-dim");
          el.removeAttribute("data-ui-verify-hover");
          el.removeAttribute("data-ui-verify-token");
          el.removeAttribute("data-ui-verify-guard");
        });
      const root = globalThis.document.querySelector(rootSelector);
      if (!root) {
        return {
          dimColor,
          marked: 0,
          hoverTargets: [],
          guarded: [],
          error: `no ${rootSelector} in the DOM`,
        };
      }
      const hoverTargets = new Map();
      const elements = Array.from(root.querySelectorAll("*")).filter(
        (el) =>
          isRendered(el) &&
          Object.values(tokenColors).includes(globalThis.getComputedStyle(el).color) &&
          sampleKind(el) !== null,
      );
      elements.forEach((el, index) => {
        el.setAttribute("data-ui-verify-dim", String(index));
        const token =
          Object.keys(tokenColors).find(
            (t) => tokenColors[t] === globalThis.getComputedStyle(el).color,
          ) ?? "--dim";
        el.setAttribute("data-ui-verify-token", token);
        const hoverTarget = hoverAncestor(el);
        if (
          hoverTarget &&
          isRendered(hoverTarget) &&
          !hoverTarget.hasAttribute("data-ui-verify-hover")
        ) {
          hoverTargets.set(hoverTarget, hoverTargets.size);
          hoverTarget.setAttribute("data-ui-verify-hover", String(hoverTargets.size - 1));
        }
      });

      const guarded = [];
      for (const guard of guards ?? []) {
        const found = Array.from(root.querySelectorAll(guard.selector)).filter((el) =>
          isRendered(el),
        );
        found.forEach((el, index) => {
          const key = `${guard.id}#${index}`;
          el.setAttribute("data-ui-verify-guard", key);
          guarded.push({ id: guard.id, key, path: cssPath(el) });
        });
      }
      return {
        dimColor,
        marked: elements.length,
        hoverTargets: [...hoverTargets.entries()].map(([el, id]) => ({ id, path: cssPath(el) })),
        guarded,
      };
    },
    /** Collect the raw painting facts for everything marked, as painted NOW. */
    collect() {
      const samples = [];
      for (const el of globalThis.document.querySelectorAll("[data-ui-verify-dim]")) {
        samples.push(describe(el, `d${el.getAttribute("data-ui-verify-dim")}`));
      }
      const guards = [];
      for (const el of globalThis.document.querySelectorAll("[data-ui-verify-guard]")) {
        guards.push(describe(el, el.getAttribute("data-ui-verify-guard")));
      }
      return { samples, guards };
    },
    clear() {
      globalThis.document
        .querySelectorAll(
          "[data-ui-verify-dim], [data-ui-verify-hover], [data-ui-verify-token], [data-ui-verify-guard]",
        )
        .forEach((el) => {
          el.removeAttribute("data-ui-verify-dim");
          el.removeAttribute("data-ui-verify-hover");
          el.removeAttribute("data-ui-verify-token");
          el.removeAttribute("data-ui-verify-guard");
        });
      delete globalThis.__uiVerifyDim;
    },
  };
  return true;
}

const CHECKS = [
  {
    id: "C1",
    title: "palette workspace switch: where does focus land?",
    async run({ browser, demo }) {
      const workspace = await demo.api("/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: "Verify Workspace" }),
      });
      const page = await browser.newPage({ viewport: DESKTOP });
      await openApp(page, demo, { waitForData: true });

      await page.keyboard.press("ControlOrMeta+k");
      const palette = page.locator(".cmd-palette");
      await palette.waitFor({ state: "visible", timeout: 15_000 });
      const input = page.locator(".cmd-palette-search input");
      await input.waitFor({ state: "visible", timeout: 10_000 });
      await input.fill(workspace.name);

      const row = page.locator(".cmd-row", { hasText: workspace.name });
      await row.first().waitFor({ state: "visible", timeout: 10_000 });
      await row.first().click();
      await page.locator(".cmd-palette").waitFor({ state: "detached", timeout: 10_000 });

      // Precondition: did the switch actually happen? The sidebar's active
      // workspace row is the app's own rendering of the active workspace.
      await page.waitForTimeout(800);
      const activeName = await page
        .locator(".workspace-item.active .workspace-item-name")
        .first()
        .textContent()
        .catch(() => null);
      const switched = (activeName ?? "").trim() === workspace.name;

      const focus = await page.evaluate(describeActiveElement);
      await page.close();

      return {
        status: switched ? "pass" : "fail",
        detail: switched
          ? `workspace switched to "${workspace.name}"; focus landed on <${focus.tag}>`
          : `the workspace did NOT switch (active row: ${activeName ?? "(none)"}) — the measurement would be meaningless`,
        evidence: {
          workspace: { id: workspace.id, name: workspace.name },
          switched,
          activeWorkspaceRow: (activeName ?? "").trim(),
          focus,
          note:
            "Audit finding 43 is deferred to #1884, so this is a MEASUREMENT, not a fix: " +
            "the check records where focus ends up and reports it.",
        },
      };
    },
  },

  {
    id: "C2",
    title: "the inert drawer is unreachable by Tab on a phone-sized viewport",
    async run({ browser, demo }) {
      const page = await browser.newPage({ viewport: PHONE });
      await openApp(page, demo);

      const drawer = page.locator(".sidebar-wrapper");
      await drawer.waitFor({ state: "attached", timeout: 15_000 });

      // Precondition: the drawer really is inert. Without this the Tab walk
      // below would pass for the wrong reason.
      const inertState = await drawer.evaluate((el) => ({
        property: el.inert === true,
        attribute: el.hasAttribute("inert"),
        visibility: globalThis.getComputedStyle(el).visibility,
      }));
      if (!inertState.property || !inertState.attribute) {
        await page.close();
        return {
          status: "fail",
          detail:
            "the closed drawer is NOT inert (property=" +
            `${inertState.property}, attribute=${inertState.attribute}) — ` +
            "the Tab walk would have been meaningless",
          evidence: { inertState },
        };
      }

      // Start the walk from a known focusable element OUTSIDE the drawer.
      const startFocus = await page.evaluate(() => {
        const drawerEl = globalThis.document.querySelector(".sidebar-wrapper");
        const focusable = Array.from(
          globalThis.document.querySelectorAll(
            "a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex='-1'])",
          ),
        ).filter((el) => {
          if (drawerEl?.contains(el)) return false;
          const r = el.getBoundingClientRect();
          const cs = globalThis.getComputedStyle(el);
          return r.width > 0 && r.height > 0 && cs.visibility !== "hidden";
        });
        focusable[0]?.focus();
        return focusable[0]
          ? { tag: focusable[0].tagName.toLowerCase(), className: focusable[0].className }
          : null;
      });

      const landed = [];
      let inDrawer = 0;
      const outside = new Set();
      for (let i = 0; i < 30; i++) {
        await page.keyboard.press("Tab");
        const where = await page.evaluate((selector) => {
          const drawerEl = globalThis.document.querySelector(selector);
          const el = globalThis.document.activeElement;
          const tag = el ? el.tagName.toLowerCase() : "(none)";
          const cls = el && typeof el.className === "string" ? el.className : "";
          return {
            tag,
            className: cls,
            inDrawer: drawerEl ? drawerEl.contains(el) : false,
            key: `${tag}.${cls}`,
          };
        }, ".sidebar-wrapper");
        landed.push(where);
        if (where.inDrawer) inDrawer++;
        else outside.add(where.key);
      }

      // `inert` also refuses focus directly, not just through the tab order:
      // asking a descendant to take focus must not work while the drawer is
      // closed. That is the sharper half of the property.
      const focusWhileClosed = await drawer.evaluate((el) => {
        const candidate = el.querySelector(
          "button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex='-1'])",
        );
        if (!candidate) return { found: false, focused: false };
        candidate.focus();
        return { found: true, focused: globalThis.document.activeElement === candidate };
      });

      // Non-vacuity: the drawer must be REACHABLE once it is open, otherwise
      // "unreachable" would be trivially true.
      await page.locator('[title="Toggle sidebar"]').first().click();
      await page.waitForTimeout(800);
      const openedState = await drawer.evaluate((el) => ({
        property: el.inert === true,
        attribute: el.hasAttribute("inert"),
      }));
      const focusWhenOpen = await drawer.evaluate((el) => {
        const candidate = el.querySelector(
          "button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex='-1'])",
        );
        if (!candidate) return { found: false, focused: false };
        candidate.focus();
        return { found: true, focused: globalThis.document.activeElement === candidate };
      });
      let reachedWhenOpen = false;
      if (!openedState.property && !openedState.attribute) {
        for (let i = 0; i < 12; i++) {
          await page.keyboard.press("Tab");
          const inside = await page.evaluate((selector) => {
            const drawerEl = globalThis.document.querySelector(selector);
            return drawerEl ? drawerEl.contains(globalThis.document.activeElement) : false;
          }, ".sidebar-wrapper");
          if (inside) {
            reachedWhenOpen = true;
            break;
          }
        }
      }
      await page.close();

      const ok =
        inDrawer === 0 &&
        outside.size >= 3 &&
        focusWhileClosed.found &&
        !focusWhileClosed.focused &&
        !openedState.property &&
        !openedState.attribute &&
        focusWhenOpen.focused &&
        reachedWhenOpen;
      return {
        status: ok ? "pass" : "fail",
        detail: ok
          ? `30 Tab presses, 0 landed in the inert drawer (${outside.size} distinct controls outside it); ` +
            "a closed drawer refuses focus, an open one takes it"
          : `landedInDrawer=${inDrawer}, distinctOutside=${outside.size}, ` +
            `focusWhileClosed=${JSON.stringify(focusWhileClosed)}, ` +
            `stillInertWhenOpen=${openedState.property}, focusWhenOpen=${JSON.stringify(focusWhenOpen)}, ` +
            `reachedWhenOpen=${reachedWhenOpen}`,
        evidence: {
          viewport: PHONE,
          inertState,
          openedState,
          tabPresses: landed.length,
          landedInDrawer: inDrawer,
          distinctOutsideDrawer: outside.size,
          startFocus,
          focusWhileClosed,
          focusWhenOpen,
          reachableWhenOpen: reachedWhenOpen,
          landingSample: landed.slice(0, 5),
        },
      };
    },
  },

  {
    id: "C3",
    title: "rendered contrast of the text-role tokens over tinted and hovered backgrounds",
    async run({ browser, demo }) {
      const page = await browser.newPage({ viewport: DESKTOP });
      await openApp(page, demo, { waitForData: true });

      const scopes = [];
      const preconditions = [];
      const themes = ["dark", "light"];

      /**
       * Turn one collected sample into its rendered ratio.
       *
       * The page hands back raw colour strings; the arithmetic happens here,
       * in Node, where `scripts/lib/color-math.mjs` can be pinned against
       * known WCAG pairs by `test/scripts/color-math.test.ts`.
       */
      const render = (raw) => {
        const rendered = renderSample({
          color: raw.color,
          layers: raw.layers.map(parseColor),
          opacity: raw.opacity,
        });
        return {
          ...raw,
          ratio: round2(rendered.ratio),
          foregroundResolved: rendered.resolved,
          background: rendered.background
            ? `rgb(${Math.round(rendered.background.r)}, ${Math.round(rendered.background.g)}, ${Math.round(rendered.background.b)})`
            : null,
          backgroundLayers: raw.layers.length,
        };
      };

      /**
       * Measure the current DOM. The hover sweep re-measures with each hover
       * target hovered, so a `:hover` rule that repaints the background is
       * measured as painted, not as authored.
       *
       * `rootSelector` scopes the sweep to ONE surface — see the note on
       * `mark()`: the app chrome behind the open palette is covered by the
       * palette's backdrop, so it is measured in the app scope instead.
       */
      const measure = async (themeName, scopeName, rootSelector) => {
        const installed = await page.evaluate(installDimHelpers);
        if (!installed) {
          return {
            theme: themeName,
            scope: scopeName,
            error: "no .cmux-root in the DOM",
            // A dead scope still has to count as a dead scope: without these
            // the totals below become NaN, the sample floor cannot see it,
            // and an unresolvable foreground in another scope gets
            // misdiagnosed as a missing guard.
            total: 0,
            unresolvedForeground: 0,
            samples: [],
            guards: [],
          };
        }
        const marked = await page.evaluate(
          ({ root, guards }) => globalThis.__uiVerifyDim.mark(root, guards),
          {
            root: rootSelector,
            guards: GUARDED_TARGETS.map((g) => ({ id: g.id, selector: g.selector })),
          },
        );
        if (marked.error) {
          return {
            theme: themeName,
            scope: scopeName,
            error: marked.error,
            total: 0,
            unresolvedForeground: 0,
            samples: [],
            guards: [],
          };
        }
        const base = await page.evaluate(() => globalThis.__uiVerifyDim.collect());

        // Per-element state lists: the base state first, then every state
        // observed while something was hovered.
        const sampleStates = new Map();
        const guardStates = new Map();
        for (const raw of base.samples) {
          const rendered = render(raw);
          sampleStates.set(raw.key, {
            raw,
            rendered,
            states: [{ ratio: rendered.ratio, opacity: raw.opacity }],
          });
        }
        for (const raw of base.guards) {
          const rendered = render(raw);
          guardStates.set(raw.key, {
            raw,
            rendered,
            states: [{ ratio: rendered.ratio, opacity: raw.opacity }],
          });
        }

        let hovered = 0;
        let confirmed = 0;
        const hoverResults = [];
        for (const target of marked.hoverTargets) {
          const locator = page.locator(`[data-ui-verify-hover="${target.id}"]`).first();
          try {
            await locator.hover({ timeout: 2000 });
          } catch {
            hoverResults.push({
              id: target.id,
              path: target.path,
              hovered: false,
              reason: "not hoverable",
            });
            continue;
          }
          hovered++;
          // Confirm the browser really applied :hover to the target — a
          // hover that silently did not land would leave the hovered
          // background unmeasured while looking like it was covered.
          const applied = await page.evaluate((id) => {
            const el = globalThis.document.querySelector(`[data-ui-verify-hover="${id}"]`);
            return el ? el.matches(":hover") : false;
          }, target.id);
          if (applied) confirmed++;
          hoverResults.push({ id: target.id, path: target.path, hovered: applied, reason: "" });
          // Re-collect the SAME marked elements, so the key still identifies
          // the same element even if the DOM shifted while hovering.
          const after = await page.evaluate(() => globalThis.__uiVerifyDim.collect());
          const fold = (raw, into) => {
            const entry = into.get(raw.key);
            if (!entry) return;
            const rendered = render(raw);
            if (rendered.ratio === null) return;
            entry.states.push({ ratio: rendered.ratio, opacity: raw.opacity });
          };
          for (const raw of after.samples) fold(raw, sampleStates);
          for (const raw of after.guards) fold(raw, guardStates);
        }
        await page.evaluate(() => globalThis.__uiVerifyDim.clear());

        // The token sweep. Each element is judged on the state it is meant to
        // be read in: its highest observed opacity. A de-emphasis that lifts
        // on hover is judged engaged; a fade that NEVER lifts is judged
        // exactly as painted, because that is the state it lives in.
        const samples = [...sampleStates.values()].map((entry) => {
          const judged = judgeStates(entry.states);
          return {
            id: entry.raw.key,
            kind: entry.raw.kind,
            threshold: thresholdFor(entry.raw.kind),
            token: entry.raw.token ?? "--dim",
            path: entry.raw.path,
            text: entry.raw.text,
            color: entry.raw.color,
            opacity: Math.round(entry.raw.opacity * 100) / 100,
            foregroundResolved: entry.rendered.foregroundResolved,
            background: entry.rendered.background,
            backgroundLayers: entry.rendered.backgroundLayers,
            hasImage: entry.raw.hasImage,
            ratio: entry.rendered.ratio,
            // The ratio the verdict is based on.
            judgedRatio: round2(judged.judgedRatio),
            // The ratio as painted at rest, and the ratio at full strength.
            paintedRatio: round2(judged.paintedRatio),
            engagedRatio: round2(judged.engagedRatio),
            // Did the de-emphasis ever lift? If not, the painted ratio IS
            // the judged one.
            lifts: judged.lifts,
            // The strictest state seen at all — reported, not judged.
            worstRatio: round2(Math.min(...entry.states.map((s) => s.ratio))),
          };
        });

        // The guarded targets are judged on the STRICTEST state they were
        // seen in, with no lift allowance at all: that is what makes the
        // shipped fixes actually guarded.
        const guards = [...guardStates.values()].map((entry) => {
          const guard = GUARDED_TARGETS.find((g) => entry.raw.key.startsWith(`${g.id}#`));
          return {
            id: guard?.id ?? entry.raw.key,
            what: guard?.what ?? "",
            minRatio: guard?.minRatio ?? null,
            kind: entry.raw.kind,
            expectedKind: guard?.kind ?? null,
            path: entry.raw.path,
            text: entry.raw.text,
            color: entry.raw.color,
            opacity: Math.round(entry.raw.opacity * 100) / 100,
            background: entry.rendered.background,
            ratio: entry.rendered.ratio,
            strictestRatio: round2(Math.min(...entry.states.map((s) => s.ratio))),
            states: entry.states.length,
          };
        });

        return {
          theme: themeName,
          scope: scopeName,
          dimColor: marked.dimColor,
          total: samples.length,
          unresolvedForeground: samples.filter((s) => !s.foregroundResolved).length,
          hoverTargets: marked.hoverTargets.length,
          hoveredTargets: hovered,
          confirmedHoverTargets: confirmed,
          hoverResults,
          samples,
          guards,
          markedGuards: marked.guarded,
        };
      };

      const themeButton = page.locator(".toolbar-theme-btn");

      for (const theme of themes) {
        if (theme === "light") {
          const titleBefore = await themeButton.first().getAttribute("title");
          await themeButton.first().click();
          // The theme switch is a PRECONDITION, not something to swallow. If
          // the click did not switch the theme, the "light" pass would just
          // re-measure the dark theme and the run would look like it covered
          // both themes while covering one twice.
          const switched = await page
            .locator(".cmux-root.light")
            .waitFor({ state: "attached", timeout: 10_000 })
            .then(() => true)
            .catch(() => false);
          await page.waitForTimeout(700);
          const titleAfter = await themeButton.first().getAttribute("title");
          preconditions.push({
            precondition: "the theme toggle switches to the light theme",
            ok: switched,
            titleBefore,
            titleAfter,
          });
          if (!switched) break;
        }
        // Scope 1: the app's own chrome (sidebar, dock, panes).
        scopes.push(await measure(theme, "app", ".cmux-root"));

        // Scope 2: the command palette — the densest source of `--dim` over
        // TINTED surfaces (the accent-tinted target strip and the project
        // picker) and of hovered rows (`.cmd-row:hover`). Scoped to the
        // palette's own subtree: the app chrome behind it is covered by the
        // palette's backdrop, so it is measured in the app scope above.
        await page.keyboard.press("ControlOrMeta+k");
        await page.locator(".cmd-palette").waitFor({ state: "visible", timeout: 15_000 });
        await page.waitForTimeout(700);
        scopes.push(await measure(theme, "command palette", ".cmd-palette"));
        await page.keyboard.press("Escape");
        await page.locator(".cmd-palette").waitFor({ state: "detached", timeout: 10_000 });
        await page.waitForTimeout(400);
      }

      await page.close();

      // The two themes must actually be two themes: if they resolved the
      // same `--dim`, the "light" pass measured the dark theme twice.
      const darkScope = scopes.find((s) => s.theme === "dark" && s.scope === "app");
      const lightScope = scopes.find((s) => s.theme === "light" && s.scope === "app");
      const themesDiffer =
        darkScope && lightScope ? darkScope.dimColor !== lightScope.dimColor : false;
      preconditions.push({
        precondition: "the two themes resolve different --dim values",
        ok: themesDiffer,
        dark: darkScope?.dimColor ?? null,
        light: lightScope?.dimColor ?? null,
      });

      const failures = scopes.flatMap((t) =>
        t.samples
          .filter(
            (s) =>
              s.judgedRatio !== null &&
              s.judgedRatio < s.threshold &&
              s.kind !== null &&
              !s.hasImage,
          )
          .map((s) => ({ ...s, theme: t.theme, scope: t.scope })),
      );
      const notMeasurable = scopes.flatMap((t) =>
        t.samples.filter((s) => s.hasImage).map((s) => ({ ...s, theme: t.theme, scope: t.scope })),
      );

      // The guarded targets: present in every theme and scope they are
      // expected in, and clear of their stated minimum in the strictest state
      // they were seen in.
      const guardMissing = [];
      const guardFailures = [];
      for (const guard of GUARDED_TARGETS) {
        for (const scopeName of guard.scopes) {
          for (const theme of themes) {
            const scope = scopes.find((s) => s.theme === theme && s.scope === scopeName);
            const found = (scope?.guards ?? []).filter((g) => g.id === guard.id);
            if (!found.length) {
              guardMissing.push({
                id: guard.id,
                theme,
                scope: scopeName,
                minRatio: guard.minRatio,
                what: guard.what,
              });
              continue;
            }
            for (const g of found) {
              const kindMismatch = g.kind !== guard.kind;
              const tooLow = g.strictestRatio !== null && g.strictestRatio < guard.minRatio;
              if (kindMismatch || tooLow) {
                guardFailures.push({
                  ...g,
                  theme,
                  scope: scopeName,
                  minRatio: guard.minRatio,
                  kindMismatch,
                  tooLow,
                });
              }
            }
          }
        }
      }

      const measured = scopes.reduce((n, t) => n + t.total, 0);
      const guardsMeasured = scopes.reduce((n, t) => n + (t.guards?.length ?? 0), 0);
      const unresolved = scopes.reduce((n, t) => n + t.unresolvedForeground, 0);
      // A scope that measures almost nothing is not measuring anything — and
      // a sweep that silently stopped finding elements would still report
      // "all clear". C4 has the same floor for the same reason.
      const thinScopes = scopes
        .filter((t) => t.total < MIN_SAMPLES_PER_SCOPE)
        .map((t) => ({ theme: t.theme, scope: t.scope, total: t.total }));
      const scopeCountOk = scopes.length === EXPECTED_SCOPE_COUNT;
      const preconditionsOk = preconditions.every((p) => p.ok);

      const reasons = [];
      if (!preconditionsOk) {
        reasons.push(
          `a precondition failed (${preconditions
            .filter((p) => !p.ok)
            .map((p) => p.precondition)
            .join("; ")})`,
        );
      }
      if (!scopeCountOk) {
        reasons.push(
          `only ${scopes.length} of ${EXPECTED_SCOPE_COUNT} scope/theme combinations were measured`,
        );
      }
      if (thinScopes.length) {
        reasons.push(
          `${thinScopes.length} scope(s) measured fewer than ${MIN_SAMPLES_PER_SCOPE} samples ` +
            `(${thinScopes.map((t) => `${t.theme}/${t.scope}=${t.total}`).join(", ")})`,
        );
      }
      if (unresolved > 0) {
        reasons.push(
          `${unresolved} samples had an unresolvable foreground colour — the measurement is not trustworthy`,
        );
      }
      if (guardMissing.length) {
        reasons.push(
          `${guardMissing.length} guarded target(s) were not found ` +
            `(${guardMissing.map((g) => `${g.id} in ${g.theme}/${g.scope}`).join(", ")})`,
        );
      }
      if (guardFailures.length) {
        reasons.push(
          `${guardFailures.length} guarded target(s) fell below their minimum ` +
            `(worst ${Math.min(...guardFailures.map((g) => g.strictestRatio ?? Infinity))}:1)`,
        );
      }
      if (failures.length) {
        reasons.push(
          `${failures.length} of ${measured} text-role samples fall below their WCAG threshold ` +
            `(worst ${Math.min(...failures.map((f) => f.judgedRatio))}:1)`,
        );
      }

      const ok = reasons.length === 0;

      return {
        status: ok ? "pass" : "fail",
        detail: ok
          ? `${measured} text-role samples across ${scopes.length} scope/theme combinations, all clear of ` +
            `their WCAG threshold; ${guardsMeasured} guarded targets clear of their minimums`
          : reasons.join("; "),
        evidence: {
          thresholds: { text: 4.5, graphics: 3 },
          measured,
          guardsMeasured,
          unresolvedForeground: unresolved,
          scopeCount: scopes.length,
          minSamplesPerScope: MIN_SAMPLES_PER_SCOPE,
          preconditions,
          guardedTargets: GUARDED_TARGETS,
          scopes: scopes.map((t) => ({
            theme: t.theme,
            scope: t.scope,
            dimColor: t.dimColor,
            total: t.total,
            hoverTargets: t.hoverTargets,
            hoveredTargets: t.hoveredTargets,
            confirmedHoverTargets: t.confirmedHoverTargets,
            hoverResults: t.hoverResults?.filter((h) => !h.hovered).slice(0, 8),
            error: t.error,
            worst: [...(t.samples ?? [])]
              .filter((s) => s.judgedRatio !== null)
              .sort((a, b) => a.judgedRatio - b.judgedRatio)
              .slice(0, 8)
              .map((s) => ({
                path: s.path,
                text: s.text,
                kind: s.kind,
                threshold: s.threshold,
                ratio: s.ratio,
                judgedRatio: s.judgedRatio,
                paintedRatio: s.paintedRatio,
                engagedRatio: s.engagedRatio,
                lifts: s.lifts,
                opacity: s.opacity,
                background: s.background,
              })),
            guards: (t.guards ?? []).map((g) => ({
              id: g.id,
              what: g.what,
              minRatio: g.minRatio,
              kind: g.kind,
              ratio: g.ratio,
              strictestRatio: g.strictestRatio,
              opacity: g.opacity,
              background: g.background,
              path: g.path,
            })),
            samples: (t.samples ?? []).map((s) => ({
              path: s.path,
              text: s.text,
              kind: s.kind,
              threshold: s.threshold,
              ratio: s.ratio,
              judgedRatio: s.judgedRatio,
              paintedRatio: s.paintedRatio,
              engagedRatio: s.engagedRatio,
              lifts: s.lifts,
              opacity: s.opacity,
              background: s.background,
            })),
          })),
          failures: failures.slice(0, 20).map((f) => ({
            theme: f.theme,
            scope: f.scope,
            token: f.token,
            kind: f.kind,
            threshold: f.threshold,
            path: f.path,
            text: f.text,
            ratio: f.ratio,
            judgedRatio: f.judgedRatio,
            paintedRatio: f.paintedRatio,
            engagedRatio: f.engagedRatio,
            lifts: f.lifts,
            opacity: f.opacity,
            background: f.background,
          })),
          guardFailures: guardFailures.slice(0, 20).map((g) => ({
            id: g.id,
            theme: g.theme,
            scope: g.scope,
            minRatio: g.minRatio,
            kind: g.kind,
            expectedKind: g.expectedKind,
            kindMismatch: g.kindMismatch,
            path: g.path,
            ratio: g.ratio,
            strictestRatio: g.strictestRatio,
            opacity: g.opacity,
            background: g.background,
          })),
          guardMissing,
          notMeasurable: notMeasurable.slice(0, 20).map((n) => ({
            theme: n.theme,
            scope: n.scope,
            path: n.path,
            text: n.text,
            background: n.background,
          })),
        },
      };
    },
  },

  {
    id: "C4",
    title: "the Settings modal does not clip content at 200% zoom",
    async run({ browser, demo }) {
      const regimes = [];

      for (const regime of ZOOM_200) {
        const page = await browser.newPage({ viewport: regime.viewport });
        await openApp(page, demo);

        await page.keyboard.press("ControlOrMeta+,");
        // Wait for the REAL modal, not App.tsx's Suspense fallback — the
        // fallback renders the same `.settings-modal` class with a spinner in
        // it, so waiting on the class alone measures the loading state.
        const modal = page.locator(".settings-modal-header");
        const present = await modal
          .waitFor({ state: "visible", timeout: 30_000 })
          .then(() => true)
          .catch(() => false);

        let measured = { error: "the Settings modal never opened" };
        if (present) {
          await page.waitForTimeout(900);
          measured = await page.evaluate(() => {
            const modalEl = globalThis.document.querySelector(".settings-modal");
            if (!modalEl) return { error: "no .settings-modal" };
            const viewport = { width: globalThis.innerWidth, height: globalThis.innerHeight };
            const rect = modalEl.getBoundingClientRect();
            const all = Array.from(modalEl.querySelectorAll("*"));

            // Every scroll container inside the modal.
            const scrollers = all.filter((el) => {
              const cs = globalThis.getComputedStyle(el);
              return (
                cs.overflowY === "auto" ||
                cs.overflowY === "scroll" ||
                cs.overflowX === "auto" ||
                cs.overflowX === "scroll"
              );
            });

            // Each scroller must be able to reach its own end.
            const stuckScrollers = [];
            for (const s of scrollers) {
              const before = s.scrollTop;
              s.scrollTop = s.scrollHeight;
              const reached = s.scrollTop >= s.scrollHeight - s.clientHeight - 1;
              s.scrollTop = before;
              if (!reached) {
                stuckScrollers.push({
                  className: typeof s.className === "string" ? s.className : "",
                  scrollHeight: s.scrollHeight,
                  clientHeight: s.clientHeight,
                });
              }
            }

            // Nothing may hide content that cannot be scrolled back into view.
            // The modal's own `overflow: hidden` is deliberate (it rounds the
            // corners), so it is checked here too rather than exempted.
            const clipped = [];
            for (const el of [modalEl, ...all]) {
              const cs = globalThis.getComputedStyle(el);
              const hides =
                ["hidden", "clip"].includes(cs.overflowY) ||
                ["hidden", "clip"].includes(cs.overflowX);
              if (!hides) continue;
              const overflowsY = el.scrollHeight > el.clientHeight + 1;
              const overflowsX = el.scrollWidth > el.clientWidth + 1;
              if (!overflowsY && !overflowsX) continue;
              // Reachable when a scroll container inside it, or one it sits
              // inside, can bring the overflow back into view.
              const reachable = scrollers.some((s) => s.contains(el) || el.contains(s));
              if (reachable) continue;
              clipped.push({
                tag: el.tagName.toLowerCase(),
                className: typeof el.className === "string" ? el.className : "",
                overflowY: cs.overflowY,
                overflowX: cs.overflowX,
                scrollHeight: el.scrollHeight,
                clientHeight: el.clientHeight,
                scrollWidth: el.scrollWidth,
                clientWidth: el.clientWidth,
              });
            }

            return {
              viewport,
              tier: globalThis.matchMedia("(min-width: 1280px)").matches
                ? "desktop"
                : globalThis.matchMedia("(max-width: 699.98px)").matches
                  ? "phone"
                  : "tablet",
              modal: {
                left: Math.round(rect.left),
                top: Math.round(rect.top),
                right: Math.round(rect.right),
                bottom: Math.round(rect.bottom),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
                scrollHeight: modalEl.scrollHeight,
                clientHeight: modalEl.clientHeight,
                overflowY: globalThis.getComputedStyle(modalEl).overflowY,
              },
              scrollers: scrollers.map((s) => ({
                className: typeof s.className === "string" ? s.className : "",
                scrollHeight: s.scrollHeight,
                clientHeight: s.clientHeight,
              })),
              stuckScrollers,
              clipped,
            };
          });
        }
        await page.close();

        if (measured.error) {
          regimes.push({ name: regime.name, viewport: regime.viewport, error: measured.error });
          continue;
        }
        const fitsViewport =
          measured.modal.left >= -1 &&
          measured.modal.top >= -1 &&
          measured.modal.right <= measured.viewport.width + 1 &&
          measured.modal.bottom <= measured.viewport.height + 1;
        regimes.push({
          name: regime.name,
          viewport: regime.viewport,
          tier: measured.tier,
          fitsViewport,
          stuckScrollers: measured.stuckScrollers,
          clipping: measured.clipped,
          measured,
        });
      }

      const failed = regimes.filter(
        (r) =>
          r.error ||
          !r.fitsViewport ||
          (r.stuckScrollers && r.stuckScrollers.length > 0) ||
          (r.clipping && r.clipping.length > 0),
      );
      const ok = regimes.length === ZOOM_200.length && failed.length === 0;

      return {
        status: ok ? "pass" : "fail",
        detail: ok
          ? `both 200%-zoom regimes fit their viewport and nothing inside the modal clips content`
          : failed
              .map(
                (r) =>
                  `${r.name}: ${r.error ?? `fitsViewport=${r.fitsViewport}, stuckScrollers=${r.stuckScrollers?.length ?? 0}, clipped=${r.clipping?.length ?? 0}`}`,
              )
              .join("; "),
        evidence: {
          note:
            "200% browser zoom is emulated by halving the CSS viewport (720x450 for a 1440x900 " +
            "window, 1280x720 for a 2560x1440 one) — Chromium's real browser zoom is not " +
            "settable from Playwright.",
          regimes: regimes.map((r) => ({
            name: r.name,
            viewport: r.viewport,
            tier: r.tier,
            error: r.error,
            fitsViewport: r.fitsViewport,
            stuckScrollers: r.stuckScrollers,
            clipping: r.clipping,
            measured: r.measured,
          })),
        },
      };
    },
  },

  {
    id: "C5",
    title: "a failed Dock kill is visibly reported on the row",
    async run({ browser, demo }) {
      // A project's Dock controls can come from its own `.crs/dock.json`, so
      // the check does not need a Docker daemon (the demo shadows `docker`
      // with a failing stub anyway). Resolve the project row from the API
      // rather than assuming the seed's path.
      const projects = await demo.api("/api/projects");
      const project = (projects ?? []).find((p) => p.name === "aurora-web");
      if (!project) {
        return { status: "fail", detail: "the demo has no aurora-web project", evidence: {} };
      }
      await mkdir(path.join(project.cwd, ".crs"), { recursive: true });
      await writeFile(
        path.join(project.cwd, ".crs", "dock.json"),
        JSON.stringify({ controls: [DOCK_CONTROL] }, null, 2),
      );

      // Kill confirmation off, so a single click reaches the kill path.
      await demo.api("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ sessions: { confirmBeforeKill: false } }),
      });

      // A running Dock session bound to the control by its command
      // (dockHelpers.ts's runningSessionFor matches on the command).
      //
      // It is deleted again in the `finally` below: the demo's teardown stops
      // systemd scopes, which macOS does not have, so a session this check
      // spawns would outlive the run and every re-run would leak another one.
      const created = await demo.api("/api/sessions", {
        method: "POST",
        body: JSON.stringify({
          projectId: project.id,
          command: DOCK_CONTROL.command,
          kind: "dock",
          name: DOCK_CONTROL.title,
          nameLocked: true,
        }),
      });

      try {
        return await runDockKillCheck({ browser, demo, project });
      } finally {
        // The empty body matters: `demo.api` sends a JSON content-type, and
        // Fastify rejects a JSON request with no body at all.
        await demo
          .api(`/api/sessions/${created.id}`, { method: "DELETE", body: "{}" })
          .catch(() => {});
      }
    },
  },
];

/** The C5 check proper — the Dock row's failed kill has to surface. */
async function runDockKillCheck({ browser, demo, project }) {
  const page = await browser.newPage({ viewport: DESKTOP });
  await openApp(page, demo, { waitForData: true });

  // Put the project into the Dock's own rail.
  const addProject = page.locator('[aria-label="Add project"]').first();
  await addProject.waitFor({ state: "visible", timeout: 15_000 });
  await addProject.click();
  const option = page.getByRole("option", { name: project.name, exact: true }).first();
  await option.waitFor({ state: "visible", timeout: 10_000 });
  await option.click();
  await page.waitForTimeout(2000);

  const toggle = page.locator(
    `[aria-label^="${DOCK_CONTROL.title} — click to stop log streaming"]`,
  );
  const toggleVisible = await toggle.count();
  if (!toggleVisible) {
    const dockText = await page
      .locator(".cmux-root")
      .innerText()
      .then((t) => t.slice(0, 600))
      .catch(() => "(unreadable)");
    await page.close();
    return {
      status: "fail",
      detail:
        "the Dock control row never appeared (the control is not shown as running) — " +
        "the kill path could not be exercised",
      evidence: { project: { id: project.id, cwd: project.cwd }, dockText },
    };
  }

  // Make the kill fail at the network boundary: the React component, the
  // store, the click handler and the status widget stay real.
  await page.route("**/api/sessions/*", async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "stubbed kill failure" }),
    });
  });

  await toggle.first().click();

  const status = page.locator(".dock-monitor-check-status");
  const appeared = await status
    .first()
    .waitFor({ state: "visible", timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  const appearedText = appeared ? ((await status.first().textContent()) ?? "").trim() : "";
  await page.waitForTimeout(2000);
  const visibleAfter2s = await status
    .first()
    .isVisible()
    .catch(() => false);
  await page.waitForTimeout(3500);
  const visibleAfter5_5s = await status
    .first()
    .isVisible()
    .catch(() => false);

  await page.close();

  const ok = appeared && /Failed to kill/.test(appearedText) && visibleAfter2s && !visibleAfter5_5s;
  return {
    status: ok ? "pass" : "fail",
    detail: ok
      ? `the failure was reported as "${appearedText}" and cleared itself after ~4s`
      : `appeared=${appeared} (${appearedText || "no status"}), visible after 2s=${visibleAfter2s}, ` +
        `visible after 5.5s=${visibleAfter5_5s}`,
    evidence: {
      control: DOCK_CONTROL,
      project: { id: project.id, cwd: project.cwd },
      appeared,
      appearedText,
      visibleAfter2s,
      visibleAfter5_5s,
      note:
        "The DELETE is stubbed to fail at the network boundary on purpose: this verifies " +
        "the UI contract (the failure is surfaced and the transient auto-clears), not the " +
        "backend's kill semantics — and it keeps the check runnable without a Docker daemon.",
    },
  };
}

function formatLine(result) {
  const status = result.status.toUpperCase().padEnd(4);
  return `[ui-verify] ${result.id} ${result.title} — ${status} ${result.detail ?? ""}`.trim();
}

async function writeReport(results, reportPath) {
  const target = path.resolve(reportPath);
  await mkdir(path.dirname(target), { recursive: true });
  // Write-then-rename, like capture-screenshots.mjs: an interrupted run never
  // leaves a half-written report behind.
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}`);
  await writeFile(tmp, JSON.stringify({ results }, null, 2));
  await rename(tmp, target);
}

// Validate --only before booting anything: a typo here would otherwise run
// nothing and exit 0 — a vacuous pass.
if (values.only && !CHECKS.some((c) => c.id === values.only)) {
  console.error(
    `[ui-verify] unknown check id "${values.only}" (expected one of ${CHECKS.map((c) => c.id).join(", ")})`,
  );
  process.exit(1);
}

await withDemo({
  startDemo: () => startDemo({ quiet: true, keep: values.keep }),
  launchBrowser: () => chromium.launch(),
  run: async (browser, demo, signal) => {
    const results = [];
    const selected = values.only ? CHECKS.filter((c) => c.id === values.only) : CHECKS;
    for (const check of selected) {
      if (signal.aborted) break;
      let outcome;
      try {
        outcome = await check.run({ browser, demo });
      } catch (err) {
        outcome = {
          status: "fail",
          detail: `the check threw: ${err.message}`,
          evidence: { stack: err.stack },
        };
      }
      const result = { id: check.id, title: check.title, ...outcome };
      results.push(result);
      console.log(formatLine(result));
    }

    await writeReport(results, values.report);
    const failed = results.filter((r) => r.status === "fail");
    console.log(
      `\n[ui-verify] ${results.length - failed.length}/${results.length} checks passed` +
        (failed.length ? ` — ${failed.map((f) => f.id).join(", ")} failed` : ""),
    );
    console.log(`[ui-verify] report written to ${path.resolve(values.report)}`);
    process.exitCode = failed.length > 0 ? 1 : 0;
  },
});
