import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSkillFrontmatter } from "../skills.js";
import { isDangerousSkillName } from "./skill-name.js";

// Issue: Mullion's own agent-facing tooling (originally just the
// `mullion-host` skill, a repo-agnostic pointer to the per-session agent
// guide copy — since decomposed into five self-contained skills, issue
// #940, see src/bundle/skills/) currently only reaches an agent
// when the session's cwd happens to be THIS repo's own checkout
// (.claude/skills/mullion-agent-guide/). This module ships it into every
// Claude Code session, in every project, via `--plugin-dir` — "Load a
// plugin from a directory or .zip for this session only" (verified against
// the installed CLI: a hand-built `.claude-plugin/plugin.json` + `skills/`
// dir loads correctly, composes with the `--settings`/`--mcp-config` flags
// claude-code.ts's commandTransform already appends, and survives being
// passed twice — see the plan doc's spike table for the full verification).
//
// Resolution mirrors resolveMcpServerPath/resolveForwarderPath in
// shared.ts, not agent-guide.ts's cwd-relative resolveAgentGuideSourcePath:
// `src/bundle/` sits alongside `src/hooks/`/`src/mcp/`/`src/cli/` (all
// copied into `dist/` verbatim by package.json's build script, none of them
// compiled by tsc — see tsconfig.build.json's `src/**/*.ts` include), so it
// gets the same import.meta.url-relative + MULLION_HOME resolution those
// get, not docs/agent-guide.md's repo-root-relative one. Unlike the
// forwarder path (embedded in a Codex/agy managed config Mullion writes to
// the agent's OWN real config, where a changing path would re-trigger
// Codex's one-time `/hooks` trust prompt on every release — see shared.ts's
// resolveHooksDir comment), `--plugin-dir` is a per-launch CLI flag with no
// persisted, hash-checked identity, so there's no equivalent reason to
// prefer the stable `current` symlink over an ordinary MULLION_HOME
// resolution — it's used here anyway, for the same "identical across
// upgrades" reasoning and because it costs nothing.
function resolveBundleRootDir(): string {
  const mullionHome = process.env.MULLION_HOME?.trim();
  if (mullionHome) {
    return path.join(mullionHome, "current", "dist", "bundle");
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "..", "..", "bundle");
}

/**
 * The bundle directory to pass to `--plugin-dir`, or `null` if this
 * install/checkout hasn't shipped one (a stripped-down test fixture, or a
 * pre-this-issue release tarball rebuilt without a fresh `npm run build`) —
 * mirrors agentGuideSourceExists()'s "soft failure, never throw" contract
 * (agent-guide.ts). claude-code.ts's commandTransform checks this before
 * ever appending `--plugin-dir` — emitting a flag that points at a
 * directory that isn't there is worse than not emitting the flag at all.
 */
export function resolveMullionBundleDir(): string | null {
  const dir = resolveBundleRootDir();
  return existsSync(dir) ? dir : null;
}

// Every directory this module ever writes under a destRoot carries this
// prefix, but the prefix ALONE is a namespace convention, not an ownership
// marker — a user could name their own skill `mullion-helper` (a plausible
// parallel to Mullion's own `mullion-host`), and a prefix-only uninstall
// would silently rmSync it (Hermes review, PR #891). INSTALLED_MARKER_NAME
// is the actual ownership record: installBundleSkills writes one inside
// every directory it creates, and uninstallBundleSkills only ever removes a
// `mullion-`-prefixed directory that carries it — never a same-prefixed
// directory a user or another tool created themselves, marker or not.
// Exported for bundle-sync.ts (issue #941) — the boot-time, manifest-driven
// sync reuses this exact prefix/marker so its own installs stay
// indistinguishable from (and recognizable by) this file's own legacy
// per-launch installBundleSkills/uninstallBundleSkills pair. See
// bundle-sync.ts's own header comment for why both mechanisms need to agree
// on this constant rather than each defining their own copy.
export const INSTALLED_SKILL_PREFIX = "mullion-";
export const INSTALLED_MARKER_NAME = ".mullion-managed";
export const INSTALLED_MARKER_CONTENT =
  "This directory is managed by Mullion (installBundleSkills, hook-adapters/mullion-bundle.ts).\n" +
  "Safe to delete by hand; it will be recreated on the next matching session launch\n" +
  "while sessions.injectMullionBundle is on, and removed automatically once it's off.\n";

