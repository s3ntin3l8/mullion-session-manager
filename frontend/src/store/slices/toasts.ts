import type { StateCreator } from "zustand";
import type { DashboardState, Toast, ToastsSlice } from "../types.js";

// The app had no shared way to tell the user that something failed. Every
// surface improvised its own: a `title` tooltip nobody sees, a
// `console.error`, an unhandled promise rejection, or — worst of all — a
// `catch` that set the same state a successful load would have set, so
// "loading" and "failed" were indistinguishable (see the audit's findings
// 13-15 and 28-31 in docs/ui-ux-audit.md).
//
// This slice is the one place a failure becomes visible. It deliberately
// holds STATE AND ACTIONS ONLY — no timers. The auto-dismiss timing lives
// in ui/ToastHost.tsx, because a timer inside the store outlives the
// component that scheduled it (and would leak across tests, since
// resetStore() replaces state but cannot reach a module-scoped timer).

// Module-scoped, like every other id counter in this codebase's store
// slices — it is not state, it is a monotonic clock for ids.
let nextToastId = 0;

export const createToastsSlice: StateCreator<DashboardState, [], [], ToastsSlice> = (set) => ({
  toasts: [],

  // Returns the new toast's id, so a caller that needs to dismiss it
  // early (e.g. "show a spinner, then replace it with the result") can.
  pushToast: (input) => {
    // A monotonically increasing counter, not an array length or a
    // timestamp: two toasts pushed in the same millisecond must get
    // DIFFERENT ids, or dismissing one would dismiss both.
    nextToastId += 1;
    const id = nextToastId;
    const toast: Toast = {
      id,
      kind: input.kind ?? "info",
      message: input.message,
    };
    set((state) => ({ toasts: [...state.toasts, toast] }));
    return id;
  },

  dismissToast: (id) => {
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
  },

  clearToasts: () => set({ toasts: [] }),

  // The shape every failure in the app wants: an error-kind toast with a
  // message the user can act on. `detail` is the raw error text, appended
  // only when it adds something the headline does not already say.
  reportError: (message, detail) => {
    const text = detail && detail !== message ? `${message} ${detail}` : message;
    nextToastId += 1;
    const id = nextToastId;
    const toast: Toast = { id, kind: "error", message: text };
    set((state) => ({ toasts: [...state.toasts, toast] }));
    return id;
  },
});
