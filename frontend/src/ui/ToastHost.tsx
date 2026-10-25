// The app-wide toast host — the one place a failure becomes visible.
//
// Before this existed, every failure in the app improvised its own
// surface: a `title` tooltip nobody sees, a `console.error`, an unhandled
// promise rejection, or a `catch` that set the same state a successful
// load would have set. This component renders what
// store/slices/toasts.ts collects, so "something went wrong" always has
// somewhere to land.
//
// The live region is the same shape TerminalToasts.tsx uses, and for the
// same reason: a live region only announces content that CHANGES inside
// it, so a region inserted into the DOM together with its content is not
// reliably announced. The container below is therefore always mounted and
// the toasts come and go inside it.
//
// The auto-dismiss timers live HERE rather than in the store, because a
// timer inside the store outlives the component that scheduled it and
// leaks across tests (resetStore() replaces state but cannot reach a
// module-scoped timer).
import { useEffect } from "react";
import { useDashboardStore } from "../store/index.js";
import type { Toast } from "../store/types.js";
import { CloseIcon } from "./icons.js";

// An error is the case this whole slice exists for, so it gets the longest
// life — long enough to read and act on, short enough that a burst of
// failures does not build a wall of text.
const TOAST_LIFETIME_MS: Record<Toast["kind"], number> = {
  info: 4000,
  success: 4000,
  error: 10000,
};

export function ToastHost() {
  const toasts = useDashboardStore((s) => s.toasts);
  const dismissToast = useDashboardStore((s) => s.dismissToast);

  return (
    // The live region — always mounted, so a toast that arrives later is
    // announced as a change to existing content.
    //
    // `role="status"` implies `aria-live="polite"`. The error variant
    // below carries `role="alert"` (assertive) so a failure interrupts
    // rather than waiting for a pause — the same split TerminalToasts
    // makes.
    <div className="toast-host" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={dismissToast} />
      ))}
    </div>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(toast.id), TOAST_LIFETIME_MS[toast.kind]);
    return () => clearTimeout(timer);
  }, [onDismiss, toast.id, toast.kind]);

  return (
    <div className={`toast toast--${toast.kind}`} role={toast.kind === "error" ? "alert" : undefined}>
      <span className="toast-message">{toast.message}</span>
      {/* Icon-only on purpose: the button's accessible name comes from
          aria-label, but its TEXT CONTENT is empty, so it contributes
          nothing to what the live region above announces. A visible "×"
          text would be read out as part of the message. */}
      <button
        type="button"
        className="toast-dismiss"
        aria-label="Dismiss notification"
        onClick={() => onDismiss(toast.id)}
      >
        <CloseIcon size={12} />
      </button>
    </div>
  );
}
