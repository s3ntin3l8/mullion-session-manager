import {
  useEffect,
  useId,
  useState,
  type FocusEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { TooltipBubble } from "./Tooltip.js";

/** Hover delay before the tooltip appears; keyboard (focus-visible) focus shows it at once. */
const TOOLTIP_HOVER_DELAY_MS = 200;

export interface TooltipTriggerProps {
  onPointerEnter: (e: PointerEvent<HTMLElement>) => void;
  onPointerLeave: (e: PointerEvent<HTMLElement>) => void;
  onPointerDown: (e: PointerEvent<HTMLElement>) => void;
  onFocus: (e: FocusEvent<HTMLElement>) => void;
  onBlur: (e: FocusEvent<HTMLElement>) => void;
}

/**
 * Shared tooltip behaviour for icon-only controls: shows after
 * {@link TOOLTIP_HOVER_DELAY_MS} of hover and immediately on focus; hides on
 * blur, pointer leave, pointer down and Escape. Spread `triggerProps`, pass
 * `setAnchor` as the `ref`, on the control and render `tooltip` beside it.
 */
export function useTooltip<T extends HTMLElement>(label: string) {
  const [anchor, setAnchor] = useState<T | null>(null);
  const id = useId();
  const [hovering, setHovering] = useState(false);
  const [focused, setFocused] = useState(false);
  const [delayed, setDelayed] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  // Hover opens after the delay; leaving (or the effect re-running) cancels.
  useEffect(() => {
    if (!hovering) return;
    const t = setTimeout(() => setDelayed(true), TOOLTIP_HOVER_DELAY_MS);
    return () => clearTimeout(t);
  }, [hovering]);

  const open = !dismissed && (focused || (hovering && delayed));
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDismissed(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const reset = () => {
    setHovering(false);
    setDelayed(false);
    setFocused(false);
    setDismissed(false);
  };
  const triggerProps: TooltipTriggerProps = {
    onPointerEnter: (e) => {
      // Touch has no hover; a tap must not leave a bubble stuck open.
      if (e.pointerType === "touch") return;
      setDismissed(false);
      setHovering(true);
    },
    onPointerLeave: () => {
      setHovering(false);
      setDelayed(false);
      setDismissed(false);
    },
    onPointerDown: reset,
    onFocus: (e) => {
      // Script-driven focus (e.g. the detail view moving focus to Back on open)
      // is not :focus-visible after a pointer interaction; only show the bubble
      // for keyboard focus. Engines without :focus-visible keep showing it.
      try {
        if (!e.currentTarget.matches(":focus-visible")) return;
      } catch {
        // unsupported selector: fall through and show
      }
      setDismissed(false);
      setFocused(true);
    },
    onBlur: reset,
  };
  const tooltip: ReactNode = open ? <TooltipBubble label={label} anchor={anchor} id={id} /> : null;
  return { setAnchor, triggerProps, tooltip, tooltipId: id, open };
}
