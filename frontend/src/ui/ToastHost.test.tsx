// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { useDashboardStore } from "../store/index.js";
import { resetStore } from "../test/resetStore.js";
import { ToastHost } from "./ToastHost.js";

describe("toast slice", () => {
  beforeEach(() => {
    resetStore();
  });

  it("starts empty", () => {
    expect(useDashboardStore.getState().toasts).toEqual([]);
  });

  it("pushes a toast and gives it an id", () => {
    const id = useDashboardStore.getState().pushToast({ message: "Killed" });
    const { toasts } = useDashboardStore.getState();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ id, message: "Killed", kind: "info" });
  });

  it("defaults to the info kind and honours an explicit one", () => {
    useDashboardStore.getState().pushToast({ message: "a" });
    useDashboardStore.getState().pushToast({ message: "b", kind: "error" });
    useDashboardStore.getState().pushToast({ message: "c", kind: "success" });
    expect(useDashboardStore.getState().toasts.map((t) => t.kind)).toEqual([
      "info",
      "error",
      "success",
    ]);
  });

  // Two toasts pushed in the same millisecond must still be separately
  // dismissable — an id derived from the array length or a timestamp would
  // give them the same one.
  it("gives two toasts pushed in the same tick different ids", () => {
    const a = useDashboardStore.getState().pushToast({ message: "a" });
    const b = useDashboardStore.getState().pushToast({ message: "b" });
    expect(a).not.toBe(b);
    useDashboardStore.getState().dismissToast(a);
    expect(useDashboardStore.getState().toasts.map((t) => t.message)).toEqual(["b"]);
  });

  it("dismisses only the named toast", () => {
    const a = useDashboardStore.getState().pushToast({ message: "a" });
    const b = useDashboardStore.getState().pushToast({ message: "b" });
    useDashboardStore.getState().dismissToast(a);
    expect(useDashboardStore.getState().toasts).toHaveLength(1);
    expect(useDashboardStore.getState().toasts[0].id).toBe(b);
  });

  it("dismissing an unknown id is a no-op", () => {
    useDashboardStore.getState().pushToast({ message: "a" });
    useDashboardStore.getState().dismissToast(9999);
    expect(useDashboardStore.getState().toasts).toHaveLength(1);
  });

  it("clears every toast", () => {
    useDashboardStore.getState().pushToast({ message: "a" });
    useDashboardStore.getState().pushToast({ message: "b" });
    useDashboardStore.getState().clearToasts();
    expect(useDashboardStore.getState().toasts).toEqual([]);
  });

  it("reportError pushes an error-kind toast carrying the detail", () => {
    useDashboardStore.getState().reportError("Could not kill the session.", "boom");
    const { toasts } = useDashboardStore.getState();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].kind).toBe("error");
    expect(toasts[0].message).toBe("Could not kill the session. boom");
  });

  // A detail that says nothing the headline does not already say is
  // dropped, rather than producing "Could not kill the session. Could not
  // kill the session."
  it("reportError does not repeat a detail identical to the headline", () => {
    useDashboardStore.getState().reportError("Failed.", "Failed.");
    expect(useDashboardStore.getState().toasts[0].message).toBe("Failed.");
  });

  // A failure that repeats (a poll that fails every few seconds) must
  // not stack a row per failure — a wall of identical text that buries
  // everything else on screen.
  it("does not stack two toasts with the same message", () => {
    const first = useDashboardStore.getState().pushToast({ message: "Could not refresh." });
    const second = useDashboardStore.getState().pushToast({ message: "Could not refresh." });
    const { toasts } = useDashboardStore.getState();
    expect(toasts).toHaveLength(1);
    // The id of the toast that is already on screen comes back, so a
    // caller that dismisses by id still dismisses the visible row.
    expect(second).toBe(first);
  });

  it("still stacks two toasts with the same message but different kinds", () => {
    useDashboardStore.getState().pushToast({ message: "Could not refresh." });
    useDashboardStore.getState().pushToast({ message: "Could not refresh.", kind: "error" });
    expect(useDashboardStore.getState().toasts).toHaveLength(2);
  });

  it("reportError does not stack a duplicate of the same failure", () => {
    useDashboardStore.getState().reportError("Could not kill the session.", "boom");
    useDashboardStore.getState().reportError("Could not kill the session.", "boom");
    expect(useDashboardStore.getState().toasts).toHaveLength(1);
  });

  it("caps the list, dropping the oldest past the cap", () => {
    for (let i = 0; i < 8; i += 1) {
      useDashboardStore.getState().pushToast({ message: `message ${i}` });
    }
    const { toasts } = useDashboardStore.getState();
    expect(toasts).toHaveLength(5);
    // The NEWEST survive; the oldest are the ones dropped.
    expect(toasts.map((t) => t.message)).toEqual([
      "message 3",
      "message 4",
      "message 5",
      "message 6",
      "message 7",
    ]);
  });
});

