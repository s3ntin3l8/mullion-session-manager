import { describe, it, expect } from "vitest";
import { CLI_MODEL_RE, isValidCliModelName, isValidOpenCodeModel } from "./cliModel.js";

// The two validators are mirrors of the backend's own — CLI_MODEL_RE in
// src/services/hook-adapters/shared.ts, and validateModel in
// src/services/task-model-resolve.ts. They gate what reaches a shell
// command line, so a divergence from the backend is not cosmetic: the
// Settings UI would warn about a model the backend never applies, or stay
// silent about one it does.
//
// The cases below are the backend's own (test/services/task-model-resolve.test.ts
// pins the same set server-side), so a change to either side has to be
// made on both.

describe("isValidCliModelName", () => {
  it("accepts the bare names the CLIs take", () => {
    expect(isValidCliModelName("sonnet")).toBe(true);
    expect(isValidCliModelName("gpt-5")).toBe(true);
    expect(isValidCliModelName("opus")).toBe(true);
    expect(isValidCliModelName("haiku")).toBe(true);
    expect(isValidCliModelName("fable")).toBe(true);
    expect(isValidCliModelName("claude-opus-4-5[1m]")).toBe(true);
    expect(isValidCliModelName("gpt-5.1-codex")).toBe(true);
    // A single character is valid — the class is one leading alphanumeric
    // plus up to 127 more.
    expect(isValidCliModelName("a")).toBe(true);
    expect(isValidCliModelName("ab")).toBe(true);
  });

  it("rejects what the backend rejects", () => {
    // A value that fails here is only logged and skipped at launch, so
    // accepting one in the UI would let the user save a model that silently
    // never applies.
    expect(isValidCliModelName("--foo")).toBe(false); // leading dash reads as a flag
    expect(isValidCliModelName("-bad")).toBe(false);
    expect(isValidCliModelName("a b")).toBe(false); // whitespace
    expect(isValidCliModelName("a\tb")).toBe(false);
    expect(isValidCliModelName("$(x)")).toBe(false); // shell expansion
    expect(isValidCliModelName("a'b")).toBe(false); // quote
    expect(isValidCliModelName('a"b')).toBe(false);
    expect(isValidCliModelName("")).toBe(false);
  });

  it("treats a missing value as invalid", () => {
    expect(isValidCliModelName(null)).toBe(false);
    expect(isValidCliModelName(undefined)).toBe(false);
  });
});

describe("isValidOpenCodeModel", () => {
  it("accepts the provider/model shape opencode takes", () => {
    expect(isValidOpenCodeModel("opencode-go/minimax-m3.1-flash-free")).toBe(true);
    expect(isValidOpenCodeModel("anthropic/claude-sonnet-4-5")).toBe(true);
    expect(isValidOpenCodeModel("openrouter/anthropic/claude-sonnet-4-5")).toBe(true);
    expect(isValidOpenCodeModel("opencode-go/model#variant")).toBe(true);
    expect(isValidOpenCodeModel("a.b_c:d/e@f[g]-h")).toBe(true);
    // Three characters is the floor, so "a/b" is already enough.
    expect(isValidOpenCodeModel("a/b")).toBe(true);
  });

  it("rejects what the backend rejects", () => {
    // A bare name is not enough — opencode wants provider/model, so the
    // slash has to be strictly INSIDE the value.
    expect(isValidOpenCodeModel("haiku")).toBe(false);
    expect(isValidOpenCodeModel("ab")).toBe(false); // two characters is under the floor
    expect(isValidOpenCodeModel("/foo")).toBe(false); // slash at the front
    expect(isValidOpenCodeModel("foo/")).toBe(false); // slash at the end
    expect(isValidOpenCodeModel("a b/c")).toBe(false); // whitespace
    expect(isValidOpenCodeModel("")).toBe(false);
  });

  it("treats a missing value as invalid", () => {
    expect(isValidOpenCodeModel(null)).toBe(false);
    expect(isValidOpenCodeModel(undefined)).toBe(false);
  });
});

describe("CLI_MODEL_RE", () => {
  it("is the shape the backend's own validator uses", () => {
    // A direct assertion on the regex, so a change to the character class
    // is visible here rather than only as a behavioural drift.
    expect(CLI_MODEL_RE.source).toBe("^[A-Za-z0-9][A-Za-z0-9._:/@[\\]-]{0,127}$");
  });
});
