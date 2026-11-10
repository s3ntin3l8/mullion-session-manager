// The shape and the time bound of one scaffold generation turn.
//
// They live in their own module because the remote host client needs both —
// it proxies a generation turn to the agent host — and it used to import
// scaffold-generate.ts for them, while scaffold-generate.ts imports the host
// git helpers, which import the remote host client back. That is an import
// cycle between the scaffold generator and the remote host (issue #2414).
//
// scaffold-generate.ts re-exports both, so every existing importer keeps its
// path.

// How long a generation turn may run. `/setup/generate` blocks on a direct
// child_process call to the resolved agent's own documented
// non-interactive/print mode, bounded by this — the same posture the
// route's own rate limit already assumes ("a real, costly turn", not an
// instant call), just made explicit here too. The reasoning behind the
// bound lives with the generator (scaffold-generate.ts's own design doc).
export const DEFAULT_GENERATION_TIMEOUT_MS = 5 * 60 * 1000;

/** The `outcome`-discriminated result `/internal/run-generation-turn`
 * returns (issue #1101) — ALWAYS a 200, never an HTTP status for an
 * application-level failure (unsupported agent CLI, scratch-worktree
 * creation failure, the spawn itself failing). Same "200 + reason
 * envelope, never a git-level refusal as a 5xx" convention as
 * `DeleteBranchResult`/`CreateWorktreeResult` elsewhere in this codebase —
 * chosen deliberately here because `host-git.ts`'s `viaRemote` (which this
 * module's own remote dispatch reuses for the outer HTTP-level
 * unreachable/version-skew split) only distinguishes a 404 from
 * "everything else": carrying these three distinguishable local error
 * classes as HTTP status instead would collapse them into one
 * indistinguishable `"unreachable"` bucket by the time they reached
 * `generateScaffoldContent`'s remote branch (in scaffold-generate.ts).
 *
 * `sandboxed` on `"ok"` is optional on the wire type because this route
 * shipped in 0.3.9 (PR #1134, issue #1101) before 0.3.11 (PR #1167, issues
 * #1144/#1159) added the field, and
 * `RemoteHostClient.resolveRunGenerationTurn` does a raw fetch-and-cast
 * with no runtime validation (same version-skew posture as `SpawnResult`,
 * `AgentConfig`, and `resolveGitBranches` in `remote-host-client.ts`): a
 * remote agent on a 0.3.9 or 0.3.10 build omits `sandboxed`, and
 * `generateScaffoldContent` defaults it to `false` so the unsandboxed
 * warning still surfaces rather than assuming the turn was sandboxed. A
 * current agent build (`routes/internal.ts`) always populates it.
 *
 * `canary` (#2554) is the same kind of optional field: `true` when the agent
 * ran the read canary (`withReadCanary`) around the turn. An agent build that
 * predates the canary omits it and returns plain stdout, which the primary
 * cannot otherwise tell from a verified turn; `generateScaffoldContent`
 * reports its absence as `canary: false` rather than failing the turn.
 *
 * `citedPaths` (#2932) is the same kind of optional field: the paths the
 * cited-path check would look up, and whether each existed in the scratch
 * worktree, snapshotted before teardown. An agent that predates it omits
 * the field and the primary falls back to the project checkout. */
export type GenerationTurnResult =
  | {
      outcome: "ok";
      stdout: string;
      sandboxed?: boolean;
      canary?: boolean;
      citedPaths?: Array<{ path: string; exists: boolean }>;
    }
  | { outcome: "unsupported-agent"; detail: string }
  | { outcome: "worktree-error"; detail: string }
  | { outcome: "spawn-error"; detail: string };
