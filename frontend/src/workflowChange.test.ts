import { describe, it, expect } from "vitest";
import { parseWorkflowChange } from "./workflowChange.js";

describe("parseWorkflowChange", () => {
  it("reads a stored change", () => {
    expect(parseWorkflowChange('{"sha":"abc","files":["w.yml"]}')).toEqual({
      sha: "abc",
      files: ["w.yml"],
    });
  });

  it("drops non-string file entries", () => {
    expect(parseWorkflowChange('{"sha":"abc","files":["w.yml",3,null]}')).toEqual({
      sha: "abc",
      files: ["w.yml"],
    });
  });

  it("reads null, empty, corrupt and wrongly-shaped values as nothing waiting", () => {
    expect(parseWorkflowChange(null)).toBeNull();
    expect(parseWorkflowChange(undefined)).toBeNull();
    expect(parseWorkflowChange("")).toBeNull();
    expect(parseWorkflowChange("{not json")).toBeNull();
    expect(parseWorkflowChange('{"sha":1,"files":[]}')).toBeNull();
    expect(parseWorkflowChange('{"files":[]}')).toBeNull();
  });
});