/** Recursively syncs `sourceDir`'s files into `destDir`, creating `destDir`
 * (and any subdirectories) as needed, and skipping any file whose content
 * already matches — the "content-compare-then-skip" contract `managedInstall`
 * needs (agy.ts's `mergeAgyTrustedWorkspace` calls out why: this runs on
 * EVERY matching launch, not once, so a naive unconditional overwrite would
 * mean every session spawn touches these files' mtimes for no reason).
 * Never deletes a stale file that no longer exists in `sourceDir` — bundle
 * skills are small and don't currently shed files across releases; if that
 * ever changes, this needs a real "prune extras" pass, not a guess now.
 *
 * Exported for bundle-sync.ts (issue #941): its boot-time sync installs the
 * same shipped skills into FOUR target roots (one per CLI) rather than this
 * file's own single codex/agy destRoot, and reuses this function verbatim
 * rather than duplicating its content-compare-then-skip logic. */
export function syncSkillDir(sourceDir: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      syncSkillDir(sourcePath, destPath);
      continue;
    }
    const content = readFileSync(sourcePath);
    let existing: Buffer | null;
    try {
      existing = readFileSync(destPath);
    } catch {
      existing = null;
    }
    if (existing === null || !existing.equals(content)) {
      writeFileSync(destPath, content);
    }
  }
}

// Issue #941 — bundle-sync.ts's boot-time sync and THIS file's own
// installBundleSkills (still called per-launch by codex.ts/agy.ts) can
// target the exact SAME destRoot for codex and agy. If each did its own
// separate "copy verbatim, then rewrite the name: field" pass, the two
// passes would permanently disagree about what "unchanged" means for
// SKILL.md: syncSkillDir's own compare is source-bytes-vs-dest-bytes, and
// the source's bare `name: host` never equals an already-rewritten
// `name: mullion-host` on disk — so a plain syncSkillDir call would
// unconditionally stomp the rewritten name back to the bare one on every
// single codex/agy launch, which then makes the NEXT boot-time sync see a
// hash mismatch and do a full re-sync, which rewrites it again, forever.
// (Caught in review before this shipped — see the PR description.)
//
// The fix: fold the rewrite INTO the same compare-then-write pass, so both
// callers converge on byte-identical installed content and idempotency
// holds for both. Every other file in the skill directory (including
// nested ones, e.g. taskmaster-issues/references/*) is still copied via
// plain syncSkillDir, unaffected — only the skill's own top-level
// SKILL.md gets this treatment.
export function installSkillDirWithNameRewrite(
  sourceDir: string,
  destDir: string,
  installedName: string,
): void {
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      syncSkillDir(sourcePath, destPath);
      continue;
    }
    if (entry.name !== "SKILL.md") {
      const content = readFileSync(sourcePath);
      let existing: Buffer | null;
      try {
        existing = readFileSync(destPath);
      } catch {
        existing = null;
      }
      if (existing === null || !existing.equals(content)) {
        writeFileSync(destPath, content);
      }
      continue;
    }
    // SKILL.md specifically: rewrite BEFORE comparing, so the comparison
    // (and therefore the "did anything actually change" decision) is
    // against the SAME final content both this function's callers agree
    // on, not the bare shipped source.
    const rewritten = rewriteBundleSkillName(readFileSync(sourcePath, "utf8"), installedName);
    let existingText: string | null;
    try {
      existingText = readFileSync(destPath, "utf8");
    } catch {
      existingText = null;
    }
    if (existingText === null || existingText !== rewritten) {
      writeFileSync(destPath, rewritten);
    }
  }
}

/**
 * The shared orphan-scan loop: removes every marker-carrying `mullion-*`
 * directory directly under `destRoot` whose name is NOT in `currentNames` —
 * i.e. not part of what the caller just (re)installed or is about to
 * install this pass. Extracted (issue #947) so `installBundleSkills`' own
 * orphan scan below and `bundle-sync.ts`'s `syncBundleContent` share this
 * EXACT loop rather than each maintaining its own copy: both can run
 * against the very same root for codex/agy (this file's per-launch
 * managedInstall step, and the boot-time sync), so a future change to this
 * loop's ownership/race handling that only landed in one copy would
 * silently reintroduce drift between the two — the same class of bug this
 * issue fixes for bundle-sync.ts's own missing orphan scan.
 *
 * A no-op (not an error) when `destRoot` doesn't exist yet. Each removal is
 * independently best-effort — the same "already gone, or some other benign
 * race" tolerance `bundle-sync.ts`'s `pruneRemovedEntries` already applies
 * to its own manifest-diff prune, since this scan can run concurrently with
 * another process's install/uninstall pass over the same root.
 *
 * Returns the number of directories actually removed.
 */
