// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ActionBanner } from "./ActionBanner.js";
import { expectNameHasVisibleText, expectNoNestedInteractive } from "./test/a11y.js";

function renderBanner(dismiss = true) {
  const onOpen = vi.fn();
  const onDismiss = vi.fn();
  const utils = render(
    <ActionBanner
      className="resource-alert warning"
      icon={<svg data-testid="icon" />}
      title="v1 → v2 available"
      subtext="Click for details"
      onOpen={onOpen}
      onDismiss={dismiss ? onDismiss : undefined}
      dismissTitle="Dismiss until next version"
    />,
  );
  return { onOpen, onDismiss, ...utils };
}

describe("ActionBanner", () => {
  it("is a container with two sibling buttons, not a button holding one (#2886)", () => {
    const { container } = renderBanner();
    const banner = container.querySelector(".update-banner") as HTMLElement;
    expect(banner).toHaveClass("resource-alert", "warning");
    expect(banner).not.toHaveAttribute("role");
    expect(banner).not.toHaveAttribute("tabindex");
    expectNoNestedInteractive(container);
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(screen.getByRole("button", { name: /v1 → v2 available/ })).toHaveTextContent(
      "v1 → v2 available Click for details",
    );
    for (const button of screen.getAllByRole("button")) expectNameHasVisibleText(button);
  });

  it("opens from its button, once per click, and from anywhere else on the strip", async () => {
    const user = userEvent.setup();
    const { container, onOpen } = renderBanner();
    await user.click(screen.getByRole("button", { name: /available/ }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    await user.click(container.querySelector(".update-banner") as HTMLElement);
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("opens from the keyboard: Tab reaches the open button first, Enter opens", async () => {
    const user = userEvent.setup();
    const { onOpen, onDismiss } = renderBanner();
    await user.tab();
    expect(screen.getByRole("button", { name: /available/ })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onOpen).toHaveBeenCalledTimes(1);
    await user.tab();
    expect(screen.getByRole("button", { name: "Dismiss until next version" })).toHaveFocus();
    await user.keyboard(" ");
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("dismisses without opening", async () => {
    const user = userEvent.setup();
    const { onOpen, onDismiss } = renderBanner();
    await user.click(screen.getByRole("button", { name: "Dismiss until next version" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("has no dismiss button without onDismiss", () => {
    renderBanner(false);
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });
});
