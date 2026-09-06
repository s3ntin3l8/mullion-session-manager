import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  syncBundleContent,
  removeBundleContent,
  removeBundleContentForCli,
  isBundleSyncedFor,
  computeBundleContentHash,
  resolveBundleSyncManifestPath,
  readBundleSyncManifest,
  getBundleSyncStatus,
  uninstallBundleContent,
  runBundleSyncExclusive,
  type BundleSyncCli,
} from "../../src/services/bundle-sync.js";
import { resolveClaudeConfigDir } from "../../src/services/hook-adapters/claude-code.js";
import { resolveCodexAgentsSkillsDir } from "../../src/services/hook-adapters/codex.js";
import {
  resolveAgyGlobalSkillsDir,
  resolveAgyGlobalAgentsDir,
  resolveAgyMcpConfigPath,
} from "../../src/services/hook-adapters/agy.js";
import { resolveOpenCodeConfigHome } from "../../src/services/hook-adapters/opencode-skills.js";
import {
  installBundleSkills,
  INSTALLED_MARKER_NAME,
  INSTALLED_MARKER_CONTENT,
  INSTALLED_AGENT_MARKER,
} from "../../src/services/hook-adapters/mullion-bundle.js";

// This whole suite exercises real filesystem paths derived from
// os.homedir() (the manifest, and all four CLIs' skill/agent roots) and
// from MULLION_HOME (the shipped bundle itself) — HOME/MULLION_HOME are
// redirected to scratch directories for every test, same pattern
// agy.test.ts/codex.test.ts already use for their own os.homedir()-derived
// paths, and mullion-bundle.test.ts already uses for MULLION_HOME.
const originalHome = process.env.HOME;
const originalMullionHome = process.env.MULLION_HOME;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

let homeDir: string;
let mullionHomeDir: string;

function bundleDir(): string {
  return path.join(mullionHomeDir, "current", "dist", "bundle");
}

function writeSkill(name: string, content?: string): void {
  const dir = path.join(bundleDir(), "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    content ?? `---\nname: ${name}\ndescription: "The ${name} skill."\n---\n\nBody for ${name}.\n`,
  );
}

function writeAgent(name: string, content?: string): void {
  const dir = path.join(bundleDir(), "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `${name}.md`),
    content ??
      `---\nname: ${name}\ndescription: "The ${name} reviewer."\ntools: Read, Grep\nmodel: inherit\n---\n\nReview body for ${name}.\n`,
  );
}

beforeEach(() => {
  homeDir = mkdtempSync(path.join(os.tmpdir(), "mullion-bundle-sync-fakehome-"));
  mullionHomeDir = mkdtempSync(path.join(os.tmpdir(), "mullion-bundle-sync-fakebundle-"));
  process.env.HOME = homeDir;
  process.env.MULLION_HOME = mullionHomeDir;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalMullionHome === undefined) delete process.env.MULLION_HOME;
  else process.env.MULLION_HOME = originalMullionHome;
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(mullionHomeDir, { recursive: true, force: true });
});

describe("syncBundleContent — missing bundle", () => {
  it("is a clean no-op when resolveMullionBundleDir() returns null", () => {
    process.env.MULLION_HOME = "/nonexistent/mullion/home";
    expect(() => syncBundleContent()).not.toThrow();
    expect(syncBundleContent()).toEqual({ changed: false });
    expect(existsSync(resolveBundleSyncManifestPath())).toBe(false);
  });
});

describe("syncBundleContent — per-CLI target paths and prefixing", () => {
  it("installs a shipped skill as mullion-<name>/ under every CLI's own skills root", () => {
    writeSkill("host");
    const result = syncBundleContent();
    expect(result.changed).toBe(true);

    const targets = [
      path.join(resolveClaudeConfigDir(), "skills"),
      resolveCodexAgentsSkillsDir(),
      resolveAgyGlobalSkillsDir(),
      path.join(resolveOpenCodeConfigHome(), "skills"),
    ];
    for (const root of targets) {
      const skillPath = path.join(root, "mullion-host", "SKILL.md");
      expect(existsSync(skillPath)).toBe(true);
    }
  });

  // Regression guard — historical mullion-mullion-* double-prefix bug
  // (mullion-bundle.ts's own comment on INSTALLED_SKILL_PREFIX/
  // installBundleSkills' prune logic).
  it("applies the mullion- prefix exactly once, never double-prefixing", () => {
    writeSkill("host");
    syncBundleContent();
    const root = path.join(resolveClaudeConfigDir(), "skills");
    const entries = readdirSync(root);
    expect(entries).toContain("mullion-host");
    expect(entries).not.toContain("mullion-mullion-host");
  });

  it("rewrites the installed skill's frontmatter name: to match the installed directory name", () => {
    writeSkill("host");
    syncBundleContent();
    const skillPath = path.join(resolveClaudeConfigDir(), "skills", "mullion-host", "SKILL.md");
    const content = readFileSync(skillPath, "utf8");
    expect(content).toContain("name: mullion-host");
    expect(content).not.toMatch(/^name: host$/m);
  });

  it("still writes the legacy .mullion-managed marker inside each installed skill dir", () => {
    writeSkill("host");
    syncBundleContent();
    const markerPath = path.join(
      resolveClaudeConfigDir(),
      "skills",
      "mullion-host",
      ".mullion-managed",
    );
    expect(existsSync(markerPath)).toBe(true);
  });

  it("writes the manifest at ~/.mullion/bundle-sync.json", () => {
    writeSkill("host");
    syncBundleContent();
    expect(existsSync(resolveBundleSyncManifestPath())).toBe(true);
    const manifest = JSON.parse(readFileSync(resolveBundleSyncManifestPath(), "utf8"));
    expect(manifest.version).toBe(1);
    expect(typeof manifest.bundleHash).toBe("string");
    expect(manifest.entries.length).toBeGreaterThan(0);
  });
});

