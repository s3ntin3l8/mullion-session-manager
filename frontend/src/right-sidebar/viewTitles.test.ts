// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { RIGHT_SIDEBAR_VIEWS } from "./views.js";
import { VIEW_TITLES } from "./viewTitles.js";

describe("VIEW_TITLES", () => {
  it("has exactly one strip title per registered right-sidebar view", () => {
    expect(Object.keys(VIEW_TITLES).sort()).toEqual(RIGHT_SIDEBAR_VIEWS.map((v) => v.id).sort());
  });
});
