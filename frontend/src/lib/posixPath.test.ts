import { describe, it, expect } from "vitest";
import { isWithin, joinAbs, normalizeAbs, relativeAbs } from "./posixPath.js";

describe("posixPath", () => {
  it("normalizes dots, doubled and trailing slashes", () => {
    expect(normalizeAbs("/a//b/./c/../d/")).toBe("/a/b/d");
    expect(normalizeAbs("/")).toBe("/");
    expect(normalizeAbs("/..")).toBe("/");
  });
  it("relative paths, up and down", () => {
    expect(relativeAbs("/p/app", "/p/app/src/a.ts")).toBe("src/a.ts");
    expect(relativeAbs("/p/app/src", "/p/app/lib/b.ts")).toBe("../lib/b.ts");
    expect(relativeAbs("/p", "/p")).toBe("");
    expect(relativeAbs("/a/b", "/c")).toBe("../../c");
  });
  it("joins a root and a relative path", () => {
    expect(joinAbs("/p", "src/a.ts")).toBe("/p/src/a.ts");
    expect(joinAbs("/p/", "")).toBe("/p");
  });
  it("isWithin is boundary-aware", () => {
    expect(isWithin("/p/app", "/p/app")).toBe(true);
    expect(isWithin("/p/app", "/p/app/x")).toBe(true);
    expect(isWithin("/p/app", "/p/app2")).toBe(false);
    expect(isWithin("/", "/anything")).toBe(true);
  });
});