describe("syncBundleContent — idempotence and change detection", () => {
  it("a second sync with unchanged content doesn't touch any installed file's mtime", async () => {
    writeSkill("host");
    syncBundleContent();
    const skillPath = path.join(resolveClaudeConfigDir(), "skills", "mullion-host", "SKILL.md");
    const mtimeBefore = statSync(skillPath).mtimeMs;

    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = syncBundleContent();

    expect(second.changed).toBe(false);
    expect(statSync(skillPath).mtimeMs).toBe(mtimeBefore);
  });

  it("a bundle content change (different hash) triggers re-sync on the next call with no force flag", async () => {
    writeSkill("host");
    syncBundleContent();
    const skillPath = path.join(resolveClaudeConfigDir(), "skills", "mullion-host", "SKILL.md");

    await new Promise((resolve) => setTimeout(resolve, 5));
    writeSkill("host", `---\nname: host\ndescription: "Updated description."\n---\n\nNew body.\n`);
    const second = syncBundleContent();

    expect(second.changed).toBe(true);
    expect(readFileSync(skillPath, "utf8")).toContain("Updated description.");
  });

  it("self-heals a hand-deleted installed skill even though the bundle hash is unchanged", () => {
    writeSkill("host");
    syncBundleContent();
    const skillDir = path.join(resolveClaudeConfigDir(), "skills", "mullion-host");
    rmSync(skillDir, { recursive: true, force: true });

    const second = syncBundleContent();

    expect(second.changed).toBe(true);
    expect(existsSync(path.join(skillDir, "SKILL.md"))).toBe(true);
  });

  it("self-heals a hand-edited installed skill even though the bundle hash is unchanged", () => {
    writeSkill("host");
    syncBundleContent();
    const skillPath = path.join(resolveClaudeConfigDir(), "skills", "mullion-host", "SKILL.md");
    writeFileSync(skillPath, "hand-edited, drifted content");

    const second = syncBundleContent();

    expect(second.changed).toBe(true);
    expect(readFileSync(skillPath, "utf8")).toContain("name: mullion-host");
  });

  // Regression test — codex's and agy's skill roots are targets of BOTH
  // this boot-time sync AND installBundleSkills' own per-launch call
  // (agy.ts's/codex.ts's managedInstall, left unchanged by this issue). A
  // review pass caught that a naive "copy verbatim, then separately
  // rewrite the frontmatter name" implementation would make the two
  // mechanisms permanently disagree about what "unchanged" means for
  // SKILL.md and thrash forever: installBundleSkills' own syncSkillDir
  // compares SOURCE bytes (bare `name: host`) against DEST bytes (already
  // rewritten to `name: mullion-host`), which never match, so every
  // codex/agy launch would stomp the name back to the bare source name —
  // which then makes the NEXT boot-time sync see a hash mismatch and
  // re-sync everything, which rewrites it again, forever. This proves the
  // fix: installBundleSkills reuses the exact same rewrite-aware compare
  // bundle-sync.ts uses, so the two converge on byte-identical content.
  it("installBundleSkills targeting the same root as a completed sync doesn't thrash the frontmatter rewrite", () => {
    writeSkill("host");
    syncBundleContent();
    const codexRoot = resolveCodexAgentsSkillsDir();
    const skillPath = path.join(codexRoot, "mullion-host", "SKILL.md");
    const contentAfterSync = readFileSync(skillPath, "utf8");
    expect(contentAfterSync).toContain("name: mullion-host");

    // codex's own per-launch fallback, called on every session spawn,
    // completely independently of bundle-sync's own manifest.
    installBundleSkills(codexRoot);

    expect(readFileSync(skillPath, "utf8")).toBe(contentAfterSync);
    // And the next boot-time sync sees no drift at all — no thrash loop.
    expect(syncBundleContent()).toEqual({ changed: false });
  });
});

