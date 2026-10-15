import type { ComponentType, SVGProps } from "react";

export interface SidebarToolbarAction {
  key: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;
  onClick: () => void;
  disabled?: boolean;
}

// A row of compact icon buttons shared by every right-sidebar view, so the
// toolbars line up and match the drawer header's own icon buttons.
export function SidebarToolbar({ actions }: { actions: SidebarToolbarAction[] }) {
  return (
    <div className="right-sidebar-toolbar" role="toolbar">
      {actions.map(({ key, label, icon: Icon, onClick, disabled }) => (
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
        </button>
      ))}
    </div>
  );
}
