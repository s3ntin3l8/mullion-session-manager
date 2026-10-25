// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmButton } from "./ConfirmButton.js";

// PR #1086 review finding (standing-in-for-Hermes pass): the arm-then-fire
// pattern below is bypassed by a literal double-click — React flushes
// `armed=true` from click 1 before click 2's handler runs, so click 2's
// closure already sees `armed === true` and confirms immediately, with no
// perceptible intermediate "click again to confirm" state. The fix reads
// the native click event's own `detail` (the browser's double-click
// counter) and ignores a click that's part of one of those, without
// disarming, so the user's next deliberate click still confirms.
describe("ui/ConfirmButton", () => {
  it("does not fire onConfirm on a literal double-click", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ConfirmButton onConfirm={onConfirm} title="Remove thing">
        Remove
      </ConfirmButton>,
    );

    await user.dblClick(screen.getByText("Remove"));

    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("confirms a literal double-click when enabled", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ConfirmButton onConfirm={onConfirm} title="End session" allowDoubleClickConfirm>
        End
      </ConfirmButton>,
    );

    await user.dblClick(screen.getByText("End"));

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("arms on a double-click, and a subsequent deliberate click still confirms", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ConfirmButton onConfirm={onConfirm} title="Remove thing">
        Remove
      </ConfirmButton>,
    );
    const button = screen.getByText("Remove");

    await user.dblClick(button);
    expect(onConfirm).not.toHaveBeenCalled();

    // The double-click armed it (didn't fire, didn't disarm) — a further,
    // ordinary click now confirms.
    await user.click(button);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("requires arming before firing — a single click does not confirm", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ConfirmButton onConfirm={onConfirm} title="Remove thing">
        Remove
      </ConfirmButton>,
    );

    await user.click(screen.getByText("Remove"));

    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("fires on two separate deliberate clicks (arm, then confirm)", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ConfirmButton onConfirm={onConfirm} title="Remove thing">
        Remove
      </ConfirmButton>,
    );
    const button = screen.getByText("Remove");

    await user.click(button);
    expect(onConfirm).not.toHaveBeenCalled();

    await user.click(button);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("fires immediately on the first click when skipConfirm is set", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ConfirmButton onConfirm={onConfirm} title="Remove thing" skipConfirm>
        Remove
      </ConfirmButton>,
    );

    await user.click(screen.getByText("Remove"));

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("never fires while disabled, even once armed", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const { rerender } = render(
      <ConfirmButton onConfirm={onConfirm} title="Remove thing">
        Remove
      </ConfirmButton>,
    );
    const button = screen.getByRole("button");

    // Arms it (swaps the label for a check icon), then the caller disables
    // it — the still-armed button must not fire on the next click.
    await user.click(button);
    rerender(
      <ConfirmButton onConfirm={onConfirm} title="Remove thing" disabled>
        Remove
      </ConfirmButton>,
    );
    await user.click(screen.getByRole("button"));

    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("shows the check icon plus armedLabel and reserves both labels' width", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ConfirmButton
        onConfirm={onConfirm}
        title="Clean"
        armedLabel="Confirm clean"
        variant="neutral"
      >
        Clean
      </ConfirmButton>,
    );
    const button = screen.getByRole("button", { name: "Clean" });
    expect(button).toHaveClass("confirm-neutral", "confirm-btn-stable");
    expect(button).not.toHaveClass("danger");
    await user.click(button);
    expect(button).toHaveClass("armed");
    expect(screen.getByRole("button", { name: /Confirm clean/ })).toBe(button);
    expect(screen.getByText("Clean")).toBeInTheDocument();
    await user.click(button);
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});

// Audit finding 32 — ConfirmButton disarmed SILENTLY after six seconds.
// The button changed appearance, gave no indication of how long the window
// was, and simply reverted — so a user who looked away came back to a
// button that had quietly reset itself. The pane-kill path and the kebab
// menu both counted down all along; this component was the outlier.
describe("ConfirmButton arm countdown (audit finding 32)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the seconds remaining while armed", () => {
    render(
      <ConfirmButton onConfirm={vi.fn()} title="Remove thing">
        Remove
      </ConfirmButton>,
    );

    act(() => {
      screen.getByText("Remove").click();
    });

    expect(screen.getByText("6s")).toBeInTheDocument();
  });

  it("counts down while it stays armed", () => {
    render(
      <ConfirmButton onConfirm={vi.fn()} title="Remove thing">
        Remove
      </ConfirmButton>,
    );

    act(() => {
      screen.getByText("Remove").click();
    });
    expect(screen.getByText("6s")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText("5s")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByText("3s")).toBeInTheDocument();
  });

  it("still disarms itself when the window runs out", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmButton onConfirm={onConfirm} title="Remove thing">
        Remove
      </ConfirmButton>,
    );

    act(() => {
      screen.getByText("Remove").click();
    });
    act(() => {
      vi.advanceTimersByTime(6000);
    });

    // Disarmed — the countdown is gone, and the button is back to its
    // un-armed label.
    expect(screen.queryByText("6s")).toBeNull();
    expect(screen.getByText("Remove")).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("puts the remaining seconds in the title, for anyone who cannot see them", () => {
    render(
      <ConfirmButton onConfirm={vi.fn()} title="Remove thing">
        Remove
      </ConfirmButton>,
    );

    act(() => {
      screen.getByText("Remove").click();
    });

    expect(screen.getByRole("button")).toHaveAttribute(
      "title",
      expect.stringContaining("click again to confirm (6s)"),
    );
  });

  it("counts down alongside a caller-supplied armedLabel", () => {
    render(
      <ConfirmButton onConfirm={vi.fn()} title="Remove thing" armedLabel="Click again to remove">
        Remove
      </ConfirmButton>,
    );

    act(() => {
      screen.getByText("Remove").click();
    });

    expect(screen.getByText("Click again to remove")).toBeInTheDocument();
    expect(screen.getByText("6s")).toBeInTheDocument();
  });
});
