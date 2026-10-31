import { useContext } from "react";
import type { ComponentType, SVGProps } from "react";
import { createPortal } from "react-dom";
import { SidebarToolbarSlotContext } from "./sidebarToolbarSlot.js";

export interface SidebarToolbarAction {
  key: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;
  onClick: () => void;
  disabled?: boolean;
  /** Small status dot on the corner (e.g. clone health). */
  dot?: "success" | "warn" | "danger";
}

// A row of compact icon buttons shared by every right-sidebar view, so the
// toolbars line up and match the drawer header's own icon buttons.
export function SidebarToolbar({ actions }: { actions: SidebarToolbarAction[] }) {
  const slot = useContext(SidebarToolbarSlotContext);
  const toolbar = (
    <div className="right-sidebar-toolbar" role="toolbar">
      {actions.map(({ key, label, icon: Icon, onClick, disabled, dot }) => (
        <button
          key={key}
          type="button"
          className="right-sidebar-icon-btn"
          aria-label={label}
          title={label}
          disabled={disabled}
          onClick={onClick}
        >
          <Icon size={14} />
          {dot && <span className={`sb-ibtn-dot sb-ibtn-dot--${dot}`} aria-hidden="true" />}
        </button>
      ))}
    </div>
  );
  return slot ? createPortal(toolbar, slot) : toolbar;
}
