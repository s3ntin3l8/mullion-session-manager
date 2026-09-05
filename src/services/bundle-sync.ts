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
import { resolveAgyGlobalSkillsDir, resolveAgyGlobalAgentsDir } from "./hook-adapters/agy.js";
import { resolveOpenCodeConfigHome } from "./hook-adapters/opencode-skills.js";
import {
  resolveMullionBundleDir,
  collectBundleFiles,
  installSkillDirWithNameRewrite,
  deriveOpenCodeReviewerAgentFile,
  deriveAgyAgentFile,
  INSTALLED_SKILL_PREFIX,
  INSTALLED_MARKER_NAME,
  INSTALLED_MARKER_CONTENT,
} from "./hook-adapters/mullion-bundle.js";

export type BundleSyncCli = "claude-code" | "codex" | "agy" | "opencode";

interface BundleSyncManifestEntry {
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

function manifestEntriesStillValid(manifest: BundleSyncManifest): boolean {
  for (const entry of manifest.entries) {
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
    if (actualHash !== entry.hash) return false;
  }
  return true;
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
      // shape here. Safe to ignore: `syncBundleContent` has no concurrent
      // callers within one process (it's the boot-time singleton), the
      // write target was just populated by installSkillDirWithNameRewrite
      // in this same sequential loop iteration, and INSTALLED_MARKER_CONTENT
      // is a process-lifetime constant — a hypothetical sibling-process
      // race produces byte-identical content either way. This is the same
      // shape as the pre-existing, reviewed-and-merged marker write at
      // hook-adapters/mullion-bundle.ts:256-257.
      const markerPath = path.join(destDir, INSTALLED_MARKER_NAME);
      if (!existsSync(markerPath)) {
        writeFileSync(markerPath, INSTALLED_MARKER_CONTENT);
      }
      newEntries.push({ path: destDir, kind: "dir", hash: hashInstalledDir(destDir) });
    }
  }

  for (const target of AGENT_TARGETS) {
    const root = target.root();
    for (const name of agentNames) {
      const raw = readFileSync(path.join(agentsDir, `${name}.md`), "utf8");
      const contents = target.transform(raw);
      if (contents === null) continue;
      const installedName = `${INSTALLED_SKILL_PREFIX}${name}`;
      const destPath = path.join(root, `${installedName}.md`);
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
 * file itself. Deliberately simple: this is the seam #945's fuller
 * uninstall (which also needs to sweep pre-manifest legacy paths) builds
 * on, not a replacement for that work.
 */
export function removeBundleContent(): void {
  const manifest = readManifest();
  if (!manifest) return;
  for (const entry of manifest.entries) {
    try {
      if (entry.kind === "dir") {
        rmSync(entry.path, { recursive: true, force: true });
      } else {
        unlinkSync(entry.path);
      }
    } catch {
      // Best-effort — already gone is fine.
    }
  }
  try {
    unlinkSync(resolveBundleSyncManifestPath());
  } catch {
    // Already gone is fine.
  }
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
