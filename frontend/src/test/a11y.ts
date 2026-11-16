import { expect } from "vitest";

// Test-side versions of two axe rules the visual check reports (#2886), for
// the controls whose markup a unit test can pin.

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");

// label-content-name-mismatch (WCAG 2.5.3): the visible text, whitespace
// collapsed and without punctuation, is a run of whole words of the accessible
// name. aria-hidden text counts, as it does for axe: it is still what a
// voice-control user reads off the screen. Text drawn by CSS does not.
export function expectNameHasVisibleText(el: HTMLElement) {
  const visible = words(el.textContent ?? "");
  const name = words(el.getAttribute("aria-label") ?? el.textContent ?? "");
  expect(` ${name} `).toContain(` ${visible} `);
}

const INTERACTIVE =
  'button, a[href], input, select, textarea, [role="button"], [tabindex]:not([tabindex="-1"])';

// nested-interactive: no control inside another control.
export function expectNoNestedInteractive(root: HTMLElement) {
  const nested = Array.from(root.querySelectorAll<HTMLElement>(INTERACTIVE)).filter((el) =>
    el.parentElement?.closest(INTERACTIVE),
  );
  expect(nested.map((el) => el.outerHTML)).toEqual([]);
}
