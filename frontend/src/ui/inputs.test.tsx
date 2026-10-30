// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SearchInput, TextInput } from "./primitives.js";

describe("TextInput", () => {
  it("renders its value, labels it and reports changes", async () => {
    const onChange = vi.fn();
    render(<TextInput aria-label="Name" value="abc" onChange={onChange} />);
    const input = screen.getByRole("textbox", { name: "Name" });
    expect(input).toHaveValue("abc");
    expect(input).toHaveClass("ui-input");
    expect(input).not.toHaveClass("small");
    await userEvent.type(input, "d");
    expect(onChange).toHaveBeenCalled();
  });

  it("applies the small variant, extra class and passthrough type", () => {
    render(<TextInput small className="extra" type="number" aria-label="N" value="" readOnly />);
    const input = screen.getByRole("spinbutton", { name: "N" });
    expect(input).toHaveClass("ui-input", "small", "extra");
  });
});

describe("SearchInput", () => {
  it("is a search field with the shared class and small variant", async () => {
    const onChange = vi.fn();
    render(<SearchInput small aria-label="Find" value="" onChange={onChange} />);
    const input = screen.getByRole("searchbox", { name: "Find" });
    expect(input).toHaveClass("ui-input", "small");
    await userEvent.type(input, "x");
    expect(onChange).toHaveBeenCalled();
  });
});
