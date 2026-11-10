import { describe, expect, it } from "vitest";

// import.meta.glob rather than node:fs, as tokens.reducedMotion.test.ts does (browser-only tsconfig).
const files = import.meta.glob("./task-board.css", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;
const css = files["./task-board.css"];

// jsdom has no layout, so this pins the CSS contract that stops the card's links row spilling
// past a narrow card (#2917); the rendered result is covered by the `kanban` visual scene.

function rule(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `${selector} rule exists`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start));
}

describe("task card meta row", () => {
  it("wraps instead of overflowing", () => {
    expect(rule(".task-card-meta-links")).toMatch(/flex-wrap:\s*wrap/);
    expect(rule(".task-card-meta-links")).toMatch(/min-width:\s*0/);
  });
  it("lets each item shrink and clip on its own", () => {
    const items = rule(
      ".task-card-meta-links .task-card-issue,\n.task-card-meta-links .task-card-pr,\n.task-card-meta-links .task-card-agent,\n.task-card-meta-links .task-card-age",
    );
    expect(items).toMatch(/min-width:\s*0/);
    expect(items).toMatch(/overflow:\s*hidden/);
  });
});