export function pruneOrphanManagedDirs(
  destRoot: string,
  currentNames: ReadonlySet<string>,
): number {
  let entries: Dirent[];
  try {
    entries = readdirSync(destRoot, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(INSTALLED_SKILL_PREFIX)) continue;
    if (currentNames.has(entry.name)) continue;
    const dir = path.join(destRoot, entry.name);
    if (!isCurrentMullionManagedDir(dir)) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
      removed++;
    } catch {
      // Already gone, or some other benign race — nothing left to prune.
    }
  }
  return removed;
}

/** Whether `dir` carries the ownership marker installBundleSkills writes —
 * the actual "did Mullion install this" test, not just the `mullion-`
 * prefix on its name. Used both to decide whether install needs to
 * (re)write the marker and, more importantly, by uninstallBundleSkills to
 * decide whether it's safe to delete.
 *
 * Exported for bundle-sync.ts (issue #947) — its own orphan-scan pass over
 * SKILL_TARGETS needs the SAME ownership test installBundleSkills' orphan
 * scan (below) already uses, so the two independent prune passes that can
 * both run against codex's/agy's skill roots (this file's per-launch
 * managedInstall step, and bundle-sync.ts's boot-time sync) never drift on
 * what counts as "safe to remove." Reused, not reimplemented — see this
 * repo's own "one validity check, several callers" posture (mirrors
 * manifestEntryStillValid's own doc comment in bundle-sync.ts). */
export function isCurrentMullionManagedDir(dir: string): boolean {
  return existsSync(path.join(dir, INSTALLED_MARKER_NAME));
}

// Issue #1090 — the file-level counterpart to INSTALLED_MARKER_NAME above.
// AGENT_TARGETS (bundle-sync.ts) installs flat `mullion-<name>.md` files, not
// directories, so there's no "inside" to carry a sibling sentinel file the
// way a skill directory does. This repo's own established convention for
// exactly this shape of problem is marked-region.ts's HTML-comment markers
// (agent-guide.ts/project-briefing.ts/mullion-scaffold.ts use
// `<!-- mullion:*:start/end -->` pairs) — HTML comments are inert to every
// consuming CLI's Markdown/frontmatter parser. Deliberately NOT a new
// frontmatter key: deriveOpenCodeReviewerAgentFile's own doc comment above
// explains why an unexpected frontmatter shape can HARD-FAIL opencode's
// config loader, and adding a marker key would be exactly that risk for zero
// benefit (the marker only needs to be legible to Node's own string search,
// never to any CLI's parser). A single sentinel line, not a start/end pair —
// unlike marked-region.ts's callers, there is no surrounding user content to
// preserve here: this module owns the ENTIRE installed file, so there is
// nothing to delimit a region within.
export const INSTALLED_AGENT_MARKER = "<!-- mullion:managed -->";

/**
 * Appends `INSTALLED_AGENT_MARKER` as the installed file's own last line.
 * bundle-sync.ts's AGENT_TARGETS install loop MUST call this exactly once
 * per file, on the transform's output, and then use THAT SAME string for
 * both the disk write and the manifest hash — never hash the pre-marker
 * transform output. Mirrors hashInstalledDir's own doc comment
 * (bundle-sync.ts) on this exact "the check must agree with itself on both
 * write and read" requirement for directories; the same requirement applies
 * here, file-shaped: if the write and the hash ever disagree on whether the
 * marker is included, `manifestEntryStillValid`'s later re-read-and-rehash
 * permanently mismatches, and every sync reports `changed: true` forever.
 *
 * Placed at the very end of the file (after all frontmatter and body
 * content), not as the body's first line — so it never reads as the first
 * thing a CLI's own prompt construction sees.
 */
export function withInstalledAgentMarker(contents: string): string {
  return `${contents.replace(/\n+$/, "")}\n${INSTALLED_AGENT_MARKER}\n`;
}

