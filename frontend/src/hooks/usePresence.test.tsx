// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { usePresence, useDismissExit } from "./usePresence.js";
import { installExitAnimations } from "../test/exitAnimations.js";
import type { ExitAnimations } from "../test/exitAnimations.js";

function Popover({ open }: { open: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const { present, state } = usePresence(open, ref);
  if (!present) return null;
  return (
    <div ref={ref} data-testid="popover" data-presence={state}>
      popover
    </div>
  );
}

function Dialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const { state, dismiss } = useDismissExit(onClose, ref);
  return (
    <div ref={ref} data-testid="dialog" data-presence={state}>
      <button onClick={dismiss}>close</button>
    </div>
  );
}

function DialogHost({ onClose = () => {} }: { onClose?: () => void }) {
  const [open, setOpen] = useState(true);
  return open ? (
    <Dialog
      onClose={() => {
        onClose();
        setOpen(false);
      }}
    />
  ) : null;
}

function reduceMotion(on: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: on && query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

describe("usePresence", () => {
  let exits: ExitAnimations;
  beforeEach(() => {
    exits = installExitAnimations();
    reduceMotion(false);
  });
  afterEach(() => {
    exits.restore();
    vi.unstubAllGlobals();
  });

  it("stays mounted while it leaves, and unmounts once the exit has played", async () => {
    const { rerender } = render(<Popover open />);
    const popover = screen.getByTestId("popover");
    expect(popover).toHaveAttribute("data-presence", "open");

    rerender(<Popover open={false} />);
    expect(screen.getByTestId("popover")).toBe(popover);
    expect(popover).toHaveAttribute("data-presence", "leaving");
    expect(exits.pending()).toBe(1);

    await exits.finishExits();
    expect(screen.queryByTestId("popover")).toBeNull();
  });

  it("turns the same element back when it reopens while leaving", async () => {
    const { rerender } = render(<Popover open />);
    const popover = screen.getByTestId("popover");
    rerender(<Popover open={false} />);
    rerender(<Popover open />);
    expect(screen.getByTestId("popover")).toBe(popover);
    expect(popover).toHaveAttribute("data-presence", "open");
    // The abandoned exit finishing late does not take the reopened one away.
    await exits.finishExits();
    expect(screen.getByTestId("popover")).toBe(popover);
  });

  it("goes at once under reduced motion", () => {
    reduceMotion(true);
    const { rerender } = render(<Popover open />);
    rerender(<Popover open={false} />);
    expect(screen.queryByTestId("popover")).toBeNull();
    expect(exits.pending()).toBe(0);
  });

  it("goes at once where nothing animates (no Web Animations)", () => {
    exits.restore();
    const { rerender } = render(<Popover open />);
    rerender(<Popover open={false} />);
    expect(screen.queryByTestId("popover")).toBeNull();
  });

  function stubAnimations(animations: unknown[]) {
    exits.restore();
    Object.defineProperty(Element.prototype, "getAnimations", {
      configurable: true,
      writable: true,
      value: () => animations,
    });
  }

  it("does not wait on an infinite animation inside it (a spinner)", () => {
    stubAnimations([
      { finished: new Promise(() => {}), effect: { getTiming: () => ({ iterations: Infinity }) } },
    ]);
    try {
      const { rerender } = render(<Popover open />);
      rerender(<Popover open={false} />);
      expect(screen.queryByTestId("popover")).toBeNull();
    } finally {
      delete (Element.prototype as { getAnimations?: unknown }).getAnimations;
    }
  });

  it("does not wait on a scroll-driven animation inside it (a list's soft edge)", () => {
    class FakeDocumentTimeline {}
    vi.stubGlobal("DocumentTimeline", FakeDocumentTimeline);
    stubAnimations([
      {
        finished: new Promise(() => {}),
        timeline: {}, // a ScrollTimeline: not the document's clock
        effect: { getTiming: () => ({ iterations: 1 }) },
      },
    ]);
    try {
      const { rerender } = render(<Popover open />);
      rerender(<Popover open={false} />);
      expect(screen.queryByTestId("popover")).toBeNull();
    } finally {
      delete (Element.prototype as { getAnimations?: unknown }).getAnimations;
    }
  });

  it("goes in the end even if its exit never finishes", async () => {
    vi.useFakeTimers();
    stubAnimations([
      { finished: new Promise(() => {}), effect: { getTiming: () => ({ iterations: 1 }) } },
    ]);
    try {
      const { rerender } = render(<Popover open />);
      rerender(<Popover open={false} />);
      expect(screen.getByTestId("popover")).toHaveAttribute("data-presence", "leaving");
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(screen.queryByTestId("popover")).toBeNull();
    } finally {
      vi.useRealTimers();
      delete (Element.prototype as { getAnimations?: unknown }).getAnimations;
    }
  });
});

describe("useDismissExit", () => {
  let exits: ExitAnimations;
  beforeEach(() => {
    exits = installExitAnimations();
    reduceMotion(false);
  });
  afterEach(() => {
    exits.restore();
    vi.unstubAllGlobals();
  });

  it("plays the exit before it asks the parent to close, and asks once", async () => {
    const onClose = vi.fn();
    render(<DialogHost onClose={onClose} />);
    const close = screen.getByRole("button", { name: "close" });
    act(() => close.click());
    act(() => close.click());
    expect(screen.getByTestId("dialog")).toHaveAttribute("data-presence", "leaving");
    expect(onClose).not.toHaveBeenCalled();

    await exits.finishExits();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("dialog")).toBeNull();
  });

  it("comes back when the parent keeps it", async () => {
    const onClose = vi.fn();
    render(<Dialog onClose={onClose} />);
    act(() => screen.getByRole("button", { name: "close" }).click());
    await exits.finishExits();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("dialog")).toHaveAttribute("data-presence", "open");
  });

  it("closes at once under reduced motion", () => {
    reduceMotion(true);
    const onClose = vi.fn();
    render(<DialogHost onClose={onClose} />);
    act(() => screen.getByRole("button", { name: "close" }).click());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("dialog")).toBeNull();
  });
});