describe("syncBundleContent — prune", () => {
  it("removes a manifest-tracked skill directory no longer shipped in the bundle", async () => {
    writeSkill("host");
    writeSkill("browser");
    syncBundleContent();
    const browserDir = path.join(resolveClaudeConfigDir(), "skills", "mullion-browser");
    expect(existsSync(browserDir)).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 5));
    rmSync(path.join(bundleDir(), "skills", "browser"), { recursive: true, force: true });
    const second = syncBundleContent();

    expect(second.changed).toBe(true);
    expect(existsSync(browserDir)).toBe(false);
    expect(existsSync(path.join(resolveClaudeConfigDir(), "skills", "mullion-host"))).toBe(true);
  });

  // Named after the historical mullion-mullion-host double-prefix bug
  // (mullion-bundle.ts) — a manifest-tracked, marker-carrying legacy path
  // that's no longer part of the current bundle gets removed by the same
  // manifest-diff prune, regardless of what it happens to be named.
  it("prunes a legacy mullion-mullion-host-shaped manifest entry that's no longer shipped", async () => {
    writeSkill("host");
    syncBundleContent();

    // Simulate a manifest from "before a hypothetical rename": hand-craft
    // a manifest entry pointing at a marker-carrying mullion-mullion-host
    // directory that isn't part of the current bundle's computed set.
    const legacyDir = path.join(resolveClaudeConfigDir(), "skills", "mullion-mullion-host");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(path.join(legacyDir, "SKILL.md"), "stale pre-rename content");
    writeFileSync(path.join(legacyDir, ".mullion-managed"), "managed");
    const manifestPath = resolveBundleSyncManifestPath();
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.entries.push({ path: legacyDir, kind: "dir", hash: "0".repeat(64) });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    await new Promise((resolve) => setTimeout(resolve, 5));
    writeSkill(
      "host",
      `---\nname: host\ndescription: "Changed to force a re-sync."\n---\n\nBody.\n`,
    );
    const result = syncBundleContent();

    expect(result.changed).toBe(true);
    expect(existsSync(legacyDir)).toBe(false);
    expect(existsSync(path.join(resolveClaudeConfigDir(), "skills", "mullion-host"))).toBe(true);
  });

  // Issue #947 — the core regression test. Unlike the "legacy
  // mullion-mullion-host-shaped manifest entry" test above (which hand-writes
  // a manifest entry FIRST, so it only proves the pre-existing manifest-diff
  // prune), this test never creates a manifest at all before the orphan
  // directory is planted: it reproduces BOTH real-world triggers at once —
  // (a) the very first sync on a host after an upgrade that renamed a
  // shipped skill (no manifest has ever been written yet), and (b) a
  // manifest that's been deleted out from under an otherwise-synced host.
  // Before the fix in bundle-sync.ts (pruneOrphanSkillDirs), syncBundleContent
  // never scanned its target roots at all — it only iterated shipped skill
  // names to install, and pruned whatever the (here, nonexistent) previous
  // manifest happened to list — so this orphan survived untouched. Verified
  // by running this test against the pre-fix source: it failed with
  // `existsSync(legacyDir)` still `true`.
  it("issue #947: discovers and removes a marker-carrying orphan directory with NO manifest entry at all (first-sync-after-upgrade / manifest-deleted case)", () => {
    writeSkill("host");

    // Plant the orphan directly on disk, exactly as a past
    // mullion-mullion-host -> mullion-host rename would leave behind on a
    // host that had already installed the OLD double-prefixed shape — with
    // no manifest ever written (this is the very first sync call).
    const legacyDir = path.join(resolveClaudeConfigDir(), "skills", "mullion-mullion-host");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(path.join(legacyDir, "SKILL.md"), "stale pre-rename content");
    writeFileSync(path.join(legacyDir, INSTALLED_MARKER_NAME), INSTALLED_MARKER_CONTENT);
    expect(existsSync(resolveBundleSyncManifestPath())).toBe(false);

    const result = syncBundleContent();

    expect(result.changed).toBe(true);
    expect(existsSync(legacyDir)).toBe(false);
    const hostDir = path.join(resolveClaudeConfigDir(), "skills", "mullion-host");
    expect(existsSync(hostDir)).toBe(true);
    expect(readFileSync(path.join(hostDir, "SKILL.md"), "utf8")).toContain("name: mullion-host");
  });

  // Mirrors the existing "PR #891 regression" test for uninstallBundleContent
  // above (same file) — a `mullion-`-prefixed directory that does NOT carry
  // the ownership marker must never be touched by the new orphan scan,
  // even with no manifest present at all. The prefix alone is only a naming
  // convention; the marker is the actual ownership test.
  it("issue #947 non-regression: never deletes a mullion-prefixed directory lacking the ownership marker, even with no manifest", () => {
    writeSkill("host");
    const userOwnedDir = path.join(resolveClaudeConfigDir(), "skills", "mullion-helper");
    mkdirSync(userOwnedDir, { recursive: true });
    writeFileSync(path.join(userOwnedDir, "SKILL.md"), "---\nname: mullion-helper\n---\nMine.\n");
    // Deliberately no INSTALLED_MARKER_NAME file.
    expect(existsSync(resolveBundleSyncManifestPath())).toBe(false);

    const result = syncBundleContent();

    expect(result.changed).toBe(true);
    expect(existsSync(userOwnedDir)).toBe(true);
    expect(readFileSync(path.join(userOwnedDir, "SKILL.md"), "utf8")).toBe(
      "---\nname: mullion-helper\n---\nMine.\n",
    );
  });

  // Codex's and agy's skill roots are targets of BOTH this module's own
  // orphan scan (pruneOrphanSkillDirs) AND installBundleSkills' pre-existing
  // orphan scan (their per-launch managedInstall step) — the two must never
  // fight over the same directory. This plants an orphan, runs
  // syncBundleContent's prune first, then immediately runs
  // installBundleSkills against the SAME root and asserts the second pass
  // finds nothing further to remove and the shipped skill stays intact.
  it("issue #947: syncBundleContent's orphan-prune and installBundleSkills' own orphan-prune agree and don't fight on the same root", () => {
    writeSkill("host");
    const codexRoot = resolveCodexAgentsSkillsDir();
    const legacyDir = path.join(codexRoot, "mullion-mullion-host");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(path.join(legacyDir, "SKILL.md"), "stale pre-rename content");
    writeFileSync(path.join(legacyDir, INSTALLED_MARKER_NAME), INSTALLED_MARKER_CONTENT);

    const result = syncBundleContent();
    expect(result.changed).toBe(true);
    expect(existsSync(legacyDir)).toBe(false);
    const hostDir = path.join(codexRoot, "mullion-host");
    expect(existsSync(hostDir)).toBe(true);

    // Second, independent pass (simulating codex's own per-launch
    // managedInstall step) over the exact same root: must be a pure no-op
    // for the already-correct, already-pruned state above.
    const beforeEntries = readdirSync(codexRoot).sort();
    installBundleSkills(codexRoot);
    const afterEntries = readdirSync(codexRoot).sort();

    expect(afterEntries).toEqual(beforeEntries);
    expect(existsSync(hostDir)).toBe(true);
    expect(existsSync(legacyDir)).toBe(false);
  });

  // Issue #1090 — the AGENT_TARGETS counterpart to the #947 test above:
  // AGENT_TARGETS had the IDENTICAL structural gap (no orphan-discovery at
  // all, only ever a manifest-diff prune), for the same two real-world
  // triggers — no manifest has ever been written yet (first sync after an
  // upgrade that renamed a shipped agent), or the manifest was
  // deleted/corrupted out from under an otherwise-synced host. Plants the
  // orphan directly on disk, WITH the ownership marker, and never creates a
  // manifest before syncing.
  it("issue #1090: discovers and removes a marker-carrying orphan agent file with NO manifest entry at all (first-sync-after-rename / manifest-deleted case)", () => {
    writeSkill("host");
    writeAgent("reviewer");

    const claudeAgentsDir = path.join(resolveClaudeConfigDir(), "agents");
    mkdirSync(claudeAgentsDir, { recursive: true });
    const orphanPath = path.join(claudeAgentsDir, "mullion-orphan.md");
    writeFileSync(
      orphanPath,
      `---\nname: orphan\ndescription: "Stale renamed agent."\n---\n\nStale body.\n${INSTALLED_AGENT_MARKER}\n`,
    );
    expect(existsSync(resolveBundleSyncManifestPath())).toBe(false);

    const result = syncBundleContent();

    expect(result.changed).toBe(true);
    expect(existsSync(orphanPath)).toBe(false);
    const reviewerPath = path.join(claudeAgentsDir, "mullion-reviewer.md");
    expect(existsSync(reviewerPath)).toBe(true);
  });

  // Mirrors the skill-directory non-regression test above — a
  // `mullion-`-prefixed `.md` file that does NOT carry
  // `INSTALLED_AGENT_MARKER` must never be touched by the new orphan scan,
  // even with no manifest present at all. The prefix alone is only a naming
  // convention; the in-body marker is the actual ownership test.
  it("issue #1090 non-regression: never deletes a mullion-prefixed agent file lacking the ownership marker, even with no manifest", () => {
    writeSkill("host");
    writeAgent("reviewer");

    const claudeAgentsDir = path.join(resolveClaudeConfigDir(), "agents");
    mkdirSync(claudeAgentsDir, { recursive: true });
    const userOwnedPath = path.join(claudeAgentsDir, "mullion-helper.md");
    writeFileSync(userOwnedPath, "---\nname: mullion-helper\n---\nMine.\n");
    // Deliberately no INSTALLED_AGENT_MARKER line.
    expect(existsSync(resolveBundleSyncManifestPath())).toBe(false);

    const result = syncBundleContent();

    expect(result.changed).toBe(true);
    expect(existsSync(userOwnedPath)).toBe(true);
    expect(readFileSync(userOwnedPath, "utf8")).toBe("---\nname: mullion-helper\n---\nMine.\n");
  });

  // Regression test for a review finding on this same issue's own PR: the
  // orphan scan's "names just (re)installed" protect-set must be computed
  // PER TARGET, from what THAT target actually installed this pass — never
  // a single set shared across all of AGENT_TARGETS. `target.transform` can
  // reject a name independently per CLI (unparseable/unsafe frontmatter —
  // opencode/agy both do via parseSkillFrontmatter/isDangerousSkillName),
  // so a name that installs fine for claude-code but is rejected by
  // opencode's own transform must NOT protect a stale same-named file under
  // opencode's root just because claude-code's protect-set happens to
  // include it.
  it("issue #1090: a name installed for one target does not protect a same-named orphan under a target whose own transform declined it", () => {
    writeSkill("host");
    // "broken" has unparseable frontmatter: claude-code's transform is
    // verbatim passthrough (installs it regardless), but opencode's/agy's
    // transforms both reject it via parseSkillFrontmatter, returning null.
    writeAgent("broken", "not frontmatter at all");

    // A stale marker-carrying mullion-broken.md sitting under opencode's
    // own agent root — left over from some earlier state where it WAS
    // installable there — that opencode's transform does NOT reinstall
    // this pass.
    const opencodeAgentDir = path.join(resolveOpenCodeConfigHome(), "agent");
    mkdirSync(opencodeAgentDir, { recursive: true });
    const staleOpencodePath = path.join(opencodeAgentDir, "mullion-broken.md");
    writeFileSync(
      staleOpencodePath,
      `---\ndescription: "stale"\nmode: subagent\n---\n\nStale.\n${INSTALLED_AGENT_MARKER}\n`,
    );

    const result = syncBundleContent();

    expect(result.changed).toBe(true);
    // claude-code DID (re)install "broken" verbatim this exact pass.
    expect(existsSync(path.join(resolveClaudeConfigDir(), "agents", "mullion-broken.md"))).toBe(
      true,
    );
    // ...but opencode's own stale copy must still be pruned: opencode's own
    // transform rejected "broken" THIS pass, so nothing legitimately
    // protects it there, regardless of what any other target installed.
    expect(existsSync(staleOpencodePath)).toBe(false);
  });

  // isCurrentMullionManagedFile requires the marker as the file's own
  // TRAILING line, not merely present anywhere in the body — a bare
  // `.includes()` would misidentify a user's own file that happens to
  // quote/document the marker string (e.g. this very module's own doc
  // comments, or this repo's docs, contain the literal string) as
  // Mullion-owned. Same "prefix alone isn't ownership" caution as PR #891,
  // applied to the marker itself.
  it("issue #1090: never deletes a mullion-prefixed agent file that only quotes the marker string mid-body, without it as the trailing line", () => {
    writeSkill("host");
    writeAgent("reviewer");

    const claudeAgentsDir = path.join(resolveClaudeConfigDir(), "agents");
    mkdirSync(claudeAgentsDir, { recursive: true });
    const quotingPath = path.join(claudeAgentsDir, "mullion-quoting.md");
    writeFileSync(
      quotingPath,
      `---\nname: mullion-quoting\n---\n\nDocumenting Mullion's own marker: ${INSTALLED_AGENT_MARKER}\n\nMore of my own content after it.\n`,
    );

    const result = syncBundleContent();

    expect(result.changed).toBe(true);
    expect(existsSync(quotingPath)).toBe(true);
  });

  // pruneOrphanManagedFiles' `entry.isFile()` guard — a directory that
  // happens to be named like a `mullion-*.md` agent file (however
  // implausible) must never be treated as a candidate for the file-kind
  // scan, symmetric with pruneOrphanManagedDirs' own `entry.isDirectory()`
  // guard for skill directories.
  it("issue #1090: never touches a directory that happens to be named like a mullion-*.md agent file", () => {
    writeSkill("host");
    writeAgent("reviewer");

    const claudeAgentsDir = path.join(resolveClaudeConfigDir(), "agents");
    const lookalikeDir = path.join(claudeAgentsDir, "mullion-lookalike.md");
    mkdirSync(lookalikeDir, { recursive: true });
    writeFileSync(path.join(lookalikeDir, "inner.txt"), INSTALLED_AGENT_MARKER);

    const result = syncBundleContent();

    expect(result.changed).toBe(true);
    expect(existsSync(lookalikeDir)).toBe(true);
  });
});

