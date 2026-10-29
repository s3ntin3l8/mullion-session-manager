import { describe, expect, it } from "vitest";
import type { projects } from "../../src/db/schema.js";
import {
  crossProjectAllowed,
  parseProjectIdList,
  serializeProjectIdList,
  targetAccepts,
} from "../../src/services/cross-project.js";

type Row = typeof projects.$inferSelect;
const project = (id: number, over: Partial<Row> = {}): Row => ({ id, ...over }) as Row;

describe("crossProjectAllowed", () => {
  it("is always true within one project and false for a missing row", () => {
    expect(crossProjectAllowed(project(1), project(1))).toBe(true);
    expect(crossProjectAllowed(undefined, project(2))).toBe(false);
    expect(crossProjectAllowed(project(1, { allowCrossProjectSpawn: true }), undefined)).toBe(
      false,
    );
  });

  it("needs the source to be a coordinator", () => {
    expect(crossProjectAllowed(project(1), project(2))).toBe(false);
    expect(crossProjectAllowed(project(1, { allowCrossProjectSpawn: false }), project(2))).toBe(
      false,
    );
    expect(crossProjectAllowed(project(1, { allowCrossProjectSpawn: true }), project(2))).toBe(
      true,
    );
  });

  it("a coordinator with no list reaches every project; with a list only those on it", () => {
    const all = project(1, { allowCrossProjectSpawn: true, crossProjectTargets: null });
    expect(crossProjectAllowed(all, project(9))).toBe(true);
    const some = project(1, { allowCrossProjectSpawn: true, crossProjectTargets: "[2,3]" });
    expect(crossProjectAllowed(some, project(2))).toBe(true);
    expect(crossProjectAllowed(some, project(9))).toBe(false);
  });

  it("the list does not matter once the coordinator toggle is off", () => {
    const off = project(1, { allowCrossProjectSpawn: false, crossProjectTargets: "[2]" });
    expect(crossProjectAllowed(off, project(2))).toBe(false);
  });

  it("the target's consent applies on top of the coordinator's reach", () => {
    const source = project(1, { allowCrossProjectSpawn: true });
    expect(crossProjectAllowed(source, project(2, { acceptsChildrenFrom: null }))).toBe(true);
    expect(crossProjectAllowed(source, project(2, { acceptsChildrenFrom: "any" }))).toBe(true);
    expect(crossProjectAllowed(source, project(2, { acceptsChildrenFrom: "none" }))).toBe(false);
    const listed = (list: string | null) =>
      project(2, { acceptsChildrenFrom: "listed", acceptsChildrenFromList: list });
    expect(crossProjectAllowed(source, listed("[1,5]"))).toBe(true);
    expect(crossProjectAllowed(source, listed("[5]"))).toBe(false);
    // "listed" with nothing on the list refuses, as does a malformed one.
    expect(crossProjectAllowed(source, listed(null))).toBe(false);
    expect(crossProjectAllowed(source, listed("not json"))).toBe(false);
  });

  it("fails closed on hand-edited data: an unknown consent mode refuses, an unreadable target list reaches nothing", () => {
    expect(targetAccepts(project(2, { acceptsChildrenFrom: "weird" }), 1)).toBe(false);
    expect(targetAccepts(project(2, { acceptsChildrenFrom: "None" }), 1)).toBe(false);
    const broken = project(1, { allowCrossProjectSpawn: true, crossProjectTargets: "not json" });
    expect(crossProjectAllowed(broken, project(2))).toBe(false);
    const wrongShape = project(1, { allowCrossProjectSpawn: true, crossProjectTargets: '{"a":1}' });
    expect(crossProjectAllowed(wrongShape, project(2))).toBe(false);
    // Blank is "unset", the same as null.
    const blank = project(1, { allowCrossProjectSpawn: true, crossProjectTargets: " " });
    expect(crossProjectAllowed(blank, project(2))).toBe(true);
  });
});

describe("project id lists", () => {
  it("parses only arrays of positive integers and treats the rest as no list", () => {
    expect(parseProjectIdList("[3,1,2]")).toEqual([3, 1, 2]);
    expect(parseProjectIdList('[1,"2",0,-4,1.5,7]')).toEqual([1, 7]);
    for (const raw of [null, undefined, "", "  ", "nope", '{"a":1}', "5"]) {
      expect(parseProjectIdList(raw)).toBeNull();
    }
  });

  it("serialises sorted and deduplicated, and an empty list as null", () => {
    expect(serializeProjectIdList([3, 1, 3, 2])).toBe("[1,2,3]");
    expect(serializeProjectIdList([])).toBeNull();
    expect(serializeProjectIdList(null)).toBeNull();
  });
});
