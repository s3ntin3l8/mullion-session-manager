import { useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { KebabMenu, type KebabMenuItem } from "../ui/KebabMenu.js";
import { SidebarPhoneContext, SidebarStripSlotContext } from "./sidebarToolbarSlot.js";
import { SidebarToolbar, type SidebarToolbarAction } from "./SidebarToolbar.js";

export interface SidebarHeaderProps {
  /** The view's name, shown in the strip under the header row (not on the
   * phone, whose head names the view already). */
  label: string;
  /** What the view is showing: a branch, a PR count, the worktree root. */
  context?: ReactNode;
  /** Full text for the context's tooltip, when the strip may truncate it. */
  contextTitle?: string;
  /** Up to three primary icon buttons in the header row. */
  actions?: SidebarToolbarAction[];
  /** Everything else, behind a ⋯ menu at the end of the row. */
  overflow?: KebabMenuItem[];
}

// The one header every right-sidebar view uses: its icon buttons and ⋯ menu go
// into the drawer's header row (next to the project picker, via SidebarToolbar's
// own slot portal) and a context strip goes under it. Outside the drawer there
// are no slots, so both render inline. On the phone the view's head names it
// (#3216), so the strip carries only the context, and is left out without one.
export function SidebarHeader({
  label,
  context,
  contextTitle,
  actions = [],
  overflow = [],
}: SidebarHeaderProps) {
  const stripSlot = useContext(SidebarStripSlotContext);
  const phone = useContext(SidebarPhoneContext);
  const strip =
    phone && context == null ? null : (
      <div className="sb-strip">
        {!phone && <b>{label}</b>}
        {context != null && <span title={contextTitle}>{context}</span>}
      </div>
    );
  const toolbar =
    actions.length > 0 || overflow.length > 0 ? (
      <SidebarToolbar
        actions={actions}
        trailing={
          overflow.length > 0 ? (
            <span className="right-sidebar-overflow">
              <KebabMenu items={overflow} title="More actions" />
            </span>
          ) : undefined
        }
      />
    ) : null;
  return (
    <>
      {toolbar}
      {strip && stripSlot ? createPortal(strip, stripSlot) : strip}
    </>
  );
}
