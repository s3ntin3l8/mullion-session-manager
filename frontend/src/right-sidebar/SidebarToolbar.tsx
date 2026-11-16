import { useContext } from "react";
import type { ComponentType, ReactNode, SVGProps } from "react";
import { createPortal } from "react-dom";
import { SidebarToolbarSlotContext } from "./sidebarToolbarSlot.js";

export interface SidebarToolbarAction {
  key: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;
  onClick: () => void;
  disabled?: boolean;
  /** A request is in flight: the button is `aria-busy` / `aria-disabled` (it keeps focus; clicks are ignored) and its icon spins. */
  busy?: boolean;
  /** Small status dot on the corner (e.g. clone health). */
  dot?: "success" | "warn" | "danger";
}

// A row of compact icon buttons shared by every right-sidebar view, so the
// toolbars line up and match the drawer header's own icon buttons.
export function SidebarToolbar({
  actions,
  trailing,
}: {
  actions: SidebarToolbarAction[];
  /** Rendered at the end of the same bar (e.g. a ⋯ menu), so the order is JSX order. */
  trailing?: ReactNode;
}) {
  const slot = useContext(SidebarToolbarSlotContext);
  const toolbar = (
    <div className="right-sidebar-toolbar" role="toolbar">
      {actions.map(({ key, label, icon: Icon, onClick, disabled, busy, dot }) => (
        <button
          key={key}
          type="button"
          className={`right-sidebar-icon-btn${busy ? " is-busy" : ""}`}
          aria-label={label}
          aria-busy={busy || undefined}
          title={label}
          disabled={disabled}
          aria-disabled={busy || undefined}
          onClick={busy ? undefined : onClick}
        >
          <Icon size={14} />
          {dot && <span className={`sb-ibtn-dot sb-ibtn-dot--${dot}`} aria-hidden="true" />}
        </button>
      ))}
      {trailing}
    </div>
  );
  return slot ? createPortal(toolbar, slot) : toolbar;
}