/**
 * Whether `filePath` carries `INSTALLED_AGENT_MARKER` as its own trailing
 * line — the file-kind counterpart to `isCurrentMullionManagedDir`'s
 * directory-marker check. Used by `pruneOrphanManagedFiles` to decide
 * whether it's safe to delete: a `mullion-`-prefixed `.md` file WITHOUT this
 * marker is left completely untouched, no matter what — the exact same
 * "prefix alone isn't proof of ownership" rule Hermes review PR #891
 * established for directories.
 *
 * Deliberately checks `endsWith` (matching exactly where
 * `withInstalledAgentMarker` places it) rather than a bare `.includes()`
 * anywhere in the file: `isCurrentMullionManagedDir`'s sibling-file check is
 * something a user can't produce by accident, and a substring search would
 * be a materially weaker bar than that — a user's own `mullion-*.md` file
 * that merely quotes or documents this exact marker string in its body
 * (plausible: this very module's own doc comments, or this repo's docs,
 * contain the literal string) would otherwise be misidentified as
 * Mullion-owned and become deletable. Requiring it as the file's own last
 * line closes that gap while still matching every file this module itself
 * ever writes.
 *
 * `false` (never throws) for a file that no longer exists or can't be
 * read — same soft-failure posture as `isCurrentMullionManagedDir`, which
 * relies on `existsSync` rather than a try/catch for the same reason.
 */
export function isCurrentMullionManagedFile(filePath: string): boolean {
  try {
    return readFileSync(filePath, "utf8").trimEnd().endsWith(INSTALLED_AGENT_MARKER);
  } catch {
    return false;
  }
}

/**
 * The file-kind counterpart to `pruneOrphanManagedDirs` (issue #1090):
 * removes every marker-carrying `mullion-*.md` file directly under
 * `destRoot` whose name is NOT in `currentNames`. Same contract as its
 * directory sibling in every respect — a no-op (not an error) when
 * `destRoot` doesn't exist yet, each removal independently best-effort, and
 * marker-gated only: a same-prefixed `.md` file lacking
 * `INSTALLED_AGENT_MARKER` is never touched, no matter what.
 *
 * Returns the number of files actually removed.
 */
export function pruneOrphanManagedFiles(
  destRoot: string,
  currentNames: ReadonlySet<string>,
): number {
  let entries: Dirent[];
  try {
    entries = readdirSync(destRoot, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.startsWith(INSTALLED_SKILL_PREFIX) || !entry.name.endsWith(".md")) continue;
    if (currentNames.has(entry.name)) continue;
    const filePath = path.join(destRoot, entry.name);
    if (!isCurrentMullionManagedFile(filePath)) continue;
    try {
      unlinkSync(filePath);
      removed++;
    } catch {
      // Already gone, or some other benign race — nothing left to prune.
    }
  }
  return removed;
}

/**
 * Installs every skill in the shipped bundle (src/bundle/skills/<name>/)
 * into `destRoot/mullion-<name>/` — the zero-repo-change delivery vehicle
 * for codex and agy, neither of which has an ephemeral per-session overlay
 * (unlike Claude Code's `--plugin-dir` or opencode's `skills.paths`
 * config key — see claude-code.ts's commandTransform and opencode.ts's
 * prepareLaunch for those). `destRoot` differs per agent and is NOT
 * interchangeable: `~/.agents/skills` for codex (skills.ts's own global-scope
 * table), `~/.gemini/config/skills` for agy (its real customization root —
 * verified this session that agy does NOT load skills from `~/.agents/skills`
 * at all, only from a workspace-relative `.agents/skills` or this global
 * root; see the plan doc's S6 spike). A no-op (not an error) when this
 * install hasn't shipped a bundle (resolveMullionBundleDir() returns null)
 * or ships one with no skills/ directory at all.
 *
 * Also prunes any marker-carrying `mullion-<name>/` directory under
 * `destRoot` whose `<name>` is no longer among the shipped bundle's own
 * skill names — issue #940: renaming a shipped skill's source directory
 * (e.g. `mullion-host/` → `host/`, fixing a double-prefix bug where the
 * OLD source name plus this function's own prefixing produced an installed
 * `mullion-mullion-host/`) would otherwise leave the stale, now-orphaned
 * directory installed forever alongside the correctly-named replacement —
 * syncSkillDir only ever adds/overwrites files, never removes a directory
 * that disappeared from the source. Same ownership-marker safety as
 * uninstallBundleSkills: only ever removes a directory Mullion itself
 * installed, never a same-prefixed user-owned lookalike. */
