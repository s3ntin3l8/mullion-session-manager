import { SpinnerIcon } from "../icons.js";

// PR 25 (frontend refactor plan) — `<SpinnerIcon size={22} className=
// "terminal-status-spinner connecting|reconnecting" />` was hand-rolled at
// 5 call sites (App.tsx's Settings loading fallback, BrowserPane.tsx,
// panels/registry.tsx's lazy-panel fallback, TerminalPane.tsx x2).
// `.terminal-status-spinner` itself is deliberately left unrenamed —
// `panels/registry.tsx`'s own comment documents reusing "the existing
// terminal-connecting spinner vocabulary... instead of inventing a second
// loading affordance," and the refactor plan's PR 25 entry names only the
// two empty-state class families, not this one.
export function Spinner({
  variant = "connecting",
  size = 22,
}: {
  variant?: "connecting" | "reconnecting";
  size?: number;
}) {
  return <SpinnerIcon size={size} className={`terminal-status-spinner ${variant}`} />;
}
