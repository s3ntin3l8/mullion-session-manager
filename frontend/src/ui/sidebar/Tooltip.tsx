import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDashboardStore } from "../../store/index.js";

const VIEWPORT_MARGIN = 6;
const GAP = 6;

interface TooltipProps {
  label: string;
  anchor: HTMLElement | null;
  id: string;
}

/** Fixed-position bubble under the anchor, clamped inside the viewport (a
 *  portal, so a narrow sidebar's overflow can't clip it). Portaled to
 *  document.body, which sits outside `.cmux-root`, so it re-applies the
 *  theme classes itself (as KebabMenu does) — otherwise `--fg`/`--bg` are
 *  undefined and the bubble is transparent. */
export function TooltipBubble({ label, anchor, id }: TooltipProps) {
  const theme = useDashboardStore((s) => s.theme);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    const bubble = ref.current;
    if (!anchor || !bubble) return;
    const a = anchor.getBoundingClientRect();
    const w = bubble.offsetWidth;
    const h = bubble.offsetHeight;
    const maxLeft = window.innerWidth - w - VIEWPORT_MARGIN;
    const left = Math.max(VIEWPORT_MARGIN, Math.min(a.left + a.width / 2 - w / 2, maxLeft));
    // Prefer below; flip above when it would overflow the bottom edge.
    const below = a.bottom + GAP;
    const top = below + h > window.innerHeight - VIEWPORT_MARGIN ? a.top - GAP - h : below;
    setPos({ left, top: Math.max(VIEWPORT_MARGIN, top) });
  }, [label, anchor]);
  return createPortal(
    <div
      ref={ref}
      id={id}
      role="tooltip"
      className={`cmux-root${theme === "light" ? " light" : ""} sb-tooltip`}
      style={pos}
    >
      {label}
    </div>,
    document.body,
  );
}
