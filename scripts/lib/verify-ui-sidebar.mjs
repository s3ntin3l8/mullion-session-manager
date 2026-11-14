// The desktop half of verify-ui's C2 (scripts/verify-ui-runtime.mjs): show the
// sidebar through the left rail's button and measure that it is reachable.
// Also the shell steps the redesign moved (theme, pinning a project).
// Split out of that file, which is held to a size ceiling.

/**
 * `toggle` is the rail's `[data-toggle-sidebar]` button. It is read, not
 * blind-clicked: the sidebar may already be shown, and the step is only
 * done when `aria-pressed` is "true".
 */
export async function showDesktopSidebar(page, toggle) {
  const pressedBefore = await toggle.getAttribute("aria-pressed");
  if (pressedBefore !== "true") await toggle.click();
  await page.waitForTimeout(800);
  const pressedAfter = await toggle.getAttribute("aria-pressed");
  const drawer = page.locator(".sidebar-wrapper");
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
    for (let i = 0; i < 40 && !reachedWhenOpen; i++) {
      await page.keyboard.press("Tab");
      reachedWhenOpen = await drawer.evaluate((el) =>
        el.contains(globalThis.document.activeElement),
      );
    }
  }
  return { pressedBefore, pressedAfter, openedState, focusWhenOpen, reachedWhenOpen };
}

/** Settings → Appearance → Light: the theme has no top-bar button any more. */
export async function switchToLight(page) {
  await page.locator('.left-rail [title^="Settings"]').first().click();
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
    await add.click();
    await page.getByRole("option").first().click();
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
