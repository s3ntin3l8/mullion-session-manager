import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSkillFrontmatter } from "../../../src/services/skills.js";
import {
  deriveAgyAgentFile,
  deriveOpenCodeReviewerAgentFile,
} from "../../../src/services/hook-adapters/mullion-bundle.js";

// Phase 5 (issue #1210's plan, Gap C) — src/bundle/agents/reviewer.md is
// Mullion's first shipped subagent. bundle-sync.test.ts's own AGENT_TARGETS
// coverage is thorough but entirely against synthetic writeAgent() fixtures
// (MULLION_HOME redirected to a scratch dir) — none of it ever runs the
// REAL translator functions against this file's own REAL content. That gap
// matters here specifically: mullion-bundle.ts's own doc comment on
// deriveOpenCodeReviewerAgentFile records a LIVE failure mode (opencode
// 1.18.23's config loader hard-rejects an unexpected `tools:`/`model:` key
// and the session never starts), so this file's content has to be verified
// against the real translators, not just asserted to "look right" by eye.
const agentPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "src",
  "bundle",
  "agents",
  "reviewer.md",
);

const raw = readFileSync(agentPath, "utf8");

describe("shipped bundle agent (src/bundle/agents/reviewer.md) — real content, real translators", () => {
  it("parses under the same frontmatter parser bundle-sync.ts's AGENT_TARGETS loop uses", () => {
    const parsed = parseSkillFrontmatter(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.name).toBe("mullion-reviewer");
    expect(parsed?.description.length).toBeGreaterThan(0);
  });

  it("claude-code's own AGENT_TARGETS transform is a verbatim copy (nothing to translate)", () => {
    // Mirrors AGENT_TARGETS' own claude-code entry (bundle-sync.ts):
    // `transform: (raw) => raw`.
    expect(raw).toContain("tools: Read, Grep, Glob, Bash");
    expect(raw).toContain("model: inherit");
  });

  it("translates cleanly for agy — name/description kept, tools/model dropped", () => {
    const result = deriveAgyAgentFile(raw);
    expect(result).not.toBeNull();
    expect(result?.name).toBe("mullion-reviewer");
    expect(result?.contents).toContain("name: mullion-reviewer");
    expect(result?.contents).toContain("description:");
    expect(result?.contents).not.toContain("tools:");
    expect(result?.contents).not.toContain("model:");
  });

  // The specific, documented opencode hazard this test exists to guard: a
  // `tools:`/`model:` key reaching opencode's own config loader hard-fails
  // it. deriveOpenCodeReviewerAgentFile is supposed to rebuild the
  // frontmatter from scratch (description + mode only) regardless of what
  // the source carries — assert that against THIS file's real content, not
  // a synthetic fixture that was authored to already be safe.
  it("translates cleanly for opencode — no tools/model/name key ever reaches opencode's config loader", () => {
    const result = deriveOpenCodeReviewerAgentFile(raw);
    expect(result).not.toBeNull();
    expect(result?.contents).toContain("mode: subagent");
    expect(result?.contents).toContain("description:");
    expect(result?.contents).not.toContain("tools:");
    expect(result?.contents).not.toContain("model:");
    expect(result?.contents).not.toContain("name:");
  });

  it("carries no repo-specific invariants — the scaffold's per-project reviewer owns those, not this one", () => {
    // Plan's own design line: "deliberately no repo-specific invariants" —
    // a regression here (e.g. hand-pasting mullion-reviewer.md's own
    // content into this file by mistake) would ship Mullion's OWN repo
    // rules to every project this bundle installs into.
    const bodyNoFrontmatter = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
    expect(bodyNoFrontmatter).not.toMatch(/opaque-blob|NODE_ENV=test|dtach|systemd/i);
  });
});