export function installBundleSkills(destRoot: string): void {
  const bundleDir = resolveMullionBundleDir();
  if (!bundleDir) return;
  const skillsDir = path.join(bundleDir, "skills");
  let skillNames: string[];
  try {
    skillNames = readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return;
  }
  for (const name of skillNames) {
    const installedName = `${INSTALLED_SKILL_PREFIX}${name}`;
    const destDir = path.join(destRoot, installedName);
    // Hermes review, PR #891 round 2 — install was asymmetric with
    // uninstall: uninstall correctly refuses to touch an unmarked
    // `mullion-`-prefixed dir, but install would happily sync files INTO
    // one and then claim it by writing the marker, silently absorbing
    // whatever a user had put there under a colliding name. Skip entirely
    // rather than overwrite when destDir already exists without the
    // marker — the same "no marker, not ours" rule uninstall already
    // applies, just checked one step earlier.
    if (existsSync(destDir) && !isCurrentMullionManagedDir(destDir)) continue;
    // Issue #941 — rewrites SKILL.md's frontmatter name: to the installed
    // (prefixed) name as part of the SAME compare-then-write pass as the
    // rest of the copy (installSkillDirWithNameRewrite's own doc comment
    // has the full "why," including the thrash this avoids against
    // bundle-sync.ts's boot-time sync targeting this same destRoot for
    // codex/agy).
    installSkillDirWithNameRewrite(path.join(skillsDir, name), destDir, installedName);
    // Same content-compare-then-skip posture as syncSkillDir's own files —
    // checked (not written unconditionally) so an already-marked directory
    // doesn't get its mtime touched on every matching launch. Self-heals a
    // marker a user deleted by hand while leaving the skill files in place.
    if (!isCurrentMullionManagedDir(destDir)) {
      writeFileSync(path.join(destDir, INSTALLED_MARKER_NAME), INSTALLED_MARKER_CONTENT);
    }
  }

  // Hermes review, PR #1011 — if `skillsDir` ever resolves to a directory
  // with zero skill subdirectories (a malformed release tarball, not a
  // case this codebase ships today), `skillNames` is empty here, so this
  // prune removes every marker-carrying `mullion-*` dir under `destRoot` —
  // identical to what an empty-bundle `uninstallBundleSkills` call would
  // do. Deliberate, not a bug: an install that ships no skills at all has
  // nothing legitimate left to keep installed.
  //
  // Issue #947 — this is now `pruneOrphanManagedDirs` (above), the SAME
  // shared loop `bundle-sync.ts`'s `syncBundleContent` calls against
  // codex's/agy's own skill roots, rather than a second hand-maintained
  // copy of it.
  const currentDestNames = new Set(skillNames.map((name) => `${INSTALLED_SKILL_PREFIX}${name}`));
  pruneOrphanManagedDirs(destRoot, currentDestNames);
}

/**
 * Removes every directory under `destRoot` this module has actually
 * installed — the reversal of installBundleSkills, called on every matching
 * launch when `sessions.injectMullionBundle` is off, so a managed install
 * left behind by an earlier session with the setting on doesn't linger
 * forever once an operator turns it off (codex-trust.ts is the precedent
 * for a Mullion-owned host-level change staying reversible).
 *
 * Deletes a `mullion-`-prefixed entry ONLY when it also carries the
 * ownership marker (isCurrentMullionManagedDir) — the prefix alone is a
 * naming convention, not proof of ownership: a user could plausibly have
 * their own skill named e.g. `mullion-helper`, parallel to Mullion's own
 * `mullion-host`, and a prefix-only match would silently delete it (Hermes
 * review, PR #891). A same-prefixed directory with no marker — user-owned,
 * or installed by some future release that changes this scheme — is left
 * completely untouched. A no-op when `destRoot` doesn't exist yet (nothing
 * was ever installed).
 *
 * Returns the number of directories actually removed — used by
 * bundle-sync.ts's `uninstallBundleContent` (issue #945) to report a
 * `legacySwept` count for hosts that installed content before the sync
 * manifest existed. Existing callers (agy.ts's/codex.ts's own
 * managedInstall steps) ignore the return value, so this is a
 * backward-compatible addition, not a behavior change for them.
 *
 * Issue #947 — this is now `pruneOrphanManagedDirs` (above) called with an
 * empty `currentNames` set (nothing to keep), the SAME marker-gated scan
 * loop rather than a third hand-maintained copy of it.
 */
