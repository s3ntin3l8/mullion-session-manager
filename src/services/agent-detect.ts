import { runLoginShell, runLoginShellDetailed, type LoginShellFailure } from "./login-shell.js";
import {
  getUserShellEnvStatus,
  invalidateUserShellEnv,
  resolveUserShellEnv,
} from "./user-shell-env.js";
import { getCodexHookTrust, type CodexHookTrust } from "./hook-adapters/codex-trust.js";
import type { HookMessageKind } from "./hook-protocol.js";
import { claudeCodeAdapter } from "./hook-adapters/claude-code.js";
import { codexAdapter } from "./hook-adapters/codex.js";
import {
  openCodeAdapter,
  opencodeVersionWarning,
  parseOpencodeVersion,
} from "./hook-adapters/opencode.js";
import { agyAdapter } from "./hook-adapters/agy.js";
import { mcodeAdapter } from "./hook-adapters/mcode.js";

// Detects which shells and AI-CLI agents are actually usable on this host —
// vision item #6 ("autodetect AI CLIs, similar to claude cloudcli"). Probes
// with the EXACT shell/env shape PtyManager.bootstrapMaster() spawns a real
// session with ($SHELL -lc "...", env: buildSessionEnv()) — see
// pty-manager.ts and session-env.ts — so a "detected" result is a genuine
// guarantee the command will resolve at spawn time, not just an assumption
// about what's typically installed.

export type AgentKind = "shell" | "agent";

export interface DetectedAgent {
  id: string;
  title: string;
  command: string;
  kind: AgentKind;
  available: boolean;
  /** Resolved absolute path, or null if not found on PATH. */
  path: string | null;
  /** Set when "not found" cannot be trusted, and no earlier good result could
   * stand in: `available: false` then means "could not be checked", NOT "not
   * installed". Three causes: the probe timed out (`"timeout"`), it failed to
   * run (`"error"`), or it ran cleanly but on an unverified PATH because the
   * interactive-PATH resolve failed transiently (also `"error"`). Omitted for
   * a probe that ran cleanly on a verified PATH. */
  probeError?: LoginShellFailure;
  /** Codex's `/hooks` trust status for Mullion's merged forwarder hooks
   * (issue #259) — "trusted" | "pending" | "not-installed". Only set for the
   * "codex" agent; every other agent omits this field entirely. Computed
   * per-machine (not per-session), so it belongs in this host-level probe
   * rather than a new route — see getCodexHookTrust(). */
  hookTrust?: CodexHookTrust;
  /** The CLI's reported `x.y.z` — only probed for opencode (issue #1593),
   * whose adapter targets v2 only. Omitted when unavailable or unparseable. */
  version?: string;
  /** Set (opencode only) when `version` is older than the adapter's minimum,
   * so the UI can say why a hosted session would fail to launch. */
  versionWarning?: string;
  /** Issue: extend surfaced session statuses — the hook-protocol `kind`s
   * this agent's launch can ever produce (see the matching HookAgentAdapter's
   * own `emits` doc comment), so the frontend can hide status legend
   * entries/filters this agent can never reach. Empty for shells and for any
   * KNOWN_AGENTS binary with no hook adapter at all (gemini, pi) —
   * those reach only the byte-heuristic working/idle/needs_input/exited
   * states derived from PTY output, never a hook-confirmed one. */
  emits: readonly HookMessageKind[];
}

const KNOWN_SHELLS = ["bash", "zsh"];
// Deliberately not exhaustive — a curated set of common AI-CLI launch
// targets; project-level .crs/actions.json covers anything else. Exported
// (Phase 6, 6.2/#215) so task-agent-resolve.ts's issue-body `Agent:` line
// validates against the same list rather than a second, driftable copy.
export const KNOWN_AGENTS = [
  "claude",
  "codex",
  "opencode",
  "gemini",
  "agy",
  "pi",
  // Issue: mcode support — MiniMax Code's CLI binary is `mcode`. It HAS a
  // hook adapter (see hook-adapters/mcode.ts), so it reaches hook-confirmed
  // status states rather than only the byte heuristics.
  "mcode",
];

// Issue: extend surfaced session statuses — maps a KNOWN_AGENTS binary name
// to the hook adapter that actually instruments it (see
// hook-adapters/index.ts's ADAPTERS list and each adapter's own `matches()`,
// which pattern-match the full launch COMMAND rather than this bare binary
// name — this is a separate, narrower lookup for capability reporting only,
// not a second source of truth for which adapter handles a given launch).
// Binaries with no entry (gemini, pi) have no hook adapter at all.
const HOOK_ADAPTER_EMITS_BY_BIN: Partial<Record<string, readonly HookMessageKind[]>> = {
  claude: claudeCodeAdapter.emits,
  codex: codexAdapter.emits,
  opencode: openCodeAdapter.emits,
  agy: agyAdapter.emits,
  mcode: mcodeAdapter.emits,
};

// B7 — this was the one shell-out in this repo with no timeout at all
// (every git helper has one, e.g. git-status.ts's GIT_TIMEOUT_MS). A login
// shell that writes more than the OS pipe buffer (~64 KiB) to stderr
// (nvm/direnv/rvm warnings on a `-l` profile are the realistic source)
// blocks on the write syscall forever with nothing here ever reading
// stderr — so the promise never settled, and with no in-flight dedup
// around getCachedAgents' cache miss, ten concurrent uncached requests
// leaked ten blocked shells. The timeout matches GIT_TIMEOUT_MS's
// magnitude; the SIGKILL-escalation
// grace period the git-*.ts helpers now use (a `command -v` probe ignoring
// SIGTERM is exactly as plausible as a wedged git process).

