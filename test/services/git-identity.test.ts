import { describe, it, expect } from "vitest";
import {
  clampGitIdentityField,
  normalizeGitIdentity,
  parseProjectGitIdentity,
  resolveGitIdentity,
  serializeProjectGitIdentity,
} from "../../src/services/git-identity.js";
import { gitIdentityArgs } from "../../src/services/git-env.js";

const global = { name: "Global", email: "global@example.com" };
const project = { name: "Proj", email: "proj@example.com" };

describe("git identity resolution", () => {
  it("the project override beats the global identity", () => {
    expect(resolveGitIdentity(JSON.stringify(project), global)).toEqual(project);
  });

  it("falls back to the global identity without an override", () => {
    expect(resolveGitIdentity(null, global)).toEqual(global);
    expect(resolveGitIdentity("not json", global)).toEqual(global);
    expect(resolveGitIdentity(JSON.stringify({ name: "x" }), global)).toEqual(global);
  });

  it("is undefined (inject nothing) when neither is usable", () => {
    expect(resolveGitIdentity(null, { name: "", email: "" })).toBeUndefined();
    expect(resolveGitIdentity(undefined, { name: "Only a name", email: "  " })).toBeUndefined();
    expect(resolveGitIdentity(null, undefined)).toBeUndefined();
  });

  it("trims, and rejects control characters and non-objects", () => {
    expect(normalizeGitIdentity({ name: " A ", email: " a@b.c " })).toEqual({
      name: "A",
      email: "a@b.c",
    });
    expect(normalizeGitIdentity({ name: "A\nB", email: "a@b.c" })).toBeUndefined();
    expect(normalizeGitIdentity([])).toBeUndefined();
    expect(normalizeGitIdentity({ name: 1, email: 2 })).toBeUndefined();
    expect(normalizeGitIdentity({ name: "x".repeat(300), email: "a@b.c" })).toBeUndefined();
  });

  it("round-trips the project column and clears it on null", () => {
    expect(parseProjectGitIdentity(serializeProjectGitIdentity(project))).toEqual(project);
    expect(serializeProjectGitIdentity(null)).toBeNull();
    expect(serializeProjectGitIdentity({ name: "", email: "" })).toBeNull();
  });

  it("clamps a stored settings field", () => {
    expect(clampGitIdentityField(42)).toBe("");
    expect(clampGitIdentityField("x".repeat(300))).toHaveLength(256);
  });

  it("gitIdentityArgs emits -c pairs, or nothing", () => {
    expect(gitIdentityArgs(project)).toEqual([
      "-c",
      `user.${"name"}=Proj`,
      "-c",
      `user.${"email"}=proj@example.com`,
    ]);
    expect(gitIdentityArgs(undefined)).toEqual([]);
  });
});
