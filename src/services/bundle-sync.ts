// Issue #941 (parent epic #939) — host-local, idempotent, manifest-driven
// sync of Mullion's own shipped agent-facing bundle (src/bundle/, see
// hook-adapters/mullion-bundle.ts) into all four CLIs' GLOBAL config roots,
// run ONCE at boot rather than per-session.
//
// Before this: codex and agy got a real host-level copy via
// installBundleSkills(), called fire-and-forget on EVERY session spawn
// (agy.ts's/codex.ts's own managedInstall steps); Claude Code and opencode
// got a zero-copy per-session POINTER instead (claude-code.ts's
// `--plugin-dir`, opencode.ts's `skills.paths`). Two different delivery
// mechanisms, and the per-session ones re-did (cheap, but non-zero) work on
// every single launch for content that only ever changes on a Mullion
// upgrade.
//
// This module aligns all four CLIs on ONE mechanism — a real, global,
// content-compare-then-skip install, synced once at boot — and replaces the
// old ad-hoc `.mullion-managed`-marker-plus-destRoot-scan ownership
// convention with a single manifest that's authoritative for what THIS
// mechanism installed. installBundleSkills/uninstallBundleSkills
// (mullion-bundle.ts) are NOT replaced: codex's and agy's per-launch calls
// to them stay exactly as they are, as a cheap idempotent fallback for the
// (rare) case where boot-time sync hasn't run yet on this host — see
// agy.ts's/codex.ts's own managedInstall steps, deliberately left untouched
// by this issue.
//
// Manifest ownership vs. the legacy marker (see mullion-bundle.ts's own
// header comment on INSTALLED_MARKER_NAME): this module still writes that
// marker into every skill directory it installs, for ONE transition
// release, so a rollback (or a not-yet-migrated tool) that only knows the
// old marker convention still recognizes the directory as Mullion-owned.
// But this module's OWN sync logic never reads that marker to decide what
// it owns — the manifest below is authoritative for that. The marker stays
// legacy-only (issue #945's job to use it that way for uninstall).

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveClaudeConfigDir } from "./hook-adapters/claude-code.js";
import { resolveCodexAgentsSkillsDir } from "./hook-adapters/codex.js";
import {
  resolveAgyGlobalSkillsDir,
  resolveAgyGlobalAgentsDir,
  removeAgyMcpMullionEntry,
} from "./hook-adapters/agy.js";
import { resolveOpenCodeConfigHome } from "./hook-adapters/opencode-skills.js";
import {
  resolveMullionBundleDir,
  collectBundleFiles,
  installSkillDirWithNameRewrite,
  deriveOpenCodeReviewerAgentFile,
  deriveAgyAgentFile,
  uninstallBundleSkills,
  pruneOrphanManagedDirs,
  pruneOrphanManagedFiles,
  withInstalledAgentMarker,
  INSTALLED_SKILL_PREFIX,
  INSTALLED_MARKER_NAME,
  INSTALLED_MARKER_CONTENT,
} from "./hook-adapters/mullion-bundle.js";

export type BundleSyncCli = "claude-code" | "codex" | "agy" | "opencode";

// Exported (issue #944) — getBundleSyncStatus's per-CLI rows below expose
// entry-level detail (count, staleness) that a status-surface caller needs
// to reason about; readBundleSyncManifest() exposes the whole manifest for
// the same reason, rather than each caller needing its own copy of this
// shape.
export interface BundleSyncManifestEntry {
  path: string;
  kind: "dir" | "file";
  hash: string;
}

export interface BundleSyncManifest {
  version: 1;
  bundleHash: string;
  entries: BundleSyncManifestEntry[];
}

const MANIFEST_VERSION = 1 as const;

// Fixed, per-user, deliberately NOT under `$MULLION_HOME` and deliberately
// NOT XDG-aware — same reasoning as forwarder-shim.ts's
// resolveForwarderShimPath (its own doc comment has the full rationale):
// dev never sets MULLION_HOME, so dev and prod must resolve to the
// identical path, and an interactive shell's XDG vars routinely differ from
// the `systemd --user` unit's.
export function resolveBundleSyncManifestPath(): string {
  return path.join(os.homedir(), ".mullion", "bundle-sync.json");
}

function readManifest(): BundleSyncManifest | null {
  let raw: string;
  try {
    raw = readFileSync(resolveBundleSyncManifestPath(), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as { version?: unknown }).version === MANIFEST_VERSION &&
      typeof (parsed as { bundleHash?: unknown }).bundleHash === "string" &&
      Array.isArray((parsed as { entries?: unknown }).entries)
    ) {
      return parsed as BundleSyncManifest;
    }
    return null;
  } catch {
    // A corrupt/unparseable manifest is treated as "no manifest" rather
    // than crashing the sync — same soft-failure posture as
    // resolveMullionBundleDir()'s own contract elsewhere in this codebase.
    return null;
  }
}

/**
 * Exported wrapper around the module-private `readManifest` — issue #944's
 * status surface needs to inspect the manifest directly (e.g. its
 * `bundleHash`), not just the derived booleans `isBundleSyncedFor` already
 * exposes. Kept as a thin wrapper, not a promotion of `readManifest` itself
 * to `export`, so every internal caller in this file keeps calling the
 * same private binding regardless of what this public name is doing.
 */
export function readBundleSyncManifest(): BundleSyncManifest | null {
  return readManifest();
}

