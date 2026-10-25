// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
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
});