export function uninstallBundleSkills(destRoot: string): number {
  return pruneOrphanManagedDirs(destRoot, new Set());
}

// PR-5 (per-project skills/reviewer, "apply Mullion tooling to other repos")
// — a project's own skill/reviewer content (project_tooling's `skill`/
// `reviewerAgent` columns, schema.ts) rides the SAME `--plugin-dir`
// mechanism as the shipped bundle above, composed into ONE per-session
// directory rather than a second `--plugin-dir` flag (spike S7 confirmed
// the CLI accepts more than one, but a single composed dir keeps argv from
// growing a flag per content source — see the plan's PR-5 section). Reused
// by opencode.ts too, for the pieces that transfer: `deriveContentName`
// (both Claude Code's plugin-dir naming and opencode's project-skills
// directory naming need the exact same frontmatter-name derivation) and
// `deriveOpenCodeReviewerAgentFile` (opencode needs its OWN translated copy
// of the reviewer content — see that function's own doc comment for why the
// raw Claude-Code-shaped file can't be reused verbatim there).

/** Recursively reads every file under `dir`, returning paths relative to
 * `dir` — used to copy the shipped bundle's tree into a per-session
 * composed directory (composeClaudeSessionBundle below) without hardcoding
 * its current two-file shape (a `.claude-plugin/plugin.json` + one skill),
 * so this keeps working unchanged as the shipped bundle grows more skills/
 * agents/commands.
 *
 * Exported for bundle-sync.ts's computeBundleContentHash (issue #941), which
 * needs this exact same recursive relPath/contents shape to hash the
 * shipped bundle's skills/ and agents/ subtrees — reused rather than
 * duplicated so the two never drift on what counts as "the bundle's
 * content" (e.g. whether a nested references/ subdirectory is included). */
export function collectBundleFiles(
  dir: string,
  prefix = "",
): Array<{ relPath: string; contents: string }> {
  const out: Array<{ relPath: string; contents: string }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absPath = path.join(dir, entry.name);
    const relPath = prefix ? path.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      out.push(...collectBundleFiles(absPath, relPath));
    } else {
      out.push({ relPath, contents: readFileSync(absPath, "utf8") });
    }
  }
  return out;
}

/** Derives the directory/file name a piece of project-authored skill- or
 * reviewer-agent-shaped content should be written under, from its own YAML
 * frontmatter `name` field — the same name Claude Code itself will show the
 * skill/subagent under, so an author who writes `name: my-invariants` sees
 * exactly that name in Claude Code's own UI, not some Mullion-generated
 * slug. `null` when the content has no parseable frontmatter (skills.ts's
 * parseSkillFrontmatter already requires both `name` and `description`) or
 * when the name is one of the dangerous property names/control-character
 * cases skill-name.ts guards against — callers treat either as "skip this
 * content" rather than throwing, matching installBundleSkills' own soft-
 * failure posture elsewhere in this file. The route
 * (routes/project-tooling.ts) independently rejects unparseable/unsafe
 * content at WRITE time with a clear 400, so reaching this silent-skip path
 * at spawn time should only ever happen for content saved before that
 * validation existed. */
export function deriveContentName(raw: string): string | null {
  const parsed = parseSkillFrontmatter(raw);
  if (!parsed || isDangerousSkillName(parsed.name)) return null;
  return parsed.name;
}

// Issue #941 — bundle-sync.ts installs every shipped skill under a
// `mullion-<name>/` directory (same INSTALLED_SKILL_PREFIX convention as
// installBundleSkills above), but until now the frontmatter INSIDE the
// installed SKILL.md still carried the bare source name (e.g. dir
// `mullion-host/` containing `name: host`). Harmless for codex/agy today —
// neither surfaces a skill's frontmatter name anywhere user-visible — but
// becomes a real, user-visible inconsistency once Claude Code and opencode
// also get a global install and show that name in their own skill-loading
// UI. This rewrites ONLY the installed COPY (never src/bundle/ itself) so
// the directory basename and the frontmatter name agree everywhere.
//
// Matches the frontmatter block with the exact same anchored,
// non-greedy-up-to-the-first-closing-`---` shape as
// skills.ts's parseFlatFrontmatterFields/parseSkillFrontmatter — critical
// here specifically because a skill's Markdown BODY is free to contain its
// own `---` lines (e.g. a horizontal rule, or a fenced example of another
// file's own frontmatter): capturing only up to the FIRST closing `---`
// and copying everything after it back out verbatim (untouched by the
// replace below) is what keeps this from corrupting such a body. Replaces
// only the first `name:` line within that captured block — the same
// "first name: line wins" contract parseFlatFrontmatterFields already
// documents — leaving every other line (including `description:`) exactly
// as shipped.
export function rewriteBundleSkillName(content: string, newName: string): string {
  const match = /^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?)/.exec(content);
  if (!match) return content;
  const [whole, open, frontmatterBody, close] = match;
  const rewrittenBody = frontmatterBody.replace(/^name:.*$/m, `name: ${newName}`);
  return (
    content.slice(0, match.index) +
    open +
    rewrittenBody +
    close +
    content.slice(match.index + whole.length)
  );
}

