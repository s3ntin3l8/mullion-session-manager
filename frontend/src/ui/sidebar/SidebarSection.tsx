import { useState, type ReactNode } from "react";
import { STORAGE_KEYS, writeJSON } from "../../lib/persistedState.js";
import { readAllSections, readPersistedSection } from "./sectionState.js";
import { ChevronDownIcon } from "../icons.js";

export interface SidebarSectionProps {
  title: string;
  count?: number;
  /** Right-aligned header slot (links, icon buttons); not part of the toggle. */
  actions?: ReactNode;
  /** Persist open/closed under this id in localStorage. */
  persistKey?: string;
  defaultOpen?: boolean;
  /** Controlled mode: when `open` is given the section does not manage itself. */
  open?: boolean;
  onToggle?: (open: boolean) => void;
  children: ReactNode;
}

export function SidebarSection({
  title,
  count,
  actions,
  persistKey,
  defaultOpen = true,
  open: controlled,
  onToggle,
  children,
}: SidebarSectionProps) {
  const [own, setOwn] = useState(() => readPersistedSection(persistKey, defaultOpen));
  const open = controlled ?? own;
  const toggle = () => {
    const next = !open;
    if (controlled === undefined) setOwn(next);
    if (persistKey) {
      writeJSON(STORAGE_KEYS.sidebarKitSections, { ...readAllSections(), [persistKey]: next });
    }
    onToggle?.(next);
  };
  return (
    <section className="sb-sec">
      <div className="sb-sec-h">
        <button type="button" className="sb-sec-toggle" aria-expanded={open} onClick={toggle}>
          <ChevronDownIcon size={12} className={open ? "sb-chev" : "sb-chev sb-chev--closed"} />
          <span className="sb-sec-name">{title}</span>
          {count !== undefined && count > 0 && <span className="sb-count">{count}</span>}
        </button>
        {actions != null && <div className="sb-sec-actions">{actions}</div>}
      </div>
      {open && <div className="sb-sec-body">{children}</div>}
    </section>
  );
}
