// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectMultiSelect } from "./ProjectMultiSelect.js";

const options = [
  { id: 1, name: "alpha" },
  { id: 2, name: "beta" },
  { id: 3, name: "gamma" },
];

describe("ProjectMultiSelect (#2123, #2124)", () => {
  it("shows the empty label, then a name list, then a count", () => {
    const { rerender } = render(
      <ProjectMultiSelect
        ariaLabel="targets"
        options={options}
        selected={[]}
        onChange={vi.fn()}
        emptyLabel="Every project"
      />,
    );
    expect(screen.getByRole("button", { name: "targets" })).toHaveTextContent("Every project");
    rerender(
      <ProjectMultiSelect
        ariaLabel="targets"
        options={options}
        selected={[1, 3]}
        onChange={vi.fn()}
        emptyLabel="Every project"
      />,
    );
    expect(screen.getByRole("button", { name: "targets" })).toHaveTextContent("alpha, gamma");
    rerender(
      <ProjectMultiSelect
        ariaLabel="targets"
        options={options}
        selected={[1, 2, 3]}
        onChange={vi.fn()}
        emptyLabel="Every project"
      />,
    );
    expect(screen.getByRole("button", { name: "targets" })).toHaveTextContent("3 projects");
  });

  it("toggles projects, clears the selection, and drops ids of deleted projects", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <ProjectMultiSelect
        ariaLabel="targets"
        options={options}
        selected={[2, 99]}
        onChange={onChange}
        emptyLabel="Every project"
      />,
    );
    // 99 is not a known project: it is not counted or shown.
    expect(screen.getByRole("button", { name: "targets" })).toHaveTextContent("beta");
    await user.click(screen.getByRole("button", { name: "targets" }));
    await user.click(screen.getByRole("checkbox", { name: "alpha" }));
    expect(onChange).toHaveBeenLastCalledWith([2, 1]);
    await user.click(screen.getByRole("checkbox", { name: "beta" }));
    expect(onChange).toHaveBeenLastCalledWith([]);
    await user.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("filters a long list and says when there is nothing to pick", async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, name: `proj-${i + 1}` }));
    const user = userEvent.setup();
    const { rerender } = render(
      <ProjectMultiSelect
        ariaLabel="targets"
        options={many}
        selected={[]}
        onChange={vi.fn()}
        emptyLabel="Every project"
      />,
    );
    await user.click(screen.getByRole("button", { name: "targets" }));
    await user.type(screen.getByRole("textbox", { name: "Filter projects" }), "proj-10");
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    rerender(
      <ProjectMultiSelect
        ariaLabel="targets"
        options={[]}
        selected={[]}
        onChange={vi.fn()}
        emptyLabel="Every project"
      />,
    );
    expect(screen.getByText("No other projects.")).toBeInTheDocument();
  });
});
