import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useDashboardStore } from "./store.js";
import { OverflowIcon } from "./icons.js";

// Generic ⋯ trigger + portaled dropdown, extracted from PaneTab.tsx's own
// overflow menu (Phase 4b/4c) so group/workspace/project rows get the same
// pattern instead of three hand-rolled portals: position:fixed computed from
// the trigger's own getBoundingClientRect() (sidesteps whatever ancestor
// clips overflow — dockview's tab strip there, the sidebar's own scroll
// container here), an outside-click listener comparing against both the
// trigger and the menu's own ref, and — the load-bearing detail from the
// Phase 4c follow-up fix — the portaled node reapplies the `cmux-root`/
// `light` theme classes, since portaling to document.body escapes the
// `.cmux-root` subtree where every `--chrome`/`--border`/`--fg` custom
// property is actually defined. Fixing that once here means it can't be
// reintroduced per-consumer the way it originally was in PaneTab alone.
//
// PaneTab.tsx itself is deliberately NOT migrated to this component this
// pass — it already works, no reason to churn it.
const ARM_MS = 3000;

export interface KebabMenuItem {
  key: string;
  label: string;
  // Shown in place of `label` once armed (e.g. "Click again to delete").
  // Only meaningful together with `confirm: true`.
  armLabel?: string;
  icon?: ReactNode;
  onClick: () => void;
  danger?: boolean;
  // Requires a first click to arm (matching PaneTab's kill-session /
  // ConfirmButton's own 3s arm window) before a second click fires it.
  confirm?: boolean;
  disabled?: boolean;
}

export function KebabMenu({ items, title = "More…" }: { items: KebabMenuItem[]; title?: string }) {
  const theme = useDashboardStore((s) => s.theme);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const [armedKey, setArmedKey] = useState<string | null>(null);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(
    () => () => {
      if (armTimer.current) clearTimeout(armTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (!open) return;
    const onOutsideClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (btnRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
      setArmedKey(null);
    };
    document.addEventListener("mousedown", onOutsideClick);
    return () => document.removeEventListener("mousedown", onOutsideClick);
  }, [open]);

  const handleItemClick = (item: KebabMenuItem) => {
    if (item.disabled) return;
    if (item.confirm) {
      if (armedKey === item.key) {
        if (armTimer.current) clearTimeout(armTimer.current);
        setArmedKey(null);
        setOpen(false);
        item.onClick();
      } else {
        setArmedKey(item.key);
        if (armTimer.current) clearTimeout(armTimer.current);
        armTimer.current = setTimeout(() => setArmedKey(null), ARM_MS);
      }
      return;
    }
    setOpen(false);
    item.onClick();
  };

  return (
    <>
      <button
        ref={btnRef}
        className="kebab-trigger-btn"
        title={title}
        onClick={(e) => {
          e.stopPropagation();
          if (!open && btnRef.current) {
            const rect = btnRef.current.getBoundingClientRect();
            setPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
          }
          setOpen((v) => !v);
          setArmedKey(null);
        }}
      >
        <OverflowIcon size={15} />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            className={`cmux-root${theme === "light" ? " light" : ""} pane-tab-overflow-menu`}
            style={{ position: "fixed", top: pos.top, right: pos.right }}
            onClick={(e) => e.stopPropagation()}
          >
            {items.map((item) => (
              <button
                key={item.key}
                className={`pane-tab-overflow-item${item.danger ? " danger" : ""}${
                  armedKey === item.key ? " armed" : ""
                }`}
                disabled={item.disabled}
                onClick={() => handleItemClick(item)}
              >
                {item.icon}
                <span style={{ flex: 1 }}>
                  {armedKey === item.key && item.armLabel ? item.armLabel : item.label}
                </span>
                {armedKey === item.key && (
                  <span className="pane-tab-overflow-hint" style={{ color: "var(--o)" }}>
                    3s
                  </span>
                )}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
