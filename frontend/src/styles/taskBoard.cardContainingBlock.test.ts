import { describe, expect, it } from "vitest";

// import.meta.glob rather than node:fs (browser-only tsconfig), as taskBoard.metaRow.test.ts does.
const files = import.meta.glob("./task-board.css", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;
const css = files["./task-board.css"];

// jsdom has no layout, so this pins the CSS contract; the rendered result is covered by the
// `kanban-tall-column` visual scene.
describe("task card containing block", () => {
  it("is positioned so its hidden open button cannot stretch the board overlay's scroll area", () => {
    const start = css.indexOf(".task-card {");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(css.slice(start, css.indexOf("}", start))).toMatch(/position:\s*relative/);
  });
});
