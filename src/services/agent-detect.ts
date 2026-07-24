import { spawn as spawnChild } from "node:child_process";
import { buildSessionEnv } from "./session-env.js";
import { getCodexHookTrust, type CodexHookTrust } from "./hook-adapters/codex-trust.js";

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
}

const KNOWN_SHELLS = ["bash", "zsh", "fish"];
// Deliberately not exhaustive — a curated set of common AI-CLI launch
// targets; project-level .crs/actions.json covers anything else.
const KNOWN_AGENTS = ["claude", "codex", "opencode", "aider", "gemini", "agy", "pi"];

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
    });

    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => finish(null));
    // 'close' (stdio streams closed), NOT 'exit' (process ended) — 'exit'
    // only guarantees the process itself has ended, not that every stdout
    // 'data' chunk has actually been delivered yet. Found live: under the
    // concurrent load of probing 8 binaries at once, this raced often
    // enough to intermittently report a genuinely-installed CLI as
    // unavailable (empty `stdout` read at the moment 'exit' fired, even
    // though the shell's `command -v` output arrived a moment later).
    child.on("close", () => finish(stdout.trim() || null));
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