describe("syncBundleContent — manifest atomicity and corruption", () => {
  it("leaves no .tmp file behind after a successful run", () => {
    writeSkill("host");
    syncBundleContent();
    const dir = path.dirname(resolveBundleSyncManifestPath());
    const leftovers = readdirSync(dir).filter((name) => name.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("treats a corrupt/unparseable existing manifest as no manifest, rather than crashing", () => {
    writeSkill("host");
    const manifestPath = resolveBundleSyncManifestPath();
    mkdirSync(path.dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, "{ not valid json");

    expect(() => syncBundleContent()).not.toThrow();
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.version).toBe(1);
  });
});

describe("computeBundleContentHash", () => {
  it("changes when a skill's content changes", () => {
    writeSkill("host");
    const before = computeBundleContentHash(bundleDir());
    writeSkill("host", `---\nname: host\ndescription: "Different."\n---\n\nBody.\n`);
    const after = computeBundleContentHash(bundleDir());
    expect(after).not.toBe(before);
  });

  it("is stable across calls with no content change", () => {
    writeSkill("host");
    expect(computeBundleContentHash(bundleDir())).toBe(computeBundleContentHash(bundleDir()));
  });
});

describe("syncBundleContent — agent install (fixture-based, src/bundle/agents/ doesn't exist yet)", () => {
  it("is a no-op for agents when the bundle ships no agents/ directory at all", () => {
    writeSkill("host");
    syncBundleContent();
    expect(existsSync(path.join(resolveClaudeConfigDir(), "agents"))).toBe(false);
  });

  it("installs a verbatim copy for claude-code, plus the installed-agent ownership marker", () => {
    writeSkill("host");
    writeAgent("reviewer");
    syncBundleContent();
    const destPath = path.join(resolveClaudeConfigDir(), "agents", "mullion-reviewer.md");
    expect(existsSync(destPath)).toBe(true);
    const raw = readFileSync(path.join(bundleDir(), "agents", "reviewer.md"), "utf8");
    const installed = readFileSync(destPath, "utf8");
    // Issue #1090 — claude-code's transform is still verbatim passthrough,
    // but the installed file also carries the ownership marker every
    // AGENT_TARGETS install now appends, so it's no longer byte-identical
    // to the shipped source.
    expect(installed).toBe(`${raw.replace(/\n+$/, "")}\n${INSTALLED_AGENT_MARKER}\n`);
    expect(installed).toContain(INSTALLED_AGENT_MARKER);
  });

  it("applies the opencode transform (description/mode only, tools/model dropped) under agent/ (singular)", () => {
    writeSkill("host");
    writeAgent("reviewer");
    syncBundleContent();
    const destPath = path.join(resolveOpenCodeConfigHome(), "agent", "mullion-reviewer.md");
    expect(existsSync(destPath)).toBe(true);
    const contents = readFileSync(destPath, "utf8");
    expect(contents).toContain("mode: subagent");
    expect(contents).not.toContain("tools:");
    expect(contents).not.toContain("model:");
  });

  it("applies the agy transform (flat file, name+description kept, tools/model dropped) under its own agents dir", () => {
    writeSkill("host");
    writeAgent("reviewer");
    syncBundleContent();
    const destPath = path.join(resolveAgyGlobalAgentsDir(), "mullion-reviewer.md");
    expect(existsSync(destPath)).toBe(true);
    const contents = readFileSync(destPath, "utf8");
    expect(contents).toContain("name: reviewer");
    expect(contents).not.toContain("tools:");
    expect(contents).not.toContain("model:");
  });

  it("never installs an agent for codex — codex has no static per-agent file format", () => {
    writeSkill("host");
    writeAgent("reviewer");
    syncBundleContent();
    // codex's skills root gets the skill, but nothing agent-shaped anywhere
    // under its home-relative tree.
    expect(existsSync(path.join(os.homedir(), ".agents", "agents"))).toBe(false);
  });

  it("silently skips an agent with unparseable frontmatter for opencode/agy without failing the whole sync", () => {
    writeSkill("host");
    writeAgent("broken", "not frontmatter at all");
    const result = syncBundleContent();
    expect(result.changed).toBe(true);
    // claude-code copies verbatim regardless of parseability.
    expect(existsSync(path.join(resolveClaudeConfigDir(), "agents", "mullion-broken.md"))).toBe(
      true,
    );
    expect(existsSync(path.join(resolveOpenCodeConfigHome(), "agent", "mullion-broken.md"))).toBe(
      false,
    );
    expect(existsSync(path.join(resolveAgyGlobalAgentsDir(), "mullion-broken.md"))).toBe(false);
  });
});

describe("removeBundleContent", () => {
  it("removes every manifest-listed path and the manifest itself", () => {
    writeSkill("host");
    writeAgent("reviewer");
    syncBundleContent();
    const claudeSkill = path.join(resolveClaudeConfigDir(), "skills", "mullion-host");
    const claudeAgent = path.join(resolveClaudeConfigDir(), "agents", "mullion-reviewer.md");
    expect(existsSync(claudeSkill)).toBe(true);
    expect(existsSync(claudeAgent)).toBe(true);

    removeBundleContent();

    expect(existsSync(claudeSkill)).toBe(false);
    expect(existsSync(claudeAgent)).toBe(false);
    expect(existsSync(resolveBundleSyncManifestPath())).toBe(false);
  });

  it("is a no-op, not a throw, when there is no manifest at all", () => {
    expect(() => removeBundleContent()).not.toThrow();
  });
});

describe("removeBundleContentForCli (issue #1079)", () => {
  it("is a no-op with a clear zero result when nothing is installed at all", async () => {
    const result = await removeBundleContentForCli("claude-code");
    expect(result).toEqual({ skillsRemoved: 0, agentsRemoved: 0 });
  });

  it("removes exactly this CLI's own skill + agent content, on disk and from the manifest", async () => {
    writeSkill("host");
    writeAgent("reviewer");
    syncBundleContent();

    const claudeSkill = path.join(resolveClaudeConfigDir(), "skills", "mullion-host");
    const claudeAgent = path.join(resolveClaudeConfigDir(), "agents", "mullion-reviewer.md");
    expect(existsSync(claudeSkill)).toBe(true);
    expect(existsSync(claudeAgent)).toBe(true);

    const result = await removeBundleContentForCli("claude-code");
    expect(result.skillsRemoved).toBeGreaterThan(0);
    expect(result.agentsRemoved).toBeGreaterThan(0);

    expect(existsSync(claudeSkill)).toBe(false);
    expect(existsSync(claudeAgent)).toBe(false);
  });

  // The critical regression this function exists specifically to avoid:
  // removeBundleContent() (whole-host) would also wipe codex's and agy's
  // own installed content — this must not.
  it("leaves codex's and agy's installed content, and opencode's, completely untouched", async () => {
    writeSkill("host");
    writeAgent("reviewer");
    syncBundleContent();

    const codexSkill = path.join(resolveCodexAgentsSkillsDir(), "mullion-host");
    const agySkill = path.join(resolveAgyGlobalSkillsDir(), "mullion-host");
    const agyAgent = path.join(resolveAgyGlobalAgentsDir(), "mullion-reviewer.md");
    const opencodeSkill = path.join(resolveOpenCodeConfigHome(), "skills", "mullion-host");
    const opencodeAgent = path.join(resolveOpenCodeConfigHome(), "agent", "mullion-reviewer.md");
    for (const p of [codexSkill, agySkill, agyAgent, opencodeSkill, opencodeAgent]) {
      expect(existsSync(p)).toBe(true);
    }

    await removeBundleContentForCli("claude-code");

    for (const p of [codexSkill, agySkill, agyAgent, opencodeSkill, opencodeAgent]) {
      expect(existsSync(p)).toBe(true);
    }
    // codex has no marker check of its own to break (no AGENT_TARGETS
    // entry — see that table's own comment), but agy's skill dir marker
    // must still be intact, not just the directory's presence.
    expect(existsSync(path.join(agySkill, INSTALLED_MARKER_NAME))).toBe(true);

    // The manifest-driven status surface must agree: codex/agy/opencode
    // still report synced, only claude-code doesn't.
    expect(isBundleSyncedFor("claude-code")).toBe(false);
    expect(isBundleSyncedFor("codex")).toBe(true);
    expect(isBundleSyncedFor("agy")).toBe(true);
    expect(isBundleSyncedFor("opencode")).toBe(true);
  });

  // The stale-manifest bug this function must not have: pruning only the
  // agent-file manifest entries and leaving the skill-dir entry behind
  // would make isBundleSyncedFor("claude-code") keep reporting `true` even
  // though the skill directory is actually gone from disk — which would
  // make claude-code.ts's own `else if (!isBundleSyncedFor("claude-code"))`
  // branch wrongly skip re-emitting the per-session fallback pointer the
  // next time the setting is turned back on before this host's next full
  // resync.
  it("drops BOTH the skill-dir and agent-file manifest entries for this CLI, not just the agent one", async () => {
    writeSkill("host");
    writeAgent("reviewer");
    syncBundleContent();

    await removeBundleContentForCli("claude-code");

    expect(isBundleSyncedFor("claude-code")).toBe(false);
  });

  // Review finding on PR #1095/#1079 — the agent-file branch used to drop
  // its manifest entry unconditionally, even when `unlinkSync` failed for a
  // reason other than "already gone" (EACCES/EBUSY). That both orphans the
  // file (nothing else will ever try to remove it again until the next full
  // syncBundleContent resync happens to re-adopt it) and lies in
  // `agentsRemoved`'s count. Mirrors the skill-dir branch's own
  // already-tested `!existsSync` gate a few tests up.
  it("keeps the manifest entry for an agent file that fails to unlink for a reason other than already-gone", async () => {
    writeSkill("host");
    writeAgent("reviewer");
    syncBundleContent();

    const agentsDir = path.join(resolveClaudeConfigDir(), "agents");
    chmodSync(agentsDir, 0o500); // read+execute, no write — unlink needs write on the containing dir
    try {
      const result = await removeBundleContentForCli("claude-code");
      expect(result.agentsRemoved).toBe(0);
    } finally {
      chmodSync(agentsDir, 0o700);
    }

    const agentFilePath = path.join(agentsDir, "mullion-reviewer.md");
    expect(existsSync(agentFilePath)).toBe(true);
    // The manifest entry must have survived too — not just the file itself
    // — so a later removal attempt can still find and retry it.
    // isBundleSyncedFor deliberately only ever consults SKILL_TARGETS (see
    // its own definition), so it can't see an agent-file entry either way —
    // read the manifest directly instead.
    const manifest = readBundleSyncManifest();
    expect(manifest?.entries.some((entry) => entry.path === agentFilePath)).toBe(true);
  });

  it("PR #891-style regression: never deletes a mullion-prefixed skill directory lacking the ownership marker", async () => {
    const userOwnedDir = path.join(resolveClaudeConfigDir(), "skills", "mullion-helper");
    mkdirSync(userOwnedDir, { recursive: true });
    writeFileSync(path.join(userOwnedDir, "SKILL.md"), "---\nname: mullion-helper\n---\nMine.\n");
    // Deliberately no INSTALLED_MARKER_NAME file.

    const result = await removeBundleContentForCli("claude-code");
    expect(result.skillsRemoved).toBe(0);
    expect(existsSync(userOwnedDir)).toBe(true);
  });

  // removeBundleContentForCli only ever removes manifest-tracked file
  // entries for this one CLI (see its own doc comment) — it does NOT run
  // the orphan-marker scan issue #1090 added to syncBundleContent's own
  // AGENT_TARGETS loop. A markerless stray genuinely should survive this
  // path regardless: that's the correct, deliberate non-regression
  // guarantee (a marker-carrying stray is now discoverable too, but only by
  // a real sync pass — see the "issue #1090" tests in the
  // "syncBundleContent — prune" describe block above) — not a gap this test
  // is settling for.
  it("agent-file removal is manifest-only: a stray markerless mullion-<name>.md agent file is left alone", async () => {
    writeSkill("host");
    writeAgent("reviewer");
    syncBundleContent();

    const strayAgentPath = path.join(resolveClaudeConfigDir(), "agents", "mullion-orphan.md");
    writeFileSync(strayAgentPath, "---\nname: orphan\ndescription: stray\n---\nBody.\n");

    await removeBundleContentForCli("claude-code");

    expect(existsSync(strayAgentPath)).toBe(true);
  });

  it("is safe to call twice in a row (idempotent, no throw)", async () => {
    writeSkill("host");
    writeAgent("reviewer");
    syncBundleContent();

    await removeBundleContentForCli("opencode");
    await expect(removeBundleContentForCli("opencode")).resolves.toEqual({
      skillsRemoved: 0,
      agentsRemoved: 0,
    });
  });
});

describe("isBundleSyncedFor", () => {
  it("is false for every CLI before any sync has run", () => {
    expect(isBundleSyncedFor("claude-code")).toBe(false);
    expect(isBundleSyncedFor("codex")).toBe(false);
    expect(isBundleSyncedFor("agy")).toBe(false);
    expect(isBundleSyncedFor("opencode")).toBe(false);
  });

  it("is true for every CLI once a skill has been synced", () => {
    writeSkill("host");
    syncBundleContent();
    expect(isBundleSyncedFor("claude-code")).toBe(true);
    expect(isBundleSyncedFor("codex")).toBe(true);
    expect(isBundleSyncedFor("agy")).toBe(true);
    expect(isBundleSyncedFor("opencode")).toBe(true);
  });

  it("is false again after removeBundleContent", () => {
    writeSkill("host");
    syncBundleContent();
    removeBundleContent();
    expect(isBundleSyncedFor("claude-code")).toBe(false);
  });
});

describe("readBundleSyncManifest", () => {
  it("is null before any sync has run", () => {
    expect(readBundleSyncManifest()).toBeNull();
  });

  it("returns the same manifest syncBundleContent wrote", () => {
    writeSkill("host");
    syncBundleContent();
    const manifest = readBundleSyncManifest();
    expect(manifest?.version).toBe(1);
    expect(manifest?.entries.length).toBeGreaterThan(0);
  });
});

describe("getBundleSyncStatus", () => {
  const NO_DETECTED = new Set<BundleSyncCli>();

  it("marks every CLI's skills and agents rows 'disabled' when the setting is off, with no manifest read at all", () => {
    writeSkill("host");
    writeAgent("reviewer");
    syncBundleContent(); // populate a manifest that a disabled read must ignore
    const status = getBundleSyncStatus({ enabled: false, detectedClis: NO_DETECTED });
    expect(status.enabled).toBe(false);
    expect(status.bundleHash).toBeNull();
    expect(status.clis).toHaveLength(4);
    for (const cli of status.clis) {
      expect(cli.skills.status).toBe("disabled");
      expect(cli.skills.count).toBe(0);
      expect(cli.agents.status).toBe("disabled");
      expect(cli.agents.count).toBe(0);
      expect(cli.detected).toBe(false);
    }
  });

  it("is 'not-synced' for every CLI when enabled but nothing has ever synced", () => {
    const status = getBundleSyncStatus({ enabled: true, detectedClis: NO_DETECTED });
    expect(status.bundleHash).toBeNull();
    for (const cli of status.clis) {
      expect(cli.skills.status).toBe("not-synced");
      if (cli.cli === "codex") {
        expect(cli.agents.status).toBe("n-a");
      } else {
        expect(cli.agents.status).toBe("not-synced");
      }
    }
  });

  it("today's shipped bundle ships no agents/ directory at all, so a real sync still leaves every agent-capable CLI's agents row 'not-synced' with count 0", () => {
    // Deliberately no writeAgent() call — src/bundle/agents/ doesn't exist
    // in this repo yet (#943/#953's job), and getBundleSyncStatus must not
    // be surprised by that once it ships: skills sync fine, agents stay
    // untouched everywhere except codex's unconditional "n-a".
    writeSkill("host");
    syncBundleContent();
    const status = getBundleSyncStatus({ enabled: true, detectedClis: NO_DETECTED });
    for (const cli of status.clis) {
      expect(cli.skills.status).toBe("synced");
      if (cli.cli === "codex") {
        expect(cli.agents.status).toBe("n-a");
      } else {
        expect(cli.agents.status).toBe("not-synced");
        expect(cli.agents.count).toBe(0);
      }
    }
  });

  it("is 'synced' with a count once skills and agents have synced cleanly", () => {
    writeSkill("host");
    writeAgent("reviewer");
    syncBundleContent();
    const status = getBundleSyncStatus({ enabled: true, detectedClis: NO_DETECTED });
    const claude = status.clis.find((c) => c.cli === "claude-code")!;
    expect(claude.skills).toEqual({
      status: "synced",
      root: path.join(resolveClaudeConfigDir(), "skills"),
      count: 1,
    });
    expect(claude.agents).toEqual({
      status: "synced",
      root: path.join(resolveClaudeConfigDir(), "agents"),
      count: 1,
    });
    expect(status.bundleHash).toBe(computeBundleContentHash(bundleDir()));
  });

  it("codex's agents row is always 'n-a', never derived from manifest content", () => {
    writeSkill("host");
    writeAgent("reviewer");
    syncBundleContent();
    const status = getBundleSyncStatus({ enabled: true, detectedClis: NO_DETECTED });
    const codex = status.clis.find((c) => c.cli === "codex")!;
    expect(codex.agents).toEqual({ status: "n-a", root: null, count: 0 });
    // codex DOES get skills synced, unlike agents.
    expect(codex.skills.status).toBe("synced");
  });

  it("is 'stale' when an installed skill was hand-deleted after a sync", () => {
    writeSkill("host");
    syncBundleContent();
    rmSync(path.join(resolveClaudeConfigDir(), "skills", "mullion-host"), {
      recursive: true,
      force: true,
    });
    const status = getBundleSyncStatus({ enabled: true, detectedClis: NO_DETECTED });
    const claude = status.clis.find((c) => c.cli === "claude-code")!;
    expect(claude.skills.status).toBe("stale");
  });

  it("passes detected through from the caller's own set, matched per CLI", () => {
    const status = getBundleSyncStatus({
      enabled: true,
      detectedClis: new Set<BundleSyncCli>(["claude-code", "codex"]),
    });
    const byCli = Object.fromEntries(status.clis.map((c) => [c.cli, c.detected]));
    expect(byCli["claude-code"]).toBe(true);
    expect(byCli.codex).toBe(true);
    expect(byCli.agy).toBe(false);
    expect(byCli.opencode).toBe(false);
  });
});

describe("uninstallBundleContent", () => {
  it("is a no-op with a clear zero result when nothing is installed at all", async () => {
    const result = await uninstallBundleContent();
    expect(result).toEqual({ removed: 0, legacySwept: 0 });
  });

  it("removes every manifest-tracked path, same as removeBundleContent alone", async () => {
    writeSkill("host");
    writeAgent("reviewer");
    syncBundleContent();
    const result = await uninstallBundleContent();
    expect(result.removed).toBeGreaterThan(0);
    expect(existsSync(path.join(resolveClaudeConfigDir(), "skills", "mullion-host"))).toBe(false);
    expect(existsSync(resolveBundleSyncManifestPath())).toBe(false);
  });

  it("legacy sweep: removes a marker-carrying mullion-* directory the manifest never knew about", async () => {
    // Simulates a pre-#941 host: content installed by the old per-launch
    // installBundleSkills, with no boot-time sync manifest ever written.
    const legacyRoot = resolveAgyGlobalSkillsDir();
    const legacyDir = path.join(legacyRoot, "mullion-legacy-skill");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(path.join(legacyDir, "SKILL.md"), "---\nname: legacy-skill\n---\nBody.\n");
    writeFileSync(path.join(legacyDir, INSTALLED_MARKER_NAME), INSTALLED_MARKER_CONTENT);

    const result = await uninstallBundleContent();
    expect(result.removed).toBe(0);
    expect(result.legacySwept).toBeGreaterThan(0);
    expect(existsSync(legacyDir)).toBe(false);
  });

  it("PR #891 regression: never deletes a mullion-prefixed directory lacking the ownership marker", async () => {
    const userOwnedDir = path.join(resolveClaudeConfigDir(), "skills", "mullion-helper");
    mkdirSync(userOwnedDir, { recursive: true });
    writeFileSync(path.join(userOwnedDir, "SKILL.md"), "---\nname: mullion-helper\n---\nMine.\n");
    // Deliberately no INSTALLED_MARKER_NAME file — this is a user's own
    // skill that happens to collide with Mullion's naming convention.

    const result = await uninstallBundleContent();
    expect(result.legacySwept).toBe(0);
    expect(existsSync(userOwnedDir)).toBe(true);
    expect(existsSync(path.join(userOwnedDir, "SKILL.md"))).toBe(true);
  });

  // uninstallBundleContent's legacy sweep (uninstallBundleSkills) only ever
  // walks SKILL_TARGETS' roots — it deliberately never touches agent files
  // at all (see this function's own doc comment on why a prefix-only check
  // would be unsafe for a flat file), so a markerless stray `.md` file
  // predictably survives it regardless of issue #1090's marker. That fix
  // lives entirely in syncBundleContent's own AGENT_TARGETS orphan-scan
  // (see the "issue #1090" tests above), which this path never calls — so
  // this remains a correct, deliberate non-regression guarantee for the
  // markerless case, not an unaddressed gap.
  it("agent-file prune is manifest-only: a stray markerless mullion-<name>.md agent file is left alone by the legacy sweep", async () => {
    writeSkill("host");
    writeAgent("reviewer");
    syncBundleContent();

    const strayAgentPath = path.join(resolveClaudeConfigDir(), "agents", "mullion-orphan.md");
    writeFileSync(strayAgentPath, "---\nname: orphan\ndescription: stray\n---\nBody.\n");

    const result = await uninstallBundleContent();
    // The manifest-tracked reviewer agent IS removed...
    expect(existsSync(path.join(resolveClaudeConfigDir(), "agents", "mullion-reviewer.md"))).toBe(
      false,
    );
    // ...but the untracked, markerless stray flat file is NOT touched by
    // the legacy sweep — that sweep only ever walks skill directories, and
    // never runs the (issue #1090) agent-file orphan scan at all.
    expect(existsSync(strayAgentPath)).toBe(true);
    expect(result.removed).toBeGreaterThan(0);
  });

  it("removes agy's mullion MCP entry, leaving other entries and the rest of the file untouched", async () => {
    const mcpConfigPath = resolveAgyMcpConfigPath();
    mkdirSync(path.dirname(mcpConfigPath), { recursive: true });
    writeFileSync(
      mcpConfigPath,
      JSON.stringify(
        {
          mcpServers: {
            mullion: { type: "stdio", command: "node", args: ["mcp-server.js"] },
            other: { type: "stdio", command: "other-tool" },
          },
        },
        null,
        2,
      ),
    );

    const result = await uninstallBundleContent();
    expect(result.legacySwept).toBeGreaterThan(0);
    const written = JSON.parse(readFileSync(mcpConfigPath, "utf8"));
    expect(written.mcpServers.mullion).toBeUndefined();
    expect(written.mcpServers.other).toEqual({ type: "stdio", command: "other-tool" });
  });

  it("is a graceful no-op when agy's mcp_config.json doesn't exist at all", async () => {
    expect(existsSync(resolveAgyMcpConfigPath())).toBe(false);
    await expect(uninstallBundleContent()).resolves.toEqual({ removed: 0, legacySwept: 0 });
  });

  it("leaves a genuinely unparseable (non-empty, invalid JSON) mcp_config.json byte-identical", async () => {
    const mcpConfigPath = resolveAgyMcpConfigPath();
    mkdirSync(path.dirname(mcpConfigPath), { recursive: true });
    const garbage = "{ not: valid json at all";
    writeFileSync(mcpConfigPath, garbage);

    const result = await uninstallBundleContent();
    expect(result.legacySwept).toBe(0);
    expect(readFileSync(mcpConfigPath, "utf8")).toBe(garbage);
  });

  it("leaves a malformed non-object mcpServers value alone rather than throwing", async () => {
    const mcpConfigPath = resolveAgyMcpConfigPath();
    mkdirSync(path.dirname(mcpConfigPath), { recursive: true });
    const malformed = JSON.stringify({ mcpServers: "not-an-object" });
    writeFileSync(mcpConfigPath, malformed);

    await expect(uninstallBundleContent()).resolves.toEqual({ removed: 0, legacySwept: 0 });
    expect(readFileSync(mcpConfigPath, "utf8")).toBe(malformed);
  });

  it("returns without rewriting when mcpServers has other entries but no mullion key", async () => {
    const mcpConfigPath = resolveAgyMcpConfigPath();
    mkdirSync(path.dirname(mcpConfigPath), { recursive: true });
    const content = JSON.stringify({ mcpServers: { other: { type: "stdio", command: "x" } } });
    writeFileSync(mcpConfigPath, content);

    const result = await uninstallBundleContent();
    expect(result.legacySwept).toBe(0);
    expect(readFileSync(mcpConfigPath, "utf8")).toBe(content);
  });
});

describe("runBundleSyncExclusive — serialization", () => {
  it("enabled dispatches to syncBundleContent's own result shape", async () => {
    writeSkill("host");
    const result = await runBundleSyncExclusive(true);
    expect(result).toEqual({ changed: true });
    expect(isBundleSyncedFor("claude-code")).toBe(true);
  });

  it("a rejected run doesn't poison the queue for the next caller", async () => {
    writeSkill("host");
    // Forces writeManifestAtomic's own mkdirSync(dirname(target), {
    // recursive: true }) to throw: ~/.mullion needs to be a directory, but
    // a plain FILE already sits there. Every skill-install step ahead of
    // that in syncBundleContent still succeeds (they write under
    // ~/.claude, ~/.agents, etc., untouched by this obstruction) — only
    // the final manifest write blows up.
    writeFileSync(path.join(homeDir, ".mullion"), "not a directory");

    await expect(runBundleSyncExclusive(true)).rejects.toThrow();

    // The actual regression this guards: runSerialized's own doc comment
    // says a failed run must not poison pendingBundleSyncOp for the NEXT
    // caller. Without that swallow-catch, this second call would sit
    // chained behind a permanently-rejected promise and never even
    // execute its own `fn` — 500ing every future resync forever.
    rmSync(path.join(homeDir, ".mullion"), { force: true });
    const result = await runBundleSyncExclusive(true);
    expect(result).toEqual({ changed: true });
    expect(readBundleSyncManifest()?.entries.length).toBeGreaterThan(0);
  });

  it("disabled dispatches to removeBundleContent", async () => {
    writeSkill("host");
    syncBundleContent();
    const result = await runBundleSyncExclusive(false);
    expect(result).toEqual({ changed: true });
    expect(isBundleSyncedFor("claude-code")).toBe(false);
  });

  it("two racing calls never interleave their filesystem work — both resolve cleanly, and the manifest is left in a consistent, uncorrupted state", async () => {
    writeSkill("host");
    writeSkill("second");
    const [first, second] = await Promise.all([
      runBundleSyncExclusive(true),
      runBundleSyncExclusive(true),
    ]);
    expect(first.changed || second.changed).toBe(true);

    // No leftover writeManifestAtomic .tmp file — the exact hazard this
    // serialization guards against (a PID-named temp path two overlapping
    // writers would otherwise collide on).
    const manifestDir = path.dirname(resolveBundleSyncManifestPath());
    const leftoverTmp = readdirSync(manifestDir).filter((name) => name.endsWith(".tmp"));
    expect(leftoverTmp).toEqual([]);

    const manifest = readBundleSyncManifest();
    expect(manifest?.entries.length).toBeGreaterThan(0);
    expect(isBundleSyncedFor("claude-code")).toBe(true);
  });

  it("a resync racing a remove still serializes cleanly (opposite operations, not just identical ones)", async () => {
    writeSkill("host");
    syncBundleContent();
    const [syncResult, removeResult] = await Promise.all([
      runBundleSyncExclusive(true),
      uninstallBundleContent(),
    ]);
    expect(syncResult).toBeDefined();
    expect(removeResult).toBeDefined();
    // Whichever order they actually ran in, no leftover temp file and no
    // thrown error from either side.
    const manifestDir = path.dirname(resolveBundleSyncManifestPath());
    const leftoverTmp = existsSync(manifestDir)
      ? readdirSync(manifestDir).filter((name) => name.endsWith(".tmp"))
      : [];
    expect(leftoverTmp).toEqual([]);
  });
});
