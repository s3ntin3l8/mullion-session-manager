import { describe, it, expect, afterEach, beforeEach } from "vitest";
import path from "node:path";
import {
  resolveForwarderPath,
  resolveOpenCodePluginPath,
  escapeTomlBasicString,
} from "../../../src/services/hook-adapters/shared.js";

// Issue #259: Codex trusts the merged hook's command by hash, so a
// realpathed, per-release forwarder path silently re-triggers Codex's
// one-time `/hooks` trust prompt on every Mullion upgrade. Resolving through
// the versioned-release install's stable `current` symlink instead (when
// MULLION_HOME is set) keeps the command — and the hash — identical across
// upgrades.
describe("resolveForwarderPath / resolveOpenCodePluginPath (issue #259 stable path)", () => {
  const originalMullionHome = process.env.MULLION_HOME;

  beforeEach(() => {
    delete process.env.MULLION_HOME;
  });

  afterEach(() => {
    if (originalMullionHome === undefined) delete process.env.MULLION_HOME;
    else process.env.MULLION_HOME = originalMullionHome;
  });

  it("resolves via this module's own location when MULLION_HOME is unset (dev checkout)", () => {
    expect(resolveForwarderPath()).not.toContain("current");
    expect(resolveForwarderPath().endsWith(path.join("hooks", "forwarder.mjs"))).toBe(true);
  });

  it("resolves through the stable current/ symlink when MULLION_HOME is set", () => {
    process.env.MULLION_HOME = "/home/alice/opt/mullion";
    expect(resolveForwarderPath()).toBe(
      path.join("/home/alice/opt/mullion", "current", "dist", "hooks", "forwarder.mjs"),
    );
  });

  it("treats a blank MULLION_HOME the same as unset", () => {
    process.env.MULLION_HOME = "   ";
    expect(resolveForwarderPath()).not.toContain("current");
  });

  it("applies the same stable-path resolution to the OpenCode plugin path", () => {
    process.env.MULLION_HOME = "/home/alice/opt/mullion";
    expect(resolveOpenCodePluginPath()).toBe(
      path.join("/home/alice/opt/mullion", "current", "dist", "hooks", "opencode-plugin.js"),
    );
  });
});

// Hermes review, PR #930 — the original version only escaped backslash and
// double-quote; TOML basic strings forbid literal control characters
// outright, and this function is now shared beyond codex-skills.ts's
// original narrow use (skill names), so a future caller feeding
// less-trusted input through it needs this covered.
describe("escapeTomlBasicString (issue #880 / Hermes review, PR #930)", () => {
  it("escapes backslash before quote, so an embedded backslash isn't re-escaped by the quote pass", () => {
    expect(escapeTomlBasicString('a\\b"c')).toBe('a\\\\b\\"c');
  });

  it("uses TOML's own short escapes for \\b \\t \\n \\f \\r", () => {
    expect(escapeTomlBasicString("\b\t\n\f\r")).toBe("\\b\\t\\n\\f\\r");
  });

  it("falls back to \\uXXXX for a control character with no short escape", () => {
    expect(escapeTomlBasicString("a\x01b\x1fc\x7fd")).toBe("a\\u0001b\\u001fc\\u007fd");
  });

  it("leaves ordinary text untouched", () => {
    expect(escapeTomlBasicString("/opt/mullion/dist/mcp/server.mjs")).toBe(
      "/opt/mullion/dist/mcp/server.mjs",
    );
  });
});
