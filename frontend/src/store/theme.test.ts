import { describe, expect, it } from "vitest";
import { themeClassName } from "./theme.js";

describe("themeClassName", () => {
  it("carries the root class alone in the dark theme", () => {
    expect(themeClassName("dark")).toBe("cmux-root");
  });

  it("adds the light class next to the root class", () => {
    expect(themeClassName("light")).toBe("cmux-root light");
  });

  it("appends the extra classes after the theme classes", () => {
    expect(themeClassName("light", "sb-tooltip")).toBe("cmux-root light sb-tooltip");
    expect(themeClassName("dark", "sb-tooltip")).toBe("cmux-root sb-tooltip");
  });

  it("keeps several extra classes in the order they were passed", () => {
    expect(themeClassName("light", "pane-tab-overflow-menu", "notif-panel")).toBe(
      "cmux-root light pane-tab-overflow-menu notif-panel",
    );
  });

  it("drops the falsy extras a conditional class produces", () => {
    expect(themeClassName("dark", false, null, undefined, "")).toBe("cmux-root");
    expect(themeClassName("light", false, "sb-open", null)).toBe("cmux-root light sb-open");
  });
});

// The expression this helper replaced was hand-copied at eight call sites
// (issue #2517), so the next portaled surface can forget it the same way.
// This guard fails if one comes back — the helper is the only place that may
// spell the theme classes out.
//
// The pattern is built from parts so this file does not match itself.
//
// Test files are excluded: they have no portaled surface of their own, and a
// fixture that renders the class by hand is not the regression this is
// watching for.
const HAND_WRITTEN_THEME_CLASS = `cmux-root${"$"}{`;

const sources = import.meta.glob(
  ["../**/*.ts", "../**/*.tsx", "!../**/*.test.ts", "!../**/*.test.tsx"],
  {
    query: "?raw",
    import: "default",
  },
) as Record<string, () => Promise<string>>;

describe("theme class guard (issue #2517)", () => {
  // The scan reads a few hundred source files through Vite's module graph.
  // That is well under a second on an idle machine, but a loaded one can
  // take several — so the timeout is raised rather than left at the 5s
  // default.
  it("has no hand-written theme class outside the helper", async () => {
    const offenders: string[] = [];
    for (const [path, load] of Object.entries(sources)) {
      // The helper is where the classes are spelled out. The glob's keys are
      // relative to THIS module, so the helper's key is "./theme.ts".
      if (path === "./theme.ts") continue;
      const source = await load();
      if (source.includes(HAND_WRITTEN_THEME_CLASS)) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  }, 30_000);
});