describe("ToastHost", () => {
  beforeEach(() => {
    resetStore();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing when there are no toasts", () => {
    render(<ToastHost />);
    expect(screen.queryByText(/./)).toBeNull();
  });

  it("renders the toast message", () => {
    useDashboardStore.getState().pushToast({ message: "The session was not killed." });
    render(<ToastHost />);
    expect(screen.getByText("The session was not killed.")).toBeInTheDocument();
  });

  // The live region has to be PERMANENT: a region inserted into the DOM
  // together with its content is not reliably announced, so the container
  // must be mounted before the toast arrives.
  it("keeps a permanent live region mounted", () => {
    render(<ToastHost />);
    const region = screen.getByRole("status");
    expect(region).toBeInTheDocument();
    act(() => {
      useDashboardStore.getState().pushToast({ message: "later" });
    });
    expect(screen.getByRole("status")).toBe(region);
  });

  // An error must interrupt rather than wait for a pause in whatever the
  // screen reader is saying.
  it("raises an error toast to role=alert and leaves the others alone", () => {
    useDashboardStore.getState().pushToast({ message: "just info" });
    useDashboardStore.getState().pushToast({ message: "it broke", kind: "error" });
    render(<ToastHost />);
    expect(screen.getByRole("alert")).toHaveTextContent("it broke");
    expect(screen.queryByRole("alert")).not.toHaveTextContent("just info");
  });

  it("auto-dismisses an info toast", () => {
    useDashboardStore.getState().pushToast({ message: "Copied" });
    render(<ToastHost />);
    expect(screen.getByText("Copied")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.queryByText("Copied")).toBeNull();
  });

  it("keeps an error toast around longer than an info one", () => {
    useDashboardStore.getState().pushToast({ message: "it broke", kind: "error" });
    render(<ToastHost />);
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.getByText("it broke")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(screen.queryByText("it broke")).toBeNull();
  });

  it("dismisses on the button", () => {
    useDashboardStore.getState().pushToast({ message: "dismiss me" });
    render(<ToastHost />);
    act(() => {
      screen.getByRole("button", { name: "Dismiss notification" }).click();
    });
    expect(useDashboardStore.getState().toasts).toEqual([]);
  });

  it("gives the dismiss button an accessible name", () => {
    useDashboardStore.getState().pushToast({ message: "x" });
    render(<ToastHost />);
    expect(screen.getByRole("button", { name: "Dismiss notification" })).toBeInTheDocument();
  });

  // The error variant's icon is the NON-COLOUR cue: the message must
  // never depend on the red alone (WCAG 1.4.1). The icon itself is
  // aria-hidden — the live region announces the message, not the shape.
  it("gives an error toast a non-colour icon cue", () => {
    useDashboardStore.getState().pushToast({ message: "it broke", kind: "error" });
    render(<ToastHost />);
    const alert = screen.getByRole("alert");
    expect(alert.querySelector(".toast-icon")).not.toBeNull();
    expect(alert.querySelector(".toast-icon")).toHaveAttribute("aria-hidden", "true");
  });

  it("gives an info toast no error icon", () => {
    useDashboardStore.getState().pushToast({ message: "just info" });
    render(<ToastHost />);
    expect(document.querySelector(".toast-icon")).toBeNull();
  });

  // A toast that expires while it is being read is a message that cannot
  // be read at all (WCAG 2.2.1). For a few failures the toast is the ONLY
  // record of what happened, so the pointer being over it must hold it
  // open.
  it("pauses the auto-dismiss while the pointer is over the toast", () => {
    useDashboardStore.getState().pushToast({ message: "it broke", kind: "error" });
    render(<ToastHost />);
    const toast = screen.getByRole("alert");
    fireEvent.mouseEnter(toast);
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(screen.getByText("it broke")).toBeInTheDocument();
    fireEvent.mouseLeave(toast);
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(screen.queryByText("it broke")).toBeNull();
  });

  it("pauses the auto-dismiss while the toast has focus", () => {
    useDashboardStore.getState().pushToast({ message: "it broke", kind: "error" });
    render(<ToastHost />);
    const toast = screen.getByRole("alert");
    fireEvent.focus(toast);
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(screen.getByText("it broke")).toBeInTheDocument();
    fireEvent.blur(toast);
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(screen.queryByText("it broke")).toBeNull();
  });

  // Resuming continues the ORIGINAL countdown rather than restarting it: a
  // toast that is hovered for a minute must not live for a minute more.
  // Five seconds are read, then it is hovered for five more, so only the
  // five seconds it never got to show are still owed.
  it("resumes with the time that was left, not a fresh lifetime", () => {
    useDashboardStore.getState().pushToast({ message: "it broke", kind: "error" });
    render(<ToastHost />);
    const toast = screen.getByRole("alert");
    // Read for five seconds of its ten.
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    fireEvent.mouseEnter(toast);
    // Hovered for five seconds — that time is NOT taken off the clock.
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    fireEvent.mouseLeave(toast);
    // Five seconds of the original ten were still owed.
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.getByText("it broke")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByText("it broke")).toBeNull();
  });

  // Hover and focus are INDEPENDENT reasons to hold the toast open. With
  // one boolean for both, either event would clear the other's pause: a
  // toast that is still focused would expire the moment the pointer left
  // it, and a toast under the pointer would expire when focus moved away.
  it("stays paused when the pointer leaves but the toast still has focus", () => {
    useDashboardStore.getState().pushToast({ message: "it broke", kind: "error" });
    render(<ToastHost />);
    const toast = screen.getByRole("alert");
    fireEvent.mouseEnter(toast);
    fireEvent.focus(toast);
    // The pointer leaves; the toast is still focused.
    fireEvent.mouseLeave(toast);
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(screen.getByText("it broke")).toBeInTheDocument();
  });

  it("stays paused when focus leaves but the pointer is still over the toast", () => {
    useDashboardStore.getState().pushToast({ message: "it broke", kind: "error" });
    render(<ToastHost />);
    const toast = screen.getByRole("alert");
    fireEvent.mouseEnter(toast);
    fireEvent.focus(toast);
    // Focus leaves; the pointer is still over the toast.
    fireEvent.blur(toast);
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(screen.getByText("it broke")).toBeInTheDocument();
  });
});
