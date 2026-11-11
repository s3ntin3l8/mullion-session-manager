// @vitest-environment jsdom
// The shared cmd-row shell. CommandPalette.test.tsx is frozen by the
// file-size ratchet, so the shell's own invariants live here: an empty
// subtitle string still renders the span, `undefined` omits it, the logo
// class is a suffix, and `rowTitle` is the tooltip rather than the visible
// title.
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PaletteRow } from "./PaletteRow.js";

describe("PaletteRow", () => {
  it("keeps an empty subtitle span and type=button when the caller sets them", () => {
    const { container } = render(
      <PaletteRow type="button" icon="›" title="Run" subtitle="" onClick={() => {}} />,
    );
    const subtitle = container.querySelector(".cmd-row-subtitle");
    expect(subtitle).not.toBeNull();
    expect(subtitle?.textContent).toBe("");
    expect(container.querySelector("button")).toHaveAttribute("type", "button");
  });

  it("omits the subtitle span and the type attribute when the caller omits them", () => {
    const { container } = render(<PaletteRow icon="›" title="Workspace" onClick={() => {}} />);
    expect(container.querySelector(".cmd-row-subtitle")).toBeNull();
    expect(container.querySelector("button")?.getAttribute("type")).toBeNull();
    expect(container.querySelector(".cmd-row-icon")?.className).toBe("cmd-row-icon");
  });

  it("appends the logo class and keeps the tooltip off the visible title", () => {
    const { container } = render(
      <PaletteRow
        selected
        icon={<img src="/logo.svg" alt="" />}
        iconClassName="cmd-row-icon-logo"
        iconStyle={{ background: "transparent" }}
        title="Claude"
        rowTitle="/home/x"
        onClick={() => {}}
        trailing={<span className="kbd">↵</span>}
      />,
    );
    const button = container.querySelector("button");
    expect(button).toHaveClass("cmd-row", "selected");
    expect(button).toHaveAttribute("title", "/home/x");
    expect(container.querySelector(".cmd-row-icon")?.className).toBe(
      "cmd-row-icon cmd-row-icon-logo",
    );
    expect(container.querySelector(".cmd-row-title")?.textContent).toBe("Claude");
    expect(container.querySelector(".kbd")).not.toBeNull();
  });

  it("forwards click and mouse enter", async () => {
    const onClick = vi.fn();
    const onMouseEnter = vi.fn();
    render(<PaletteRow icon="›" title="Run" onClick={onClick} onMouseEnter={onMouseEnter} />);
    const row = screen.getByRole("button", { name: /Run/ });
    await userEvent.hover(row);
    await userEvent.click(row);
    expect(onMouseEnter).toHaveBeenCalled();
    expect(onClick).toHaveBeenCalledOnce();
  });
});
