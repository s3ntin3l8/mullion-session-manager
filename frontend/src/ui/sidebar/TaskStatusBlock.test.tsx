// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskStatusBlock } from "./TaskStatusBlock.js";
import { makeTask } from "../../test/fixtures.js";
import kitCss from "../../styles/sidebar-kit.css?raw";
import prCss from "../../styles/github-pr.css?raw";

describe("TaskStatusBlock slots", () => {
  it("renders the status without an actions row when neither slot is given", () => {
    const { container } = render(<TaskStatusBlock task={makeTask({ status: "in_progress" })} />);
    expect(screen.getByTestId("task-status-block")).toBeInTheDocument();
    expect(container.querySelector(".sb-taskstatus-actions")).toBeNull();
  });

  it("renders the caller's actions inside the block", () => {
    render(
      <TaskStatusBlock
        task={makeTask({ status: "reviewing" })}
        actions={<button type="button">Approve task</button>}
      />,
    );
    const block = screen.getByTestId("task-status-block");
    expect(block).toContainElement(screen.getByRole("button", { name: "Approve task" }));
  });

  it("offers Open task → only when asked to, and calls back", async () => {
    const onOpenTask = vi.fn();
    const { rerender } = render(<TaskStatusBlock task={makeTask({ status: "ready" })} />);
    expect(screen.queryByRole("button", { name: "Open task →" })).toBeNull();
    rerender(<TaskStatusBlock task={makeTask({ status: "ready" })} onOpenTask={onOpenTask} />);
    await userEvent.click(screen.getByRole("button", { name: "Open task →" }));
    expect(onOpenTask).toHaveBeenCalledTimes(1);
  });
});

// jsdom has no layout, so a clipped menu cannot be caught by clicking through it
// (the PR strip's "More task actions" panel was clipped by `.pr-card` at first).
// These pin the two rules that keep it reachable; the geometry was measured in a
// real browser at 260, 300 and 340 px, dark and light.
describe("the strip's overflow menu stays reachable", () => {
  // Every declaration block of `selector`, joined (the actions row has two). Plain
  // string search, not a RegExp built from the selector: nothing here to escape.
  const rule = (css: string, selector: string) => {
    const bodies: string[] = [];
    const head = `${selector} {`;
    for (let from = 0; ;) {
      const at = css.indexOf(head, from);
      if (at < 0) break;
      const end = css.indexOf("}", at);
      // Only a rule that starts its own line: not the tail of a longer selector.
      if (at === 0 || css[at - 1] === "\n") bodies.push(css.slice(at + head.length, end));
      from = end;
    }
    return bodies.join(" ");
  };

  it("is not clipped by the PR card that holds the strip", () => {
    expect(rule(prCss, ".pr-card.pr-task-strip")).toMatch(/overflow:\s*visible/);
  });

  it("hangs from the whole actions row, not from the small button", () => {
    expect(rule(kitCss, ".sb-taskstatus-actions")).toMatch(/position:\s*relative/);
    expect(rule(kitCss, ".sb-taskstatus-actions .sb-pop")).toMatch(/position:\s*static/);
    const panel = rule(kitCss, ".sb-taskstatus-actions .sb-pop-panel");
    expect(panel).toMatch(/left:\s*0/);
    expect(panel).toMatch(/right:\s*0/);
  });
});
