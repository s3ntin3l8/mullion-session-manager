# Scaffold and bundle

Read this when a diff touches the scaffold's committed conventions text or drift check, `src/bundle/skills/`, or the installer that delivers bundled skills. Verified against `origin/main` 2731ea21; code is cited by symbol, not line.

## 1. Scaffold "committed equals injected" respects the per-project opt-out

**Invariant.** The workflow-conventions text the scaffold commits into a project's own AGENTS.md, and the drift check that compares it later, must resolve through the same pair session injection uses: `resolveWorkflowConventionsText` (with the project's `injectWorkflowConventions` and the install-wide text) and `hashWorkflowConventionsSection`. The scaffold-side wrapper is `resolveScaffoldWorkflowConventionsText` in `src/routes/project-setup.ts`. An opted-out project (`injectWorkflowConventions` false) must never report as drifted; the drift check in `src/routes/projects.ts` short-circuits on `(row.injectWorkflowConventions ?? true) &&`, because an empty resolve means "default stub" and re-applying would overwrite authored text. The apply route stamps the hash from the sealed preview record's `workflowConventionsText`, not from live settings.

**Breaks.** Install-wide conventions get committed into an opted-out project's file, or a false "drifted" banner invites a re-apply that destroys conventions the project wrote by hand. Stamping from live settings records a hash for text that was never previewed.

**Check.** Grep new reads of `workflowConventionsText`; each must go through `resolveWorkflowConventionsText`. Any new drift or hash computation must keep the opt-in short-circuit and take its text from the sealed record when applying.

## 2. Bundle skill source directories are unprefixed and orphans are pruned

**Invariant.** Directories under `src/bundle/skills/` are named without the `mullion-` prefix (for example the host and session-ops skills); the installer prepends `INSTALLED_SKILL_PREFIX` from `src/services/hook-adapters/mullion-bundle.ts`. Skills refer to each other descriptively and never by the prefixed installed name, because that name differs per delivery path. Removing or renaming a skill relies on the marker-gated orphan prune (`pruneOrphanManagedDirs`, with a file-kind counterpart) to clean up installed copies. The prune is gated on the `INSTALLED_MARKER_NAME` marker file, so a same-prefixed directory a user wrote themselves, without the marker, is never deleted. `syncBundleContent` in `src/services/bundle-sync.ts` calls the same shared scan, so a remote host's installs are pruned the same way and a second, hand-rolled prune loop is a finding.

**Breaks.** A prefixed source directory installs as a double-prefixed skill. A rename leaves the old install behind on every host if the prune is bypassed or its marker check is loosened (loosening it deletes user content instead). A cross-reference by prefixed name is dangling on the paths that install under a different name.

A removed skill is therefore not cleaned up by deleting its directory alone from some other place: the shipped set is what the scan compares against, so the source directory is the single thing to delete or rename.

**Check.** List the immediate children of `src/bundle/skills/` on the branch: none may start with `mullion-`. `test/services/hook-adapters/mullion-bundle-contents.test.ts` names the expected set, so a skill added or removed must update it in the same change. Grep skill bodies for installed-name references.
