import { useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { KebabMenu, type KebabMenuItem } from "../ui/KebabMenu.js";
import { SidebarStripSlotContext, SidebarToolbarSlotContext } from "./sidebarToolbarSlot.js";
import { SidebarToolbar, type SidebarToolbarAction } from "./SidebarToolbar.js";

export interface SidebarHeaderProps {
  /** The view's name, shown in the strip under the header row. */
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
// into the drawer's header row (next to the project picker) and a context strip
// goes under it. Outside the drawer there are no slots, so both render inline.
export function SidebarHeader({
  label,
  context,
  contextTitle,
  actions = [],
  overflow = [],
}: SidebarHeaderProps) {
  const toolbarSlot = useContext(SidebarToolbarSlotContext);
  const stripSlot = useContext(SidebarStripSlotContext);
  const strip = (
    <div className="sb-strip">
      <b>{label}</b>
      {context != null && <span title={contextTitle}>{context}</span>}
    </div>
  );
  const buttons = (
    <>
      {actions.length > 0 && <SidebarToolbar actions={actions} />}
      {overflow.length > 0 && (
        <span className="right-sidebar-overflow">
          <KebabMenu items={overflow} title="More actions" />
        </span>
      )}
    </>
  );
  return (
    <>
      {toolbarSlot ? createPortal(buttons, toolbarSlot) : buttons}
      {stripSlot ? createPortal(strip, stripSlot) : strip}
    </>
  );
}
