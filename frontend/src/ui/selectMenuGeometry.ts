import { visibleViewport } from "../hooks/useVisualViewportChange.js";

// Where SelectMenu's list sits and how wide it may be (#2495, #3245). Kept
// apart from the component so the geometry can be tested on its own.
// The menu's own minimum width (the `.custom-select-menu` CSS floor). A menu
// narrower than this cannot show a readable label.
export const MENU_MIN_WIDTH = 140;
// How far the menu keeps away from the viewport edges.
const MENU_VIEWPORT_MARGIN = 8;
// The option labels are set in a 12px UI font (`.custom-select-item`), so a
// character averages ~6.5px — close enough to turn the menu's pixel width
// into a character budget for the middle-ellipsis. The CSS end-ellipsis
// stays as the fallback for a label that turns out wider than this estimate.
export const LABEL_CHAR_WIDTH_PX = 6.5;
// The room the label text gets inside the menu: the option's own 10px
// padding a side, plus the menu's 4px padding and 1px border a side.
export const LABEL_CHROME_PX = 30;
// Never truncate a label below this many characters — a stub is worse than a
// label the CSS ellipsis clips a little.
export const LABEL_MIN_CHARS = 12;
// For `placement="auto"`: the height an option row takes (`.custom-select-item`,
// 6px padding a side around a 12px line) and the menu's own chrome, so the
// list's height can be told before it renders. An estimate is enough: it
// only decides which side has the room.
const OPTION_ROW_PX = 27;
const MENU_CHROME_PX = 10;
// The tallest the list is drawn when there is room for more (the
// `.custom-select-menu` stylesheet value), past which it scrolls.
const MENU_PREFERRED_MAX_PX = 220;

// Where the menu may sit for a trigger at `rect`, and how wide it may be.
//
// Issue #2495 — the menu used to be sized by its content alone (a long
// branch name made it as wide as the name), so a right-aligned menu ran off
// the LEFT edge of the screen and its labels were clipped on that side.
// Capping the width to the room the menu actually has keeps it on screen;
// when the preferred side cannot even fit the menu's minimum width, the
// alignment flips to the side that has room.
interface MenuGeometry {
  align: "left" | "right";
  maxWidth: number;
}

export function computeMenuGeometry(
  rect: DOMRect | null,
  menuAlign: "left" | "right",
): MenuGeometry | null {
  if (!rect) return null;
  const viewportWidth = window.innerWidth;
  // The room on each side of the trigger, measured to the viewport edge: a
  // left-aligned menu grows to the RIGHT of the trigger, a right-aligned one
  // to its LEFT.
  const roomRight = viewportWidth - MENU_VIEWPORT_MARGIN - rect.left;
  const roomLeft = rect.right - MENU_VIEWPORT_MARGIN;
  const preferRight = menuAlign === "right";
  let align: "left" | "right" = preferRight ? "right" : "left";
  let room = preferRight ? roomLeft : roomRight;
  const otherRoom = preferRight ? roomRight : roomLeft;
  if (room < MENU_MIN_WIDTH && otherRoom > room) {
    align = preferRight ? "left" : "right";
    room = otherRoom;
  }
  return {
    align,
    // Never wider than the room it has, so it cannot reach past the
    // viewport edge on the side it opens toward.
    maxWidth: Math.max(0, Math.min(room, viewportWidth - MENU_VIEWPORT_MARGIN * 2)),
  };
}

// "auto" (#3245) opens below the trigger when the list fits there, and
// otherwise on whichever side has more room — so a dropdown near the bottom
// of a dialog opens upward instead of running off the screen.
export function resolvePlacement(
  rect: DOMRect,
  placement: "top" | "bottom" | "auto",
  rowCount: number,
): "top" | "bottom" {
  if (placement !== "auto") return placement;
  const visible = visibleViewport();
  const below = visible.bottom - rect.bottom - MENU_VIEWPORT_MARGIN;
  const above = rect.top - visible.top - MENU_VIEWPORT_MARGIN;
  const wanted = Math.min(MENU_PREFERRED_MAX_PX, rowCount * OPTION_ROW_PX + MENU_CHROME_PX);
  return below >= wanted || below >= above ? "bottom" : "top";
}