export interface ProjectToolingContent {
  /** Raw SKILL.md content — project_tooling.skill (schema.ts). */
  skill?: string;
  /** Raw Claude-Code-shaped subagent Markdown — project_tooling.reviewerAgent
   * (schema.ts). */
  reviewerAgent?: string;
}

// Hermes review, PR #894 round 2 — a valid Claude Code plugin needs SOME
// `.claude-plugin/plugin.json`; when this install/checkout hasn't shipped
// one at all (resolveMullionBundleDir() returns null — a stripped-down
// fixture, or a pre-this-feature release tarball), composeClaudeSessionBundle
// below still needs a structurally valid manifest to compose the PROJECT's
// own content under. Byte-identical to src/bundle/.claude-plugin/plugin.json
// itself, by hand — this is a fallback for when that file genuinely isn't
// present to copy, not a second source of truth for it.
const FALLBACK_PLUGIN_MANIFEST = {
  name: "mullion",
  description: "Mullion's own agent-facing tooling, delivered into every session it hosts.",
  author: { name: "Mullion" },
};

/**
 * Materializes a per-session Claude Code plugin directory at `destDir`: the
 * shipped bundle's own tree (verbatim) PLUS the project's own skill (under
 * `skills/<frontmatter-name>/SKILL.md`) and/or reviewer subagent (under
 * `agents/<frontmatter-name>.md`) when present. Returns the settingsFiles
 * entries for the caller (claude-code.ts's prepareLaunch) to include
 * alongside its own `--settings`/`--mcp-config` writes — same "pure,
 * caller does the actual I/O" contract as prepareLaunch itself (types.ts).
 *
 * When this install/checkout hasn't shipped a bundle at all
 * (resolveMullionBundleDir() returns null), the project's OWN content is
 * still composed under a synthesized manifest (FALLBACK_PLUGIN_MANIFEST)
 * rather than dropped — Hermes review, PR #894 round 2: the shipped
 * bundle being absent has nothing to do with whether a project's own,
 * separately-authored skill/reviewer should reach the session, and
 * returning `null` unconditionally here silently discarded them. `null`
 * only when there is truly nothing to compose at all: no shipped bundle
 * AND no project content that survived `deriveContentName` (e.g. both
 * fields absent, or both had unparseable/unsafe frontmatter) — same
 * "never emit a flag pointing at nothing meaningful" posture as
 * resolveMullionBundleDir()'s own soft-failure contract.
 *
 * Unlike installBundleSkills' persistent, content-compare-then-skip writes
 * into a REAL global skill directory (codex/agy), this directory is
 * entirely per-session and ephemeral — same lifecycle as the `.hooks.json`/
 * `.mcp.json` files claude-code.ts already writes next to it under
 * `sessionsDir`, so there's nothing to "install" idempotently and nothing
 * to clean up: it's just discarded along with everything else under this
 * session's directory.
 */
export function composeClaudeSessionBundle(
  destDir: string,
  content: ProjectToolingContent,
): Array<{ path: string; contents: string }> | null {
  const bundleDir = resolveMullionBundleDir();
  const files: Array<{ path: string; contents: string }> = bundleDir
    ? collectBundleFiles(bundleDir).map(({ relPath, contents }) => ({
        path: path.join(destDir, relPath),
        contents,
      }))
    : [];
  let addedProjectContent = false;
  if (content.skill) {
    const name = deriveContentName(content.skill);
    if (name) {
      files.push({ path: path.join(destDir, "skills", name, "SKILL.md"), contents: content.skill });
      addedProjectContent = true;
    }
  }
  if (content.reviewerAgent) {
    const name = deriveContentName(content.reviewerAgent);
    if (name) {
      files.push({
        path: path.join(destDir, "agents", `${name}.md`),
        contents: content.reviewerAgent,
      });
      addedProjectContent = true;
    }
  }
  if (!bundleDir) {
    if (!addedProjectContent) return null;
    files.unshift({
      path: path.join(destDir, ".claude-plugin", "plugin.json"),
      contents: JSON.stringify(FALLBACK_PLUGIN_MANIFEST, null, 2) + "\n",
    });
  }
  return files;
}

