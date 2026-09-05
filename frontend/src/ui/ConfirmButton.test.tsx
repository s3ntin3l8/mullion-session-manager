// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
});