// Atomic write: `<path>.<pid>.tmp` then `renameSync` into place, same
// directory as the target so the rename is atomic — mirrors
// ensureForwarderShim (forwarder-shim.ts), minus its `mode: 0o755` (a JSON
// manifest isn't executable) and its version-header/never-downgrade
// machinery (that's specific to a script shared by concurrent Mullion
// instances on the same host; this manifest is only ever written by
// whichever instance's boot-time sync last ran, and staleness is already
// handled by the content-hash compare in syncBundleContent).
function writeManifestAtomic(manifest: BundleSyncManifest): void {
  const target = resolveBundleSyncManifestPath();
  mkdirSync(path.dirname(target), { recursive: true });
  const tmpPath = `${target}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(tmpPath, target);
}

function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

// Sorted `relPath \0 content` pairs, each pair itself `\0`-terminated so an
// adversarial relPath/contents boundary (e.g. one file's contents ending in
// exactly what looks like the start of the next file's relPath) can never
// produce the same digest as a differently-split file set.
function hashFileList(files: Array<{ relPath: string; contents: string }>): string {
  const sorted = [...files].sort((a, b) =>
    a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0,
  );
  const hash = createHash("sha256");
  for (const file of sorted) {
    hash.update(file.relPath);
    hash.update("\0");
    hash.update(file.contents);
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** sha256 over the sorted `relPath \0 content` pairs of the whole shipped
 * bundle tree — its `skills/` subtree, plus its `agents/` subtree if one
 * exists (it doesn't yet in this repo — src/bundle/agents/ is #943/#953's
 * job — so this gracefully treats a missing agents/ as contributing zero
 * files rather than erroring). This is the concrete, checkable answer to
 * "sync on version change": precise to content, not gated on a Mullion
 * release version bump. Deliberately excludes bundleDir's own
 * `.claude-plugin/plugin.json` — that manifest is Claude-Code-specific
 * plumbing (composeClaudeSessionBundle's per-session concern), not part of
 * "the bundle's content" this sync installs into every CLI's own root. */
export function computeBundleContentHash(bundleDir: string): string {
  const files: Array<{ relPath: string; contents: string }> = [];
  const skillsDir = path.join(bundleDir, "skills");
  if (existsSync(skillsDir)) {
    files.push(...collectBundleFiles(skillsDir, "skills"));
  }
  const agentsDir = path.join(bundleDir, "agents");
  if (existsSync(agentsDir)) {
    files.push(...collectBundleFiles(agentsDir, "agents"));
  }
  return hashFileList(files);
}

// Per-entry hash for the manifest's own self-heal check: a directory entry
// (an installed skill) hashes its entire installed file tree — INCLUDING
// the legacy `.mullion-managed` marker this module also writes, since that
// marker is part of what this module itself put there and the check must
// agree with itself on both write and read — via the same relPath/contents
// shape as computeBundleContentHash. A file entry (an installed agent) is
// just the sha256 of its own content.
function hashInstalledDir(dir: string): string {
  return hashFileList(collectBundleFiles(dir));
}

function hashInstalledFile(contents: string): string {
  return sha256(contents);
}

interface SkillTarget {
  cli: BundleSyncCli;
  root(): string;
}

// Reuses the EXISTING exported resolvers for every target — never
// hardcodes a `~`-relative path (issues #469/#470 were exactly that bug).
const SKILL_TARGETS: SkillTarget[] = [
  { cli: "claude-code", root: () => path.join(resolveClaudeConfigDir(), "skills") },
  { cli: "codex", root: () => resolveCodexAgentsSkillsDir() },
  { cli: "agy", root: () => resolveAgyGlobalSkillsDir() },
  { cli: "opencode", root: () => path.join(resolveOpenCodeConfigHome(), "skills") },
];

interface AgentTarget {
  cli: BundleSyncCli;
  root(): string;
  /** Transforms the shipped agent file's raw (Claude-Code-shaped) content
   * into this CLI's own file content. `null` skips this agent for this CLI
   * only (unparseable/unsafe frontmatter) — never aborts the whole sync,
   * same silent-skip posture as deriveContentName's other callers. */
  transform(raw: string): string | null;
}

// Codex has no static per-agent file format at all (spike #946 — codex
// invokes a skill by name at runtime via `spawn_agent`, not a static agent
// file), so it deliberately has no entry here.
const AGENT_TARGETS: AgentTarget[] = [
  {
    cli: "claude-code",
    root: () => path.join(resolveClaudeConfigDir(), "agents"),
    // Verbatim copy — Claude Code's own subagent frontmatter shape is what
    // src/bundle/agents/*.md is authored in, so there is nothing to
    // translate here (unlike opencode/agy below).
    transform: (raw) => raw,
  },
  {
    cli: "agy",
    root: () => resolveAgyGlobalAgentsDir(),
    transform: (raw) => deriveAgyAgentFile(raw)?.contents ?? null,
  },
  {
    cli: "opencode",
    root: () => path.join(resolveOpenCodeConfigHome(), "agent"),
    transform: (raw) => deriveOpenCodeReviewerAgentFile(raw)?.contents ?? null,
  },
];

function listBundleSkillNames(bundleDir: string): string[] {
  const skillsDir = path.join(bundleDir, "skills");
  try {
    return readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

// Missing agents/ is treated as "zero agents", not an error — src/bundle/
// doesn't ship one yet (issue #943/#953's job).
function listBundleAgentNames(bundleDir: string): string[] {
  const agentsDir = path.join(bundleDir, "agents");
  if (!existsSync(agentsDir)) return [];
  try {
    return readdirSync(agentsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name.slice(0, -3));
  } catch {
    return [];
  }
}

/**
 * Whether ONE manifest entry still matches what's actually on disk — the
 * per-entry building block `manifestEntriesStillValid` folds over below,
 * and reused as-is by getBundleSyncStatus (issue #944) to compute a
 * per-CLI "stale" status without re-deriving this logic. Extracted rather
 * than duplicated, per this repo's own "one validity check, several
 * callers" posture (mirrors installSkillDirWithNameRewrite's own doc
 * comment on why a shared compare-then-write pass matters).
 */
function manifestEntryStillValid(entry: BundleSyncManifestEntry): boolean {
  if (!existsSync(entry.path)) return false;
  let actualHash: string;
  if (entry.kind === "dir") {
    actualHash = hashInstalledDir(entry.path);
  } else {
    let contents: string;
    try {
      contents = readFileSync(entry.path, "utf8");
    } catch {
      return false;
    }
    actualHash = hashInstalledFile(contents);
  }
  return actualHash === entry.hash;
}

function manifestEntriesStillValid(manifest: BundleSyncManifest): boolean {
  return manifest.entries.every(manifestEntryStillValid);
}

function pruneRemovedEntries(oldEntries: BundleSyncManifestEntry[], keepPaths: Set<string>): void {
  for (const entry of oldEntries) {
    if (keepPaths.has(entry.path)) continue;
    try {
      if (entry.kind === "dir") {
        rmSync(entry.path, { recursive: true, force: true });
      } else {
        unlinkSync(entry.path);
      }
    } catch {
      // Already gone, or some other benign race — nothing left to prune.
    }
  }
}

// Issue #947 — `pruneRemovedEntries` above only catches a stale installed
// directory that the PREVIOUS manifest actually recorded. It does nothing
// for a marker-carrying `mullion-*` directory that's on disk but was never
// in any manifest at all — either because there is no manifest yet (first
// sync on this host after an upgrade that renamed a shipped skill, e.g. the
// past `mullion-mullion-host` -> `mullion-host` migration), or because the
// manifest file was deleted/corrupted out from under an otherwise-synced
// host. `installBundleSkills`'s own orphan-scan pass (mullion-bundle.ts)
// already handles exactly this for codex/agy by scanning the real target
// directory's contents on every call — but that function is only ever
// invoked for codex/agy's per-launch managedInstall step, never for Claude
// Code or opencode, which are synced ONLY through this module's
// manifest-diff prune. So Claude Code's and opencode's skill roots had no
// orphan-discovery mechanism at all.
//
// This closes that gap by giving `syncBundleContent` a call into
// `pruneOrphanManagedDirs` (mullion-bundle.ts) against each SKILL_TARGETS
// root, below — the EXACT SAME shared scan `installBundleSkills`'s own
// orphan-scan pass now also calls, rather than a second, separately
// maintained copy of that loop (and its marker check) living in this file.
// Marker-gated only: a `mullion-`-prefixed directory that does NOT carry
// `.mullion-managed` is left completely untouched, no matter what — that's
// the exact "don't delete a user's own same-prefixed content" rule Hermes
// review PR #891 established for `uninstallBundleSkills`, and
// `pruneOrphanManagedDirs` must not regress it (see its own doc comment).
//
// Idempotent alongside `installBundleSkills`'s own call to the SAME shared
// function on the SAME root (codex/agy): both compute "shipped installed
// names" from the identical shipped bundle and pass them into the identical
// scan, so running one right after the other never finds anything left for
// the second pass to disagree about — the first pass to run removes the
// orphan, and the second finds nothing there to reconsider.
//
// Issue #1090 — the AGENT_TARGETS loop below had the IDENTICAL gap and never
// got this fix: a stale `mullion-<oldname>.md` agent file just sits there
// forever unless a manifest-diff prune happens to catch it, which it can't
// in the same two trigger cases (no manifest yet, or manifest gone). Closed
// the same way, via `pruneOrphanManagedFiles` (mullion-bundle.ts) — the
// file-kind counterpart to `pruneOrphanManagedDirs` — gated on a new
// in-body HTML-comment marker (`INSTALLED_AGENT_MARKER`) rather than a
// sibling sentinel file, since a flat `.md` file has no "inside" to carry
// one. See `withInstalledAgentMarker`'s own doc comment for why that marker
// must be folded into the content BEFORE it's hashed for the manifest.

/**
 * Boot-time, idempotent sync of the shipped bundle into all four CLIs'
 * global config roots. Returns `{ changed: false }` on every no-op path
 * (no bundle shipped, or the bundle's content hash and every manifest
 * entry already match) and `{ changed: true }` after actually
 * installing/pruning something and writing a fresh manifest.
 *
 * Self-healing: even with an unchanged bundle hash, a hand-deleted or
 * hand-edited installed path forces a full re-sync (manifestEntriesStillValid)
 * — the same self-healing property installBundleSkills/uninstallBundleSkills
 * already had for codex/agy.
 */
export function syncBundleContent(): { changed: boolean } {
  const bundleDir = resolveMullionBundleDir();
  if (!bundleDir) return { changed: false };

  const bundleHash = computeBundleContentHash(bundleDir);
  const existingManifest = readManifest();

  if (
    existingManifest &&
    existingManifest.bundleHash === bundleHash &&
    manifestEntriesStillValid(existingManifest)
  ) {
    return { changed: false };
  }

  const skillsDir = path.join(bundleDir, "skills");
  const agentsDir = path.join(bundleDir, "agents");
  const skillNames = listBundleSkillNames(bundleDir);
  const agentNames = listBundleAgentNames(bundleDir);

  const newEntries: BundleSyncManifestEntry[] = [];
  const installedSkillNames = new Set(skillNames.map((name) => `${INSTALLED_SKILL_PREFIX}${name}`));

  for (const target of SKILL_TARGETS) {
    const root = target.root();
    for (const name of skillNames) {
      const installedName = `${INSTALLED_SKILL_PREFIX}${name}`;
      const destDir = path.join(root, installedName);
      // Issue #941 — reuses the SAME compare-then-write helper
      // installBundleSkills itself now uses (mullion-bundle.ts's own doc
      // comment on installSkillDirWithNameRewrite explains why this has to
      // be shared rather than each mechanism doing its own separate
      // "copy, then rewrite" pass): codex's and agy's skill roots are
      // targets of BOTH this boot-time sync and installBundleSkills' own
      // per-launch call, so the two must converge on byte-identical
      // installed content or they'll fight over SKILL.md's frontmatter
      // forever.
      installSkillDirWithNameRewrite(path.join(skillsDir, name), destDir, installedName);
      // Legacy marker, written for one transition release (see this
      // module's own header comment) — not this sync's own ownership
      // source of truth, which is the manifest written below. Existence-
      // checked, not written unconditionally, so an already-marked
      // directory doesn't get its mtime touched on every re-sync (same
      // posture as installBundleSkills' own marker write).
      //
      // CodeQL js/file-system-race flags the existsSync+writeFileSync
      // shape here. Safe to ignore: `syncBundleContent` is no longer only
      // ever a boot-time singleton (issue #944 added an HTTP re-sync
      // route) — what makes this still safe is that every PRODUCTION
      // caller now goes through this module's own runSerialized() queue
      // (see its doc comment on runBundleSyncExclusive), which guarantees
      // two such calls can never interleave their filesystem work.
      // (`syncBundleContent` stays a public export that this file's own
      // test suite also calls directly, dozens of times — those calls are
      // sequential by construction, one `it()` body at a time, so the
      // property still holds; it just isn't the queue enforcing it there.)
      // Belt-and-suspenders on top of that: the write target was just
      // populated by installSkillDirWithNameRewrite in this same
      // sequential loop iteration, and INSTALLED_MARKER_CONTENT is a
      // process-lifetime constant, so even two back-to-back serialized
      // runs would produce byte-identical content either way. This is the
      // same shape as the pre-existing, reviewed-and-merged marker write at
      // hook-adapters/mullion-bundle.ts:256-257.
      const markerPath = path.join(destDir, INSTALLED_MARKER_NAME);
      if (!existsSync(markerPath)) {
        writeFileSync(markerPath, INSTALLED_MARKER_CONTENT);
      }
      newEntries.push({ path: destDir, kind: "dir", hash: hashInstalledDir(destDir) });
    }
    // Issue #947 — orphan-scan this root for any OTHER marker-carrying
    // `mullion-*` directory not among the names just (re)installed above,
    // regardless of whether the (possibly missing/stale) manifest ever knew
    // about it. See the comment above this loop for the full rationale and
    // the idempotency argument against installBundleSkills' own call to
    // this SAME shared function on this same root for codex/agy.
    //
    // Skipped when `skillNames` is empty: unlike installBundleSkills' own
    // per-launch, single-root, single-CLI call to this same function (where
    // a genuinely empty shipped bundle deliberately wipes that one root —
    // see that function's own "Hermes review, PR #1011" comment), this
    // path runs against all four CLIs' roots at once, from a boot-time or
    // HTTP-triggered resync, with no per-launch retry to self-correct a
    // transient miss. `listBundleSkillNames` returns `[]` both for a truly
    // empty/malformed bundle AND for a transient readdirSync failure (e.g.
    // racing an upgrade's atomic `current` symlink swap against this
    // function's own earlier, separate `computeBundleContentHash` read of
    // the same `bundleDir` — the two can observe different symlink
    // targets). Since a wipe here also gets written into the manifest with
    // no skill entries, and `manifestEntriesStillValid` is vacuously true
    // on an empty entries array, a spurious wipe wouldn't just delete
    // everything once — it would permanently look "synced" on every future
    // call until the shipped bundle's content hash next changes. Skipping
    // the prune on an empty listing trades "a stale orphan lingers one
    // extra resync" for avoiding that unrecoverable false-empty state.
    if (skillNames.length > 0) {
      pruneOrphanManagedDirs(root, installedSkillNames);
    }
  }

  for (const target of AGENT_TARGETS) {
    const root = target.root();
    // Issue #1090 — this target's own "names actually (re)installed THIS
    // pass" protect-set for pruneOrphanManagedFiles below. Built per-target,
    // not once from `agentNames` for all three targets: `target.transform`
    // can return `null` per name independently for agy/opencode (unparseable/
    // unsafe frontmatter — see AGENT_TARGETS' own doc comment), so a name
    // that installed fine for claude-code but was skipped for opencode must
    // NOT protect a same-named orphan file under opencode's own root — that
    // file was never (re)installed by opencode this pass, so it has nothing
    // legitimate protecting it there.
    const installedAgentFileNamesForTarget = new Set<string>();
    for (const name of agentNames) {
      const raw = readFileSync(path.join(agentsDir, `${name}.md`), "utf8");
      const transformed = target.transform(raw);
      if (transformed === null) continue;
      // Issue #1090 — the marker MUST be folded into `contents` before
      // either the write-vs-existing compare or the manifest hash below:
      // hashing `transformed` (pre-marker) while writing/comparing
      // `contents` (post-marker), or vice versa, would make
      // manifestEntryStillValid's later re-read-and-rehash permanently
      // disagree with what's actually on disk — see
      // withInstalledAgentMarker's own doc comment (mullion-bundle.ts) for
      // the full "write and read must agree" rationale, same requirement
      // hashInstalledDir's doc comment states for directories.
      const contents = withInstalledAgentMarker(transformed);
      const installedName = `${INSTALLED_SKILL_PREFIX}${name}`;
      const destPath = path.join(root, `${installedName}.md`);
      installedAgentFileNamesForTarget.add(`${installedName}.md`);
      mkdirSync(path.dirname(destPath), { recursive: true });
      let existingContents: string | null;
      try {
        existingContents = readFileSync(destPath, "utf8");
      } catch {
        existingContents = null;
      }
      if (existingContents === null || existingContents !== contents) {
        writeFileSync(destPath, contents);
      }
      newEntries.push({ path: destPath, kind: "file", hash: hashInstalledFile(contents) });
    }
    // Issue #1090 — the AGENT_TARGETS counterpart to the SKILL_TARGETS
    // loop's own pruneOrphanManagedDirs call above: discovers and removes a
    // marker-carrying `mullion-*.md` agent file that's on disk but wasn't
    // just (re)installed above, regardless of whether the (possibly
    // missing/stale) manifest ever knew about it — e.g. the first sync after
    // a shipped agent gets renamed, or a manifest that's been deleted out
    // from under an otherwise-synced host. `pruneRemovedEntries` below only
    // catches a stale entry the PREVIOUS manifest actually recorded, which
    // is exactly the gap this closes for agent files, mirroring #947's fix
    // for skill directories.
    //
    // Same empty-guard as the skill loop, and for the identical reason: a
    // genuinely empty/malformed `agentNames` listing is indistinguishable
    // from a transient readdirSync race against an upgrade's atomic
    // `current` symlink swap, and skipping the prune trades "a stale orphan
    // lingers one extra resync" for avoiding a false-empty wipe that would
    // then look permanently "synced" until the bundle's content hash next
    // changes.
    //
    // Transition property, not a bug: a host that already synced agent
    // files BEFORE this marker existed has a manifest whose recorded hash
    // was computed over the pre-marker content, and that pre-marker content
    // is still exactly what's on disk — so `manifestEntryStillValid` still
    // agrees with itself and `syncBundleContent` early-returns at this
    // function's own top-of-function check without ever reaching this loop.
    // Those markerless files only get adopted (rewritten with the marker)
    // the next time a REAL resync actually runs — i.e. the shipped bundle's
    // own content hash changes, or the manifest goes missing/corrupt, both
    // of which are exactly the two triggers this issue's orphan-scan targets
    // in the first place. Until then they remain invisible to this scan,
    // exactly like any other manifest-tracked entry — no different from the
    // pre-#1090 behavior for them. Deliberately not solved by bumping
    // `MANIFEST_VERSION` to force a full re-adopt: that would drop the
    // manifest's record of every OTHER already-installed path too, making
    // `statusForRoot` report every row "stale" on every upgraded host for no
    // reason connected to this fix.
    //
    // Also: `agentNames` is `[]` in production today — `src/bundle/agents/`
    // doesn't ship yet (issues #943/#953) — so this guard (and
    // `pruneOrphanManagedFiles` itself) is currently exercised only by this
    // file's own fixture-based tests, not by a real release. Not dead code:
    // the guard is what keeps a genuinely empty/malformed listing from being
    // misread as "nothing to protect, sweep it all" the moment an
    // agents/ directory does ship.
    if (agentNames.length > 0) {
      pruneOrphanManagedFiles(root, installedAgentFileNamesForTarget);
    }
  }

  if (existingManifest) {
    const keepPaths = new Set(newEntries.map((entry) => entry.path));
    pruneRemovedEntries(existingManifest.entries, keepPaths);
  }

  writeManifestAtomic({ version: MANIFEST_VERSION, bundleHash, entries: newEntries });
  return { changed: true };
}

/**
 * Manifest-driven removal — reads the manifest, removes every path it
 * lists (skill directories and agent files), then removes the manifest
 * file itself. Deliberately simple, and deliberately NOT the fuller "remove
 * Mullion content from this host" action: this is what the boot-time sync
 * plugin calls when `sessions.injectMullionBundle` is off (see
 * plugins/bundle-sync.ts), and it must stay scoped to exactly what THIS
 * sync mechanism itself installed — see `uninstallBundleContent` below for
 * the fuller, legacy-sweeping uninstall #945's "remove" action actually
 * uses, which builds on this rather than replacing it.
 *
 * Returns the number of manifest entries actually removed (best-effort —
 * an entry already gone doesn't count and doesn't throw).
 */
export function removeBundleContent(): { removed: number } {
  const manifest = readManifest();
  if (!manifest) return { removed: 0 };
  let removed = 0;
  for (const entry of manifest.entries) {
    try {
      if (entry.kind === "dir") {
        rmSync(entry.path, { recursive: true, force: true });
      } else {
        unlinkSync(entry.path);
      }
      removed++;
    } catch {
      // Best-effort — already gone is fine.
    }
  }
  try {
    unlinkSync(resolveBundleSyncManifestPath());
  } catch {
    // Already gone is fine.
  }
  return { removed };
}

/**
 * Cheap "is the shipped bundle currently globally synced for this CLI"
 * check — a manifest file read, NOT a full re-hash — used by
 * claude-code.ts's and opencode.ts's adapters at session-spawn time to
 * decide whether to skip their own per-session shipped-bundle pointer
 * (`--plugin-dir` / `skills.paths`) now that global discovery covers it.
 * `false` whenever there's no manifest, or the manifest exists but records
 * no entry under this CLI's skill root — the safe default that preserves
 * today's per-session fallback behavior.
 */
export function isBundleSyncedFor(cli: BundleSyncCli): boolean {
  const manifest = readManifest();
  if (!manifest) return false;
  const target = SKILL_TARGETS.find((entry) => entry.cli === cli);
  if (!target) return false;
  const root = target.root();
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return manifest.entries.some((entry) => entry.path.startsWith(prefix));
}

// Issue #944 — a bare boolean/count queue, not a keyed dedup cache: two
// concurrent callers passing DIFFERENT arguments (e.g. an HTTP resync
// request racing an HTTP remove request) must still each get their own,
// correct result — a naive "share the one in-flight promise" dedup would
// silently hand a remove-request caller a sync's result (or vice versa).
// What actually needs guarding is writeManifestAtomic's `<path>.<pid>.tmp`
// temp file: it's named by PID, not per-call, so two truly overlapping
// writers in this same process would collide on that one path. Chaining
// every call onto whatever's already pending — rather than only deduping
// identical calls — guarantees no two calls into
// syncBundleContent/removeBundleContent/uninstallBundleContent ever
// interleave their filesystem work, regardless of which combination of
// operations is racing.
let pendingBundleSyncOp: Promise<void> | null = null;

function runSerialized<T>(fn: () => T): Promise<T> {
  const previous = pendingBundleSyncOp ?? Promise.resolve();
  const run: Promise<T> = previous.then(fn, fn);
  // Tracked separately from `run` (rather than reassigning `pendingBundleSyncOp
  // = run` directly) so a failed run doesn't poison the queue for the next
  // caller, and so this internal tracking promise never produces an
  // unhandled-rejection warning of its own — the real result/error still
  // propagates to whoever awaits the `run` this function returns.
  pendingBundleSyncOp = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * The single, serialized entry point for the boot-time dispatch
 * plugins/bundle-sync.ts's onReady hook makes (`enabled` ? sync : remove) —
 * promoted here from that plugin (issue #944) so the SAME dispatch logic
 * also backs `POST /api/bundle-sync/resync`'s manual re-sync action,
 * without either caller racing the other's filesystem writes. Route
 * handlers and the boot plugin must call this (or `uninstallBundleContent`
 * below) rather than `syncBundleContent`/`removeBundleContent` directly —
 * that's what keeps every real caller inside the `runSerialized` queue.
 */
export function runBundleSyncExclusive(enabled: boolean): Promise<{ changed: boolean }> {
  return runSerialized(() => {
    if (enabled) return syncBundleContent();
    const result = removeBundleContent();
    return { changed: result.removed > 0 };
  });
}

export interface BundleContentRemovalResult {
  /** Manifest-tracked paths removed (removeBundleContent's own count). */
  removed: number;
  /** Additional marker-owned skill directories removed by the legacy sweep
   * below, PLUS agy's mcp_config.json `mullion` entry if one was removed —
   * content the manifest never knew about (installed by a pre-#941 host via
   * the old per-launch installBundleSkills, or a manifest that's itself
   * missing/corrupt). */
  legacySwept: number;
}

/**
 * The fuller "remove Mullion bundle content from this host" action (issue
 * #945) — `removeBundleContent()`'s manifest-driven removal, PLUS a legacy
 * sweep for content the manifest never tracked. Idempotent: safe to call
 * with nothing installed at all (returns `{ removed: 0, legacySwept: 0 }`).
 *
 * The legacy sweep reuses `uninstallBundleSkills` (mullion-bundle.ts)
 * against each CLI's own skill root (the SAME roots `SKILL_TARGETS` already
 * resolves for sync, not a second hardcoded path list) — it already applies
 * the ownership-marker check (`isCurrentMullionManagedDir`) that keeps this
 * from ever deleting a same-prefixed directory a user created themselves
 * (the PR #891 regression class). Agent files are deliberately NOT swept
 * this way, even though issue #1090 gave them their own marker
 * (`INSTALLED_AGENT_MARKER`, mullion-bundle.ts) that a marker-gated scan
 * COULD now safely use: this function's own legacy sweep stays
 * manifest-only by scope, not by necessity — #1090's fix is
 * `syncBundleContent`'s AGENT_TARGETS install loop calling
 * `pruneOrphanManagedFiles` on every (re)sync, which already reaches every
 * host that matters (see that call site's own doc comment on which hosts
 * this covers and why). Extending the same marker-gated scan to THIS
 * legacy-uninstall path too is a reasonable follow-up, not a safety
 * requirement this function is currently missing — it was deliberately left
 * out of #1090's scope to avoid changing removal semantics on a path the
 * issue didn't ask about. A stray pre-manifest `mullion-<name>.md` agent
 * file is therefore still left alone here; only manifest-tracked agent
 * files are ever removed by this function.
 *
 * Also removes agy's `mullion` MCP entry (`removeAgyMcpMullionEntry`) —
 * non-durable by design, since agy's own `mergeAgyMcpConfig` is ungated and
 * re-adds it on the next agy launch regardless of
 * `sessions.injectMullionBundle` (see that function's own doc comment).
 *
 * Serialized through the same queue as `runBundleSyncExclusive` (issue
 * #944) — a resync racing a remove must not let their filesystem writes
 * interleave any more than two racing resyncs should.
 */
export function uninstallBundleContent(): Promise<BundleContentRemovalResult> {
  return runSerialized(() => {
    const { removed } = removeBundleContent();
    let legacySwept = 0;
    for (const target of SKILL_TARGETS) {
      legacySwept += uninstallBundleSkills(target.root());
    }
    if (removeAgyMcpMullionEntry()) legacySwept++;
    return { removed, legacySwept };
  });
}

// Shared by removeBundleContentForCli and statusForRoot below — a bare
// directory-prefix match must never treat `~/.claude/skills-extra` as being
// under `~/.claude/skills`. isBundleSyncedFor above keeps its own identical
// inline copy of this same expression rather than being refactored to call
// this helper: this module's own ownership note (added for issue #1079)
// says not to touch an existing EXPORTED function's body beyond what's
// required, and deduplicating a correct, already-reviewed expression isn't.
function withTrailingSep(dir: string): string {
  return dir.endsWith(path.sep) ? dir : `${dir}${path.sep}`;
}

/**
 * Issue #1079 — Claude Code's and opencode's own per-CLI counterpart to
 * codex's/agy's `uninstallBundleSkills(destRoot)` call in their
 * `managedInstall` steps (codex.ts/agy.ts), run on EVERY session spawn when
 * `sessions.injectMullionBundle` is off: removes exactly what THIS ONE CLI
 * has synced/installed, both its skill root (`SKILL_TARGETS`) and its agent
 * root (`AGENT_TARGETS`) — so turning the setting off takes effect on the
 * very next session spawn for these two CLIs too, instead of only once
 * `plugins/bundle-sync.ts`'s `onReady` hook next runs (a Mullion process
 * restart).
 *
 * Deliberately NOT `removeBundleContent()` above: that function is
 * whole-host, all-four-CLIs — calling it from claude-code.ts's prepareLaunch
 * would also wipe codex's and agy's own installed content, which has
 * nothing to do with a Claude Code session's own launch. This is scoped to
 * exactly one CLI's own two roots instead.
 *
 * Skill root: reuses `uninstallBundleSkills` (itself `pruneOrphanManagedDirs`
 * with an empty keep-set — see that function's own doc comment), the EXACT
 * SAME marker-gated ownership check (`isCurrentMullionManagedDir`) every
 * other removal path in this module already uses. Never a same-prefixed
 * `mullion-*` directory a user created themselves without the marker.
 *
 * Agent root: `AGENT_TARGETS` installs FLAT `mullion-<name>.md` files.
 * Since issue #1090 they DO carry an in-body ownership marker
 * (`INSTALLED_AGENT_MARKER`, mullion-bundle.ts), but this function stays
 * manifest-only for them by scope, not by necessity — see
 * `uninstallBundleContent`'s own doc comment for why its legacy sweep makes
 * the same choice, and where the marker-gated scan actually lives instead
 * (`syncBundleContent`'s AGENT_TARGETS install loop). The sync manifest IS
 * still a perfectly valid ownership record for a file-kind entry on its own,
 * so this removes precisely (and only) the manifest-tracked file entries
 * under this CLI's agent root — mirroring `removeBundleContent()`'s own
 * manifest-driven, per-entry removal — never a same-prefixed `mullion-*.md`
 * file a user created that the manifest never recorded.
 *
 * Both kinds of entry for this CLI are also dropped from the manifest once
 * actually gone from disk (not just deleted from disk): leaving a removed
 * skill/agent entry in the manifest would make a later `isBundleSyncedFor(cli)`
 * call keep reporting "synced" even though the content is gone, which would
 * make claude-code.ts's/opencode.ts's own
 * `else if (!isBundleSyncedFor(cli))` branch wrongly skip re-emitting the
 * per-session fallback pointer the next time the setting is turned back on
 * before this host's next full resync. The skill-dir side is checked with a
 * fresh `existsSync`, not just a path-prefix match: `uninstallBundleSkills`
 * (`pruneOrphanManagedDirs`) skips a directory that fails the ownership-
 * marker check and best-effort swallows an `rmSync` failure, so a
 * prefix-matched manifest entry isn't proof the directory is actually gone
 * — dropping it anyway would make `isBundleSyncedFor(cli)` lie in the
 * other direction.
 *
 * Runs through the SAME `runSerialized` queue as `syncBundleContent`/
 * `removeBundleContent`/`uninstallBundleContent` above: unlike codex's/agy's
 * `uninstallBundleSkills` calls (which never touch the manifest file at
 * all), this DOES write `bundle-sync.json`, so it must not interleave its
 * read-modify-write with a concurrent boot-time sync or a manual
 * `POST /api/bundle-sync/resync`.
 *
 * A no-op, safely, for a CLI with nothing installed (an absent skill root,
 * no manifest, or no matching entries) — same "safe to call speculatively"
 * posture as `uninstallBundleSkills` itself.
 */
export function removeBundleContentForCli(
  cli: "claude-code" | "opencode",
): Promise<{ skillsRemoved: number; agentsRemoved: number }> {
  return runSerialized(() => {
    const skillTarget = SKILL_TARGETS.find((target) => target.cli === cli);
    const agentTarget = AGENT_TARGETS.find((target) => target.cli === cli);

    const skillsRemoved = skillTarget ? uninstallBundleSkills(skillTarget.root()) : 0;

    let agentsRemoved = 0;
    const manifest = readManifest();
    if (manifest) {
      const skillPrefix = skillTarget ? withTrailingSep(skillTarget.root()) : null;
      const agentPrefix = agentTarget ? withTrailingSep(agentTarget.root()) : null;
      const remaining: BundleSyncManifestEntry[] = [];
      for (const entry of manifest.entries) {
        if (agentPrefix && entry.kind === "file" && entry.path.startsWith(agentPrefix)) {
          try {
            unlinkSync(entry.path);
          } catch (err) {
            // ENOENT means it was already gone — fine, same best-effort
            // posture as removeBundleContent()'s own per-entry removal. Any
            // OTHER failure (EACCES/EBUSY) means the file is still really
            // there, so — mirroring the skill-dir branch's own `!existsSync`
            // gate below — this entry must stay in the manifest rather than
            // being dropped: doing otherwise would both orphan the file
            // (unreachable by any future removal pass until the next full
            // syncBundleContent resync re-adopts it) and over-report
            // agentsRemoved for a file that never actually left disk.
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
              remaining.push(entry);
              continue;
            }
          }
          agentsRemoved++;
          continue;
        }
        // Skill-dir entries under this CLI's own root were just handled by
        // uninstallBundleSkills above (disk-side); dropped from the
        // manifest here too so isBundleSyncedFor(cli) doesn't keep claiming
        // they're still there — see this function's own doc comment. Only
        // when the directory is ACTUALLY gone, not just prefix-matched:
        // uninstallBundleSkills (pruneOrphanManagedDirs) skips a directory
        // that fails the ownership-marker check, and best-effort swallows
        // an rmSync failure (EACCES/EBUSY) — in either case the directory
        // is still really there, and dropping its manifest entry anyway
        // would make isBundleSyncedFor(cli) falsely report "not synced" for
        // content that never actually left disk. Same self-healing
        // `!existsSync` check `manifestEntryStillValid` already uses above.
        if (
          skillPrefix &&
          entry.kind === "dir" &&
          entry.path.startsWith(skillPrefix) &&
          !existsSync(entry.path)
        ) {
          continue;
        }
        remaining.push(entry);
      }
      if (remaining.length !== manifest.entries.length) {
        writeManifestAtomic({ ...manifest, entries: remaining });
      }
    }

    return { skillsRemoved, agentsRemoved };
  });
}

export type BundleSyncStatus = "synced" | "not-synced" | "stale" | "n-a" | "disabled";

export interface BundleSyncCliStatus {
  cli: BundleSyncCli;
  /** From agent-detect.ts's getCachedAgents() — whether this CLI's binary
   * was found on PATH at all, independent of whether Mullion has ever
   * synced content to it. */
  detected: boolean;
  skills: { status: BundleSyncStatus; root: string; count: number };
  agents: { status: BundleSyncStatus; root: string | null; count: number };
}

export interface BundleSyncStatusReport {
  enabled: boolean;
  /** The shipped bundle's content hash as of the last successful sync, or
   * `null` when disabled or never synced. */
  bundleHash: string | null;
  manifestPath: string;
  clis: BundleSyncCliStatus[];
}

const STATUS_CLI_ORDER: readonly BundleSyncCli[] = ["claude-code", "codex", "agy", "opencode"];

/** Every manifest entry under `root` (prefix-matched, same convention as
 * isBundleSyncedFor) whose `kind` matches — the shared building block for
 * both a CLI's skills row (kind "dir") and its agents row (kind "file"). */
function statusForRoot(
  manifest: BundleSyncManifest | null,
  root: string,
  kind: BundleSyncManifestEntry["kind"],
): { status: BundleSyncStatus; count: number } {
  if (!manifest) return { status: "not-synced", count: 0 };
  const prefix = withTrailingSep(root);
  const entries = manifest.entries.filter(
    (entry) => entry.kind === kind && entry.path.startsWith(prefix),
  );
  if (entries.length === 0) return { status: "not-synced", count: 0 };
  const allValid = entries.every(manifestEntryStillValid);
  return { status: allValid ? "synced" : "stale", count: entries.length };
}

/**
 * Issue #944's integration status surface — per-CLI sync/detection status,
 * built from #941's own manifest and `agent-detect.ts`'s binary-presence
 * probing, never a fresh "does this path exist" check of its own (the
 * `isCurrentMullionManagedDir`-vs-prefix distinction this issue's own text
 * calls out).
 *
 * `enabled`/`detectedClis` are passed in rather than read here: this module
 * is not Fastify-aware (no `app.db` to read `sessions.injectMullionBundle`
 * from) and has no business shelling out to `agent-detect.ts`'s login-shell
 * probes itself — the caller (routes/bundle-sync.ts) already has both a
 * cheap settings read and a cached `getCachedAgents()` result on hand.
 *
 * When `enabled` is false, EVERY row is `"disabled"` — not `"not-synced"` —
 * and no manifest/hash comparison happens at all: with
 * `sessions.injectMullionBundle` off, claude-code.ts's/opencode.ts's own
 * per-session fallback is ALSO gated on that same setting (see
 * `prepareLaunch`'s `ctx.injectMullionBundle` checks there), so nothing
 * reaches any CLI through any mechanism — "not-synced" would wrongly imply
 * a re-sync alone could fix it.
 */
export function getBundleSyncStatus(params: {
  enabled: boolean;
  detectedClis: ReadonlySet<BundleSyncCli>;
}): BundleSyncStatusReport {
  const manifestPath = resolveBundleSyncManifestPath();

  if (!params.enabled) {
    return {
      enabled: false,
      bundleHash: null,
      manifestPath,
      clis: STATUS_CLI_ORDER.map((cli) => {
        const skillTarget = SKILL_TARGETS.find((target) => target.cli === cli)!;
        const agentTarget = AGENT_TARGETS.find((target) => target.cli === cli);
        return {
          cli,
          detected: params.detectedClis.has(cli),
          skills: { status: "disabled", root: skillTarget.root(), count: 0 },
          agents: {
            status: "disabled",
            root: agentTarget ? agentTarget.root() : null,
            count: 0,
          },
        };
      }),
    };
  }

  const manifest = readManifest();

  return {
    enabled: true,
    bundleHash: manifest?.bundleHash ?? null,
    manifestPath,
    clis: STATUS_CLI_ORDER.map((cli) => {
      const skillTarget = SKILL_TARGETS.find((target) => target.cli === cli)!;
      const agentTarget = AGENT_TARGETS.find((target) => target.cli === cli);
      const skillRoot = skillTarget.root();
      const skills = statusForRoot(manifest, skillRoot, "dir");
      // Codex has no static per-agent file format at all (AGENT_TARGETS has
      // no entry for it — see that table's own comment), so its agents row
      // is unconditionally "n-a", never derived from manifest content.
      const agents = agentTarget
        ? statusForRoot(manifest, agentTarget.root(), "file")
        : { status: "n-a" as BundleSyncStatus, count: 0 };
      return {
        cli,
        detected: params.detectedClis.has(cli),
        skills: { status: skills.status, root: skillRoot, count: skills.count },
        agents: {
          status: agents.status,
          root: agentTarget ? agentTarget.root() : null,
          count: agents.count,
        },
      };
    }),
  };
}
