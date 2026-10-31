import { useContext } from "react";
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
