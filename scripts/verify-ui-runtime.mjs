#!/usr/bin/env node
/**
 * Real-browser verification of the five runtime checks the UI/UX audit
 * (docs/ui-ux-audit.md) owed.
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
 *       over a surface)
 *   C4  whether the 1040x720 Settings modal clips content at 200% zoom
 *   C5  that a failed Dock kill is visibly reported on the row (PR2's
 *       `showCheckStatus` change)
 *
 *   make verify-ui
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

  /**
   * Parse a computed colour.
   *
   * The `color(srgb …)` form matters: Chromium reports a `color-mix()` with
   * `transparent` — which is exactly how every tinted and hovered surface in
   * this app is written — as `color(srgb 0.929412 0.929412 0.929412 / 0.09)`,
   * NOT as `rgba()`. A parser that only understands `rgb()`/`rgba()` silently
   * drops every one of those layers and measures the plain surface behind
   * them, which is the very gap this check exists to close.
   */
  const parseColor = (value) => {
    if (!value) return null;
    const v = value.trim().toLowerCase();
    if (v === "transparent") return null;
    let m = /^rgba?\(([^)]+)\)$/.exec(v);
    if (m) {
      const parts = m[1]
        .split(/[\s,/]+/)
        .filter(Boolean)
        .map(Number);
      if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN)) return null;
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
    }
    m = /^color\(srgb\s+([^)]+)\)$/.exec(v);
    if (m) {
      const parts = m[1]
        .split(/[\s/]+/)
        .filter(Boolean)
        .map(Number);
      if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN)) return null;
      return {
        r: Math.round(parts[0] * 255),
        g: Math.round(parts[1] * 255),
        b: Math.round(parts[2] * 255),
        a: parts.length > 3 ? parts[3] : 1,
      };
    }
    m = /^#([0-9a-f]{6})$/.exec(v);
    if (m) {
      const n = parseInt(m[1], 16);
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
    }
    return null;
  };

  const over = (fg, bg) => {
    const a = fg.a + bg.a * (1 - fg.a);
    if (a <= 0) return { r: 255, g: 255, b: 255, a: 0 };
    return {
      r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a,
      g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a,
      b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a,
      a,
    };
  };

  const luminance = (c) => {
    const f = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };

  const contrast = (a, b) => {
    const l1 = luminance(a);
    const l2 = luminance(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };

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

  /** The background actually painted behind `el`, composited layer by layer. */
  const effectiveBackground = (el) => {
    const layers = [];
    let hasImage = false;
    let node = el;
    while (node) {
      const cs = globalThis.getComputedStyle(node);
      const c = parseColor(cs.backgroundColor);
      if (c && c.a > 0) layers.push(c);
      if (cs.backgroundImage && cs.backgroundImage !== "none") {
        hasImage = true;
        break;
      }
      node = node.parentElement;
    }
    // layers[0] is the innermost (painted on top).
    let baseIdx = -1;
    for (let i = layers.length - 1; i >= 0; i--) {
      if (layers[i].a >= 0.999) {
        baseIdx = i;
        break;
      }
    }
    let current = baseIdx >= 0 ? layers[baseIdx] : { r: 255, g: 255, b: 255, a: 1 };
    const start = baseIdx >= 0 ? baseIdx - 1 : layers.length - 1;
    for (let i = start; i >= 0; i--) current = over(layers[i], current);
    return { color: current, hasImage, layerCount: layers.length };
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

  /** The threshold WCAG asks for, by what the sample paints. */
  const thresholdFor = (kind) => (kind === "text" ? 4.5 : 3);

  globalThis.__uiVerifyDim = {
    dimColor,
    /** Mark every rendered `--dim` element with a stable id. */
    mark() {
      globalThis.document
        .querySelectorAll("[data-ui-verify-dim], [data-ui-verify-hover], [data-ui-verify-token]")
        .forEach((el) => {
          el.removeAttribute("data-ui-verify-dim");
          el.removeAttribute("data-ui-verify-hover");
          el.removeAttribute("data-ui-verify-token");
        });
      const hoverTargets = new Map();
      const elements = Array.from(globalThis.document.querySelectorAll("*")).filter(
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
      return {
        dimColor,
        marked: elements.length,
        hoverTargets: [...hoverTargets.entries()].map(([el, id]) => ({ id, path: cssPath(el) })),
      };
    },
    /** Measure the marked elements in their CURRENT painted state. */
    measure() {
      const samples = [];
      for (const el of globalThis.document.querySelectorAll("[data-ui-verify-dim]")) {
        const id = Number(el.getAttribute("data-ui-verify-dim"));
        const bg = effectiveBackground(el);
        const fg = parseColor(globalThis.getComputedStyle(el).color);
        const alpha = effectiveOpacity(el);
        const kind = sampleKind(el);
        // A deliberate fade (opacity < 1) is the design's own de-emphasis —
        // the element returns to full opacity when the user engages with it,
        // and that fully-opaque state is the one that carries its meaning. So
        // a faded element is judged on its unfaded colour; an unfaded element
        // is judged exactly as painted.
        const judgeAlpha = alpha < 1 ? 1 : alpha;
        const rendered = fg ? over({ ...fg, a: judgeAlpha }, bg.color) : null;
        samples.push({
          id,
          kind,
          threshold: thresholdFor(kind),
          token: el.getAttribute("data-ui-verify-token") ?? "--dim",
          path: cssPath(el),
          text: (el.textContent || "").trim().slice(0, 40),
          color: globalThis.getComputedStyle(el).color,
          opacity: Math.round(alpha * 100) / 100,
          foregroundResolved: fg !== null,
          background: `rgb(${Math.round(bg.color.r)}, ${Math.round(bg.color.g)}, ${Math.round(bg.color.b)})`,
          backgroundLayers: bg.layerCount,
          ratio: rendered ? Math.round(contrast(rendered, bg.color) * 100) / 100 : null,
          hasImage: bg.hasImage,
        });
      }
      return samples;
    },
    clear() {
      globalThis.document
        .querySelectorAll("[data-ui-verify-dim], [data-ui-verify-hover], [data-ui-verify-token]")
        .forEach((el) => {
          el.removeAttribute("data-ui-verify-dim");
          el.removeAttribute("data-ui-verify-hover");
          el.removeAttribute("data-ui-verify-token");
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

      /**
       * Measure the current DOM. The hover sweep re-measures with each hover
       * target hovered, so a `:hover` rule that repaints the background is
       * measured as painted, not as authored.
       */
      const measure = async (themeName, scopeName) => {
        const installed = await page.evaluate(installDimHelpers);
        if (!installed) {
          return {
            theme: themeName,
            scope: scopeName,
            error: "no .cmux-root in the DOM",
            samples: [],
          };
        }
        const marked = await page.evaluate(() => globalThis.__uiVerifyDim.mark());
        const base = await page.evaluate(() => globalThis.__uiVerifyDim.measure());
        const byId = new Map(base.map((s) => [s.id, s]));

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
          // Re-measure the SAME marked elements, so the id still identifies
          // the same element even if the DOM shifted while hovering.
          const after = await page.evaluate(() => globalThis.__uiVerifyDim.measure());
          for (const sample of after) {
            const known = byId.get(sample.id);
            if (!known || known.ratio === null || sample.ratio === null) continue;
            if (sample.ratio < known.ratio) {
              known.hoverRatio = sample.ratio;
              known.hoverBackground = sample.background;
            }
          }
        }
        await page.evaluate(() => globalThis.__uiVerifyDim.clear());

        const samples = base.map((s) => ({
          ...s,
          hoverRatio: s.hoverRatio ?? null,
          hoverBackground: s.hoverBackground ?? null,
          worstRatio: s.ratio === null ? null : Math.min(s.ratio, s.hoverRatio ?? s.ratio),
        }));
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
        };
      };

      const themeButton = page.locator(".toolbar-theme-btn");

      for (const theme of ["dark", "light"]) {
        if (theme === "light") {
          await themeButton.first().click();
          await page
            .locator(".cmux-root.light")
            .waitFor({ state: "attached", timeout: 10_000 })
            .catch(() => {});
          await page.waitForTimeout(700);
        }
        // Scope 1: the app's own chrome (sidebar, dock, panes).
        scopes.push(await measure(theme, "app"));

        // Scope 2: the command palette — the densest source of `--dim` over
        // TINTED surfaces (the accent-tinted target strip and the project
        // picker) and of hovered rows (`.cmd-row:hover`).
        await page.keyboard.press("ControlOrMeta+k");
        await page.locator(".cmd-palette").waitFor({ state: "visible", timeout: 15_000 });
        await page.waitForTimeout(700);
        scopes.push(await measure(theme, "command palette"));
        await page.keyboard.press("Escape");
        await page.locator(".cmd-palette").waitFor({ state: "detached", timeout: 10_000 });
        await page.waitForTimeout(400);
      }

      await page.close();

      const failures = scopes.flatMap((t) =>
        t.samples
          .filter(
            (s) =>
              s.worstRatio !== null && s.worstRatio < s.threshold && s.kind !== null && !s.hasImage,
          )
          .map((s) => ({ ...s, theme: t.theme, scope: t.scope })),
      );
      const notMeasurable = scopes.flatMap((t) =>
        t.samples.filter((s) => s.hasImage).map((s) => ({ ...s, theme: t.theme, scope: t.scope })),
      );
      const measured = scopes.reduce((n, t) => n + t.total, 0);
      const unresolved = scopes.reduce((n, t) => n + t.unresolvedForeground, 0);
      // A check that cannot resolve the foreground colour is measuring
      // nothing — fail loudly rather than reporting a bogus constant ratio.
      const ok = failures.length === 0 && measured > 0 && unresolved === 0;

      return {
        status: ok ? "pass" : "fail",
        detail: ok
          ? `${measured} text-role samples across ${scopes.length} scope/theme combinations, all clear of their WCAG threshold`
          : unresolved > 0
            ? `${unresolved} samples had an unresolvable foreground colour — the measurement is not trustworthy`
            : `${failures.length} of ${measured} text-role samples fall below their WCAG threshold ` +
              `(worst ${Math.min(...failures.map((f) => f.worstRatio))}:1)`,
        evidence: {
          thresholds: { text: 4.5, graphics: 3 },
          measured,
          unresolvedForeground: unresolved,
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
              .filter((s) => s.worstRatio !== null)
              .sort((a, b) => a.worstRatio - b.worstRatio)
              .slice(0, 8)
              .map((s) => ({
                path: s.path,
                text: s.text,
                kind: s.kind,
                threshold: s.threshold,
                ratio: s.ratio,
                hoverRatio: s.hoverRatio,
                opacity: s.opacity,
                background: s.background,
                hoverBackground: s.hoverBackground,
              })),
            samples: (t.samples ?? []).map((s) => ({
              path: s.path,
              text: s.text,
              kind: s.kind,
              threshold: s.threshold,
              ratio: s.ratio,
              hoverRatio: s.hoverRatio,
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
            hoverRatio: f.hoverRatio,
            opacity: f.opacity,
            background: f.background,
            hoverBackground: f.hoverBackground,
          })),
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
