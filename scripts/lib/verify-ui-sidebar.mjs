// Helpers for verify-ui's C2 (scripts/verify-ui-runtime.mjs) and the shell
// steps the redesign moved (theme, pinning a project). Split out of that file,
// which is held to a size ceiling.

const FOCUSABLE =
  "button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex='-1'])";

/** Press Tab `presses` times from the document start; count landings inside `selector`. */
export async function tabWalk(page, selector, presses = 30) {
  await page.evaluate(() => globalThis.document.activeElement?.blur());
  let inside = 0;
  const outside = new Set();
  for (let i = 0; i < presses; i++) {
    await page.keyboard.press("Tab");
    const where = await page.evaluate((sel) => {
      const el = globalThis.document.activeElement;
      const root = globalThis.document.querySelector(sel);
      return { in: !!root && root.contains(el), key: `${el?.tagName}.${el?.className}` };
    }, selector);
    if (where.in) inside++;
    else outside.add(where.key);
  }
  return { inside, distinctOutside: outside.size };
}

/** Ask the first focusable descendant of `selector` to take focus. */
export const tryFocusInside = (page, selector) =>
  page.locator(selector).evaluate((el, focusable) => {
    const candidate = el.querySelector(focusable);
    if (!candidate) return { found: false, focused: false };
    candidate.focus();
    return { found: true, focused: globalThis.document.activeElement === candidate };
  }, FOCUSABLE);

const inertOf = (page, selector) =>
  page.locator(selector).evaluate((el) => ({
    property: el.inert === true,
    attribute: el.hasAttribute("inert"),
  }));

/**
 * The docked sidebar, collapsed (the default from 1100 to 1279px). App.tsx
 * makes it `inert`, but styles/sidebar.css ALSO sets `visibility: hidden` on
 * it, and a hidden element is not focusable either, so on its own the Tab walk
 * would stay green with `inert` removed. This probe therefore overrides
 * `visibility` first, which leaves `inert` as the only guard, and then proves
 * it can fail: it removes `inert` in the page and expects focus to get in.
 */
export async function probeCollapsedSidebar(page) {
  const sel = ".sidebar-wrapper";
  const inert = await inertOf(page, sel);
  await page.addStyleTag({ content: `${sel}{visibility:visible !important}` });
  const walk = await tabWalk(page, sel);
  const focusWhileCollapsed = await tryFocusInside(page, sel);
  await page.locator(sel).evaluate((el) => (el.inert = false));
  const control = await tryFocusInside(page, sel);
  return { inert, walk, focusWhileCollapsed, controlFocusWithoutInert: control };
}

/**
 * Show the sidebar through the rail's `[data-toggle-sidebar]` button and prove
 * it is reachable by Tabbing from a control OUTSIDE it (the button itself).
 * `aria-pressed` is read, not blind-clicked, and must end "true".
 */
export async function openSidebarAndTab(page, toggle) {
  const pressedBefore = await toggle.getAttribute("aria-pressed");
  if (pressedBefore !== "true") await toggle.click();
  await page.waitForTimeout(800);
  const pressedAfter = await toggle.getAttribute("aria-pressed");
  const inert = await inertOf(page, ".sidebar-wrapper");
  await toggle.focus();
  let presses = 0;
  let reached = false;
  while (!reached && presses < 80) {
    await page.keyboard.press("Tab");
    presses++;
    reached = await page.evaluate(
      () =>
        !!globalThis.document
          .querySelector(".sidebar-wrapper")
          ?.contains(globalThis.document.activeElement),
    );
  }
  return { pressedBefore, pressedAfter, inert, reached, presses };
}

/** Settings → Appearance → Light: the theme has no top-bar button any more. */
export async function switchToLight(page) {
  await page.locator('.left-rail [aria-label="Settings"]').first().click();
  await page.locator(".settings-nav-item", { hasText: "Appearance" }).click();
  await page.getByRole("radio", { name: "Light", exact: true }).click();
}

/**
 * Since #1877 the sidebar tree lists only projects tiled in the active
 * workspace or pinned to the Dock, and the demo's workspace starts with
 * nothing tiled: pin one from the Dock, as a user would, or the tree is just
 * an empty state and the checks measure nothing. Returns the row locator.
 */
export async function pinProjectIfTreeEmpty(page) {
  const row = page.locator(".project-row-name").first();
  if (!(await row.isVisible().catch(() => false))) {
    const add = page.locator('[aria-label="Add project"]').first();
    await add.waitFor({ state: "visible", timeout: 30_000 });
    if (await add.isEnabled()) {
      await add.click();
      await page.getByRole("option").first().click();
    }
  }
  return row;
}

/**
 * Put a project into the Dock's own rail. `pinProjectIfTreeEmpty` may already
 * have pinned it, in which case its option is gone from the "+ Add project"
 * list because it is in the rail.
 */
export async function pinProjectInDock(page, name) {
  const add = page.locator('[aria-label="Add project"]').first();
  await add.waitFor({ state: "visible", timeout: 15_000 });
  // Disabled when every project is already in the rail (a one-project demo).
  if (!(await add.isEnabled())) return;
  await add.click();
  const option = page.getByRole("option", { name, exact: true }).first();
  if (
    await option.waitFor({ state: "visible", timeout: 3_000 }).then(
      () => true,
      () => false,
    )
  ) {
    await option.click();
  } else {
    await page.keyboard.press("Escape");
  }
}
