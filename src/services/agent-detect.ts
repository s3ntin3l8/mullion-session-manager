import { spawn as spawnChild } from "node:child_process";
import { buildSessionEnv } from "./session-env.js";
import { getCodexHookTrust, type CodexHookTrust } from "./hook-adapters/codex-trust.js";
import type { HookMessageKind } from "./hook-protocol.js";
import { claudeCodeAdapter } from "./hook-adapters/claude-code.js";
import { codexAdapter } from "./hook-adapters/codex.js";
import { openCodeAdapter } from "./hook-adapters/opencode.js";
import { agyAdapter } from "./hook-adapters/agy.js";

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
  /** Codex's `/hooks` trust status for Mullion's merged forwarder hooks
   * (issue #259) — "trusted" | "pending" | "not-installed". Only set for the
   * "codex" agent; every other agent omits this field entirely. Computed
   * per-machine (not per-session), so it belongs in this host-level probe
   * rather than a new route — see getCodexHookTrust(). */
  hookTrust?: CodexHookTrust;
  /** Issue: extend surfaced session statuses — the hook-protocol `kind`s
   * this agent's launch can ever produce (see the matching HookAgentAdapter's
   * own `emits` doc comment), so the frontend can hide status legend
   * entries/filters this agent can never reach. Empty for shells and for any
   * KNOWN_AGENTS binary with no hook adapter at all (aider, gemini, pi) —
   * those reach only the byte-heuristic working/idle/needs_input/exited
   * states derived from PTY output, never a hook-confirmed one. */
  emits: readonly HookMessageKind[];
}

const KNOWN_SHELLS = ["bash", "zsh", "fish"];
// Deliberately not exhaustive — a curated set of common AI-CLI launch
// targets; project-level .crs/actions.json covers anything else. Exported
// (Phase 6, 6.2/#215) so task-agent-resolve.ts's issue-body `Agent:` line
// validates against the same list rather than a second, driftable copy.
export const KNOWN_AGENTS = ["claude", "codex", "opencode", "aider", "gemini", "agy", "pi"];

// Issue: extend surfaced session statuses — maps a KNOWN_AGENTS binary name
// to the hook adapter that actually instruments it (see
// hook-adapters/index.ts's ADAPTERS list and each adapter's own `matches()`,
// which pattern-match the full launch COMMAND rather than this bare binary
// name — this is a separate, narrower lookup for capability reporting only,
// not a second source of truth for which adapter handles a given launch).
// Binaries with no entry (aider, gemini, pi) have no hook adapter at all.
const HOOK_ADAPTER_EMITS_BY_BIN: Partial<Record<string, readonly HookMessageKind[]>> = {
  claude: claudeCodeAdapter.emits,
  codex: codexAdapter.emits,
  opencode: openCodeAdapter.emits,
  agy: agyAdapter.emits,
};

// B7 — this was the one shell-out in this repo with no timeout at all
// (every git helper has one, e.g. git-status.ts's GIT_TIMEOUT_MS). A login
// shell that writes more than the OS pipe buffer (~64 KiB) to stderr
// (nvm/direnv/rvm warnings on a `-l` profile are the realistic source)
// blocks on the write syscall forever with nothing here ever reading
// stderr — so the promise never settled, and with no in-flight dedup
// around getCachedAgents' cache miss, ten concurrent uncached requests
// leaked ten blocked shells. PROBE_TIMEOUT_MS matches GIT_TIMEOUT_MS's
// magnitude; PROBE_KILL_ESCALATION_MS mirrors the same SIGKILL-escalation
// grace period the git-*.ts helpers now use (a `command -v` probe ignoring
// SIGTERM is exactly as plausible as a wedged git process).
const PROBE_TIMEOUT_MS = 5_000;
const PROBE_KILL_ESCALATION_MS = 2_000;

/** Resolve one binary's path via `command -v`, run inside a login shell so
 * PATH matches exactly what a spawned session would see. Never rejects —
 * "not found" and "probe itself failed to launch" both resolve to null. */
function probe(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || "/bin/bash";
    let stdout = "";
    let settled = false;

    const child = spawnChild(shell, ["-lc", `command -v ${bin}`], {
      env: buildSessionEnv(),
      // B7 — stderr is never read by anything below, so dropping it
      // entirely (rather than leaving it as a pipe no one drains) is what
      // actually prevents the blocked-write hang; the timeout below is a
      // backstop for whatever this doesn't cover (a shell that blocks for
      // some other reason). Matches this repo's other spawn calls that
      // don't need stderr (e.g. git-refs.ts's runGit).
      stdio: ["ignore", "pipe", "ignore"],
    });

    const onStdoutData = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    };
    child.stdout?.on("data", onStdoutData);

    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const clearKillTimer = () => {
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
    };

    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off("data", onStdoutData);
      resolve(value);
    };

    const timer = setTimeout(() => {
      child.kill(); // SIGTERM
      // Escalate to SIGKILL if the process is still alive after a short
      // grace period — a timeout firing means it already ignored our
      // attempt to end it cooperatively. `killed`/`exitCode` don't tell us
      // this (Node sets `killed` once a signal is successfully *sent*, not
      // once the process has actually died) — `exitCode`/`signalCode` both
      // staying `null` is the real "still alive" signal.
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, PROBE_KILL_ESCALATION_MS);
      finish(null);
    }, PROBE_TIMEOUT_MS);

    child.on("error", () => {
      clearKillTimer();
      finish(null);
    });
    // 'close' (stdio streams closed), NOT 'exit' (process ended) — 'exit'
    // only guarantees the process itself has ended, not that every stdout
    // 'data' chunk has actually been delivered yet. Found live: under the
    // concurrent load of probing 8 binaries at once, this raced often
    // enough to intermittently report a genuinely-installed CLI as
    // unavailable (empty `stdout` read at the moment 'exit' fired, even
    // though the shell's `command -v` output arrived a moment later).
    child.on("close", () => {
      clearKillTimer();
      finish(stdout.trim() || null);
    });
  });
}

/** Probe every known shell + agent CLI in parallel. Pure — no caching. */
export async function detectAgents(): Promise<DetectedAgent[]> {
  const candidates: Array<{ bin: string; kind: AgentKind }> = [
    ...KNOWN_SHELLS.map((bin) => ({ bin, kind: "shell" as const })),
    ...KNOWN_AGENTS.map((bin) => ({ bin, kind: "agent" as const })),
  ];

  return Promise.all(
    candidates.map(async ({ bin, kind }) => {
      const resolvedPath = await probe(bin);
      return {
        id: `${kind}:${bin}`,
        title: bin,
        command: bin,
        kind,
        available: resolvedPath !== null,
        path: resolvedPath,
        // Trust is a hooks.json/config.toml read, not a PATH probe — safe to
        // compute even when Codex itself isn't installed (getCodexHookTrust
        // just reports "not-installed" in that case too).
        ...(bin === "codex" ? { hookTrust: getCodexHookTrust() } : {}),
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

export async function getCachedAgents(forceRefresh = false): Promise<DetectedAgent[]> {
  if (!forceRefresh && cache && cache.expiresAt > Date.now()) {
    return cache.data;
  }
  const data = await detectAgents();
  cache = { data, expiresAt: Date.now() + CACHE_TTL_MS };
  return data;
}

/** Exported for tests only — production never needs to clear this. */
export function clearAgentsCacheForTests(): void {
  cache = null;
}
