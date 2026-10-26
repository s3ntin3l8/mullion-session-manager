import { useState, type ReactNode } from "react";
import { STORAGE_KEYS, readJSON, writeJSON } from "../../lib/persistedState.js";
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

type Persisted = Record<string, boolean>;

function readPersisted(key: string | undefined, fallback: boolean): boolean {
  if (!key) return fallback;
  const stored = readJSON<Persisted>(STORAGE_KEYS.sidebarKitSections, {})[key];
  return typeof stored === "boolean" ? stored : fallback;
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
  const [own, setOwn] = useState(() => readPersisted(persistKey, defaultOpen));
  const open = controlled ?? own;
  const toggle = () => {
    const next = !open;
    if (controlled === undefined) setOwn(next);
    if (persistKey) {
      const all = readJSON<Persisted>(STORAGE_KEYS.sidebarKitSections, {});
      writeJSON(STORAGE_KEYS.sidebarKitSections, { ...all, [persistKey]: next });
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