/**
 * Translates a project's reviewer-agent content (stored in Claude Code's
 * own `name`/`description`/`tools`/`model` subagent frontmatter shape — see
 * schema.ts's own doc comment on `reviewerAgent`) into the shape opencode's
 * `<OPENCODE_CONFIG_DIR>/agent/<name>.md` convention actually accepts.
 *
 * This is NOT optional polish — verified empirically this session against
 * installed opencode 1.18.23: writing the Claude Code frontmatter shape
 * verbatim (specifically a bare `tools: Read, Grep, Glob, Bash` string,
 * exactly what .claude/agents/mullion-reviewer.md's own format — and this
 * feature's starter template — produces) makes opencode's config loader
 * HARD-FAIL: `Error: Configuration is invalid ... Expected object |
 * undefined, got "Read, Grep, Glob, Bash" tools`, and the session never
 * starts at all. That is categorically worse than a dangling pointer or a
 * silently-skipped skill (this file's usual soft-failure posture) — it
 * would break EVERY opencode session for a project the moment someone
 * filled in the reviewer field using the exact template they were given.
 *
 * Also verified: the directory is `agent/` (singular), not `agents/`
 * (Claude Code's own plugin convention) — a bare `opencode debug config`
 * with a probe file at `<CONFIG_DIR>/agent/<name>.md` surfaces it under the
 * resolved config's `agent.<name>` key, with the frontmatter's `description`
 * mapped straight through and the Markdown body becoming `prompt`; a
 * missing `mode` key is accepted (defaults to being selectable as a primary
 * agent), so `mode: "subagent"` is set explicitly here to keep a project's
 * reviewer out of the primary-agent picker, matching its Claude Code role.
 *
 * `null` for the same "unparseable/unsafe frontmatter" reasons
 * deriveContentName documents — same silent-skip posture, since the route
 * has already rejected this at write time for any content saved after that
 * validation existed.
 */
export function deriveOpenCodeReviewerAgentFile(
  raw: string,
): { name: string; contents: string } | null {
  const parsed = parseSkillFrontmatter(raw);
  if (!parsed || isDangerousSkillName(parsed.name)) return null;
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
  const contents = `---\ndescription: ${JSON.stringify(parsed.description)}\nmode: subagent\n---\n\n${body}\n`;
  return { name: parsed.name, contents };
}

// Issue #941/#950 — agy's flat-file agent convention
// (`~/.gemini/config/agents/mullion-<name>.md`, confirmed working by #950's
// spike) is materially simpler than opencode's: no config-loader hard-fail
// on a `tools:`/`model:` key has been observed (unlike
// deriveOpenCodeReviewerAgentFile's opencode 1.18.23 finding above), and the
// spike confirmed agy accepts a plain name+description frontmatter block —
// the exact same two-field shape SKILL.md itself already uses, and agy
// already loads SKILL.md files with that shape correctly (installBundleSkills
// via resolveAgyGlobalSkillsDir). So this keeps the file "close to the
// Claude Code shape" per that spike's own recommendation: name+description
// preserved (unlike opencode's translation, which drops `name` entirely
// since opencode identifies an agent by its filename, not its frontmatter),
// `tools`/`model` dropped since those are Claude-Code-specific execution
// config with no agy equivalent, and no opencode-specific `mode:` key at
// all — agy has no primary-agent-vs-subagent picker this would gate.
//
// `null` for the same "unparseable/unsafe frontmatter" reasons
// deriveContentName/deriveOpenCodeReviewerAgentFile document.
export function deriveAgyAgentFile(raw: string): { name: string; contents: string } | null {
  const parsed = parseSkillFrontmatter(raw);
  if (!parsed || isDangerousSkillName(parsed.name)) return null;
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
  const contents = `---\nname: ${parsed.name}\ndescription: ${JSON.stringify(parsed.description)}\n---\n\n${body}\n`;
  return { name: parsed.name, contents };
}