/** Resolve one binary's path via `command -v`, run inside a login shell so
 * PATH matches exactly what a spawned session would see. Never rejects. A
 * `failure` means the probe could not answer (timeout / error) — distinct
 * from a clean run that printed nothing, i.e. "not installed". */
function probe(bin: string): Promise<{ path: string | null; failure: LoginShellFailure | null }> {
  return runLoginShellDetailed(`command -v ${bin}`).then((r) => ({
    path: r.stdout,
    failure: r.failure,
  }));
}

/** True when the interactive-PATH resolve failed for a transient reason (not a
 * deliberate opt-out or an unsupported shell), so a probe's "not found" may
 * only mean the user's rc-file PATH entries are missing. */
function interactivePathUnverified(): boolean {
  const { interactiveResolve, reason } = getUserShellEnvStatus();
  return (
    interactiveResolve === "fallback" &&
    (reason === "timeout" ||
      reason === "spawn-failed" ||
      reason === "unparseable" ||
      reason === "pending")
  );
}

/** Probe every known shell + agent CLI in parallel. `previous` is the last
 * result: a binary whose probe failed (e.g. timed out on a loaded host) keeps
 * its earlier answer rather than flipping to "not found". */
export async function detectAgents(
  previous: readonly DetectedAgent[] = [],
): Promise<DetectedAgent[]> {
  const candidates: Array<{ bin: string; kind: AgentKind }> = [
    ...KNOWN_SHELLS.map((bin) => ({ bin, kind: "shell" as const })),
    ...KNOWN_AGENTS.map((bin) => ({ bin, kind: "agent" as const })),
  ];

  return Promise.all(
    candidates.map(async ({ bin, kind }) => {
      const probed = await probe(bin);
      const resolvedPath = probed.path;
      // "Nothing found" cannot be trusted when the interactive-PATH resolve
      // itself failed transiently: the probe then ran on the bare service PATH,
      // which lacks nvm/bun/... entries. Refresh re-runs the resolve.
      const failure =
        probed.failure ?? (resolvedPath === null && interactivePathUnverified() ? "error" : null);
      if (failure) {
        const prior = previous.find((p) => p.id === `${kind}:${bin}`);
        // Keep a prior positive (or prior probe-failed) answer — a transient
        // failure says nothing about whether the CLI is installed.
        if (prior && (prior.available || prior.probeError)) return prior;
      }
      // opencode's adapter is v2-only (issue #1593): record its version and,
      // if too old, why a hosted session would fail. The `--version` flag is
      // global (never starts a server).
      const version =
        bin === "opencode" && resolvedPath !== null
          ? parseOpencodeVersion((await runLoginShell("opencode --version")) ?? "")
          : null;
      const versionWarning = opencodeVersionWarning(version);
      return {
        id: `${kind}:${bin}`,
        title: bin,
        command: bin,
        kind,
        available: resolvedPath !== null,
        path: resolvedPath,
        ...(failure ? { probeError: failure } : {}),
        // Trust is a hooks.json/config.toml read, not a PATH probe — safe to
        // compute even when Codex itself isn't installed (getCodexHookTrust
        // just reports "not-installed" in that case too).
        ...(bin === "codex" ? { hookTrust: getCodexHookTrust() } : {}),
        ...(version ? { version } : {}),
        ...(versionWarning ? { versionWarning } : {}),
        emits: HOOK_ADAPTER_EMITS_BY_BIN[bin] ?? [],
      };
    }),
  );
}

// Probing every known binary spawns a real shell each time, so results are
// cached briefly rather than re-probed on every request that needs them —
// both GET /api/agents and WS-3's launcher-merging routes (GET
// /api/actions, GET /api/projects/:id/actions) share this one cache rather
// than each probing independently.
const CACHE_TTL_MS = 60_000;

let cache: { data: DetectedAgent[]; expiresAt: number } | null = null;
// One shared in-flight probe batch: concurrent misses and background
// refreshes all await the same promise instead of each spawning their own
// set of login shells.
let refreshPromise: Promise<DetectedAgent[]> | null = null;

function refreshAgents(): Promise<DetectedAgent[]> {
  if (refreshPromise) return refreshPromise;
  // The probe's env (buildSessionEnv) only includes the user's interactive-rc
  // PATH once it has been resolved — wait for it so detection and launch agree.
  refreshPromise = resolveUserShellEnv()
    .then(() => detectAgents(cache?.data))
    .then((data) => {
      cache = { data, expiresAt: Date.now() + CACHE_TTL_MS };
      return data;
    })
    .finally(() => {
      refreshPromise = null;
    });
  return refreshPromise;
}

/** Stale-while-revalidate: once anything is cached, callers get it back
 * immediately and an expired entry only triggers a single background
 * re-probe. Only the very first call (nothing cached yet) or an explicit
 * `forceRefresh` waits on the login-shell probes — otherwise every palette
 * open after the 60s TTL would block on them. */
export async function getCachedAgents(forceRefresh = false): Promise<DetectedAgent[]> {
  if (forceRefresh) {
    // An explicit rescan: the user may just have edited their rc file.
    invalidateUserShellEnv();
    return refreshAgents();
  }
  if (cache) {
    if (cache.expiresAt <= Date.now()) {
      // Best-effort — detectAgents' probes never reject, but don't let an
      // unexpected throw become an unhandled rejection in the background.
      refreshAgents().catch(() => {});
    }
    return cache.data;
  }
  return refreshAgents();
}

/** Exported for tests only — production never needs to clear this. */
export function clearAgentsCacheForTests(): void {
  cache = null;
  refreshPromise = null;
}
