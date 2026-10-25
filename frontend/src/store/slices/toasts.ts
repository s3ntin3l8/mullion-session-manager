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

// How many toasts can be on screen at once. A failure that repeats (a
// poll that fails every four seconds) used to stack a row per failure
// until each one expired on its own — a wall of identical text that
// buried everything else, including whatever the user was actually
// reading. The oldest is dropped past this many.
const MAX_TOASTS = 5;

export const createToastsSlice: StateCreator<DashboardState, [], [], ToastsSlice> = (set, get) => ({
  toasts: [],

  // Returns the new toast's id, so a caller that needs to dismiss it
  // early (e.g. "show a spinner, then replace it with the result") can.
  pushToast: (input) => {
    const kind = input.kind ?? "info";
    // Deduplicated: the same message is not added twice. A failure that
    // keeps repeating (a poll that fails every few seconds) would
    // otherwise stack identical rows; with this, the one that is already
    // on screen stands until it expires, and the next failure after that
    // starts a fresh one. The existing toast's id is returned, so a
    // caller that dismisses by id still dismisses the visible row.
    const existing = get().toasts.find((t) => t.kind === kind && t.message === input.message);
    if (existing) return existing.id;
    // A monotonically increasing counter, not an array length or a
    // timestamp: two toasts pushed in the same millisecond must get
    // DIFFERENT ids, or dismissing one would dismiss both.
    nextToastId += 1;
    const id = nextToastId;
    const toast: Toast = {
      id,
      kind,
      message: input.message,
    };
    set((state) => ({ toasts: [...state.toasts, toast].slice(-MAX_TOASTS) }));
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
    const kind: Toast["kind"] = "error";
    // Same deduplication as pushToast above — reportError is the shape
    // every failure in the app uses, so it is the one most likely to be
    // called twice with the same text.
    const existing = get().toasts.find((t) => t.kind === kind && t.message === text);
    if (existing) return existing.id;
    nextToastId += 1;
    const id = nextToastId;
    const toast: Toast = { id, kind, message: text };
    set((state) => ({ toasts: [...state.toasts, toast].slice(-MAX_TOASTS) }));
    return id;
  },
});
