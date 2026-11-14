import { useContext, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { SidebarDetailSlotContext } from "./detailSlot.js";
import { ChevronLeftIcon } from "../icons.js";
import { IconButton } from "./IconButton.js";
import { ViewHeader, type ViewHeaderProps } from "./ViewHeader.js";

export interface DetailHeaderProps extends Omit<ViewHeaderProps, "leading" | "bare"> {
  onBack: () => void;
  backLabel?: string;
}

/** ViewHeader for a pushed in-sidebar detail view: back chevron + same slots.
 * In the right-sidebar drawer it takes over the header row (the detail slot)
 * instead of stacking a second bar under it. */
export function DetailHeader({ onBack, backLabel = "Back", ...rest }: DetailHeaderProps) {
  const slot = useContext(SidebarDetailSlotContext);
  // #2979 — marks the panel (the header row's parent, which also holds the
  // phone's head and the strip) while this header fills the slot, so the CSS
  // that swaps the picker, toolbar, strip and phone head for it does not need
  // `:has()`. React runs every layout-effect cleanup before the next mount's
  // setup, so one detail replacing another never leaves the mark off.
  useLayoutEffect(() => {
    const panel = slot?.parentElement?.parentElement;
    if (!panel) return;
    panel.setAttribute("data-sidebar-detail", "");
    return () => panel.removeAttribute("data-sidebar-detail");
  }, [slot]);
  const header = (
    <ViewHeader
      {...rest}
      bare={slot !== null}
      leading={
        <IconButton label={backLabel} onClick={onBack}>
          <ChevronLeftIcon size={14} />
        </IconButton>
      }
    />
  );
  return slot ? createPortal(header, slot) : header;
}
