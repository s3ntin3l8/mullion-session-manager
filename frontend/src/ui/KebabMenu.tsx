import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useDashboardStore } from "../store/index.js";
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
const ARM_SECONDS = ARM_MS / 1000;

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

export function KebabMenu({
  items,
  title = "More…",
  menuPlacement = "bottom",
}: {
  items: KebabMenuItem[];
  title?: string;
  // "top" grows the portaled menu upward from the trigger instead of
  // dropping it down — for a trigger pinned near the bottom of the
  // viewport (the Dock), a downward menu can run off-screen with no way to
  // scroll to its lower items. Same union/default as CustomSelect's own
  // menuPlacement; deliberately no measured auto-flip (see getMenuStyle
  // below) — a caller in that position simply always wants "top".
  menuPlacement?: "bottom" | "top";
}) {
  const theme = useDashboardStore((s) => s.theme);
  const [open, setOpen] = useState(false);
  // DOMRect (not just {top,right}) to mirror CustomSelect's own triggerRect
  // — getMenuStyle below needs rect.top for the "top" placement's `bottom:`
  // calc, which the old {top,right} shape didn't carry.
  const [triggerRect, setTriggerRect] = useState<DOMRect | null>(null);
  const [armedKey, setArmedKey] = useState<string | null>(null);
  // Ticks 3 -> 2 -> 1 in the "3s"-style hint below rather than sitting static
  // for the whole arm window — a countdown that doesn't move reads as stuck.
  const [armSecondsLeft, setArmSecondsLeft] = useState(ARM_SECONDS);
  // Mirrors armSecondsLeft so the interval callback below can branch on the
  // current count without reaching into a setState updater — calling
  // setArmedKey/clearInterval (side effects) from inside a setArmSecondsLeft
  // updater function is impure and can warn under StrictMode.
  const armSecondsRef = useRef(ARM_SECONDS);
  const armIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const clearArmTimer = () => {
    if (armIntervalRef.current) {
      clearInterval(armIntervalRef.current);
      armIntervalRef.current = null;
    }
  };

  useEffect(
    () => () => {
      if (armIntervalRef.current) clearInterval(armIntervalRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!open) return;
    const onOutsideClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (btnRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      clearArmTimer();
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
        clearArmTimer();
        setArmedKey(null);
        setOpen(false);
        item.onClick();
      } else {
        clearArmTimer();
        setArmedKey(item.key);
        armSecondsRef.current = ARM_SECONDS;
        setArmSecondsLeft(ARM_SECONDS);
        armIntervalRef.current = setInterval(() => {
          armSecondsRef.current -= 1;
          if (armSecondsRef.current <= 0) {
            clearArmTimer();
            setArmedKey(null);
            setArmSecondsLeft(ARM_SECONDS);
          } else {
            setArmSecondsLeft(armSecondsRef.current);
          }
        }, 1000);
      }
      return;
    }
    setOpen(false);
    item.onClick();
  };

  // Matches CustomSelect.tsx's own getMenuStyle: always right-aligned to the
  // trigger (KebabMenu never offers a menuAlign), and — the one branch that
  // matters here — "top" sets only `bottom`, never also `top`, since fixed
  // positioning with just `bottom` set is what makes the menu grow upward
  // from the trigger instead of down past it.
  const getMenuStyle = (): React.CSSProperties | null => {
    const rect = triggerRect;
    if (!rect) return null;
    const style: React.CSSProperties = {
      position: "fixed",
      right: window.innerWidth - rect.right,
    };
    if (menuPlacement === "top") {
      style.bottom = window.innerHeight - rect.top + 4;
    } else {
      style.top = rect.bottom + 4;
    }
    return style;
  };
  const menuStyle = getMenuStyle();

  return (
    <>
      <button
        ref={btnRef}
        className="kebab-trigger-btn"
        title={title}
        onClick={(e) => {
          e.stopPropagation();
          if (!open && btnRef.current) {
            setTriggerRect(btnRef.current.getBoundingClientRect());
          }
          setOpen((v) => !v);
          clearArmTimer();
          setArmedKey(null);
        }}
      >
        <OverflowIcon size={15} />
      </button>
      {open &&
        menuStyle &&
        createPortal(
          <div
            ref={menuRef}
            className={`cmux-root${theme === "light" ? " light" : ""} pane-tab-overflow-menu`}
            style={menuStyle}
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
                    {armSecondsLeft}s
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
