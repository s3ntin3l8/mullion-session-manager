import type { Launcher } from "./api.js";
import type { Theme } from "./store.js";

import claudeAiLogo from "./assets/cli-logos/claude-ai.svg";
import codexColorLogo from "./assets/cli-logos/codex-color.svg";
import opencodeLightLogo from "./assets/cli-logos/opencode-light.svg";
import opencodeDarkLogo from "./assets/cli-logos/opencode-dark.svg";
import googleGeminiLogo from "./assets/cli-logos/google-gemini.svg";
import antigravityLogo from "./assets/cli-logos/antigravity-color.svg";
import piCodingAgentLightLogo from "./assets/cli-logos/pi-coding-agent-light.svg";
import piCodingAgentDarkLogo from "./assets/cli-logos/pi-coding-agent-dark.svg";

// Official CLI logos for the session launcher (see
// .claude/plans/in-our-session-launcher-virtual-cookie.md). Vendored locally
// (not fetched from a CDN) — see frontend/src/assets/cli-logos/ATTRIBUTION.md
// for sources and licenses (Apache-2.0 for the dashboard-icons set,
// MIT for the LobeHub-sourced codex-color/antigravity-color logos).
interface LogoEntry {
  base: string;
  /** Theme-specific override, only needed for logos with poor contrast against
   * one background (currently just opencode's mostly-monochrome mark). */
  light?: string;
  dark?: string;
}

const LOGO_REGISTRY: Record<string, LogoEntry> = {
  "claude-ai": { base: claudeAiLogo },
  "codex-color": { base: codexColorLogo },
  opencode: { base: opencodeLightLogo, light: opencodeLightLogo, dark: opencodeDarkLogo },
  "google-gemini": { base: googleGeminiLogo },
  "antigravity-color": { base: antigravityLogo },
  "pi-coding-agent": {
    base: piCodingAgentLightLogo,
    light: piCodingAgentLightLogo,
    dark: piCodingAgentDarkLogo,
  },
};

// Detected agents are keyed by their bare binary name (agent-detect.ts's
// `KNOWN_AGENTS`), which isn't the same string as the registry key above
// (dashboard-icons/LobeHub naming). Bridges the two.
const BINARY_TO_LOGO: Record<string, string> = {
  claude: "claude-ai",
  codex: "codex-color",
  opencode: "opencode",
  gemini: "google-gemini",
  agy: "antigravity-color",
  pi: "pi-coding-agent",
};

function resolveEntry(logoName: string, theme: Theme): string | null {
  const entry = LOGO_REGISTRY[logoName];
  if (!entry) return null;
  if (theme === "light" && entry.light) return entry.light;
  if (theme === "dark" && entry.dark) return entry.dark;
  return entry.base;
}

/**
 * Extract the bare binary name from a command string (e.g. "claude code"
 * → "claude", "/usr/bin/opencode --flag" → "opencode"). Used by
 * resolveAgentLogo so it can handle full session.command values rather
 * than requiring pre-extracted bare names.
 */
function commandToBinary(command: string): string {
  return command.trim().split(/\s+/)[0]?.split("/").pop() ?? command;
}

/**
 * Resolve the logo for an agent command string (e.g. "claude", "claude code",
 * "/usr/bin/opencode"). Returns null if no bundled logo exists. Handles
 * full session.command values (with arguments and/or paths).
 */
export function resolveAgentLogo(command: string, theme: Theme): string | null {
  const binary = commandToBinary(command);
  const logoName = BINARY_TO_LOGO[binary];
  return logoName ? resolveEntry(logoName, theme) : null;
}

/**
 * Resolve the official logo image URL for a launcher row, or null if none is
 * bundled (caller falls back to the generic glyph). Only agent launchers are
 * eligible — shells/npm-scripts/tasks/custom entries keep their own styling.
 */
export function resolveLauncherLogo(launcher: Launcher, theme: Theme): string | null {
  if (launcher.kind !== "agent") return null;

  // `launcher.icon` is an opaque passthrough from a user's .crs/actions.json
  // custom launcher config — treat its value as a logical logo name so
  // custom entries can opt into a bundled logo too (e.g. icon: "claude-ai").
  if (launcher.icon) {
    const resolved = resolveEntry(launcher.icon, theme);
    if (resolved) return resolved;
  }

  // Detected agents get id `` `agent:${bin}` `` (agent-detect.ts) — strip the
  // prefix to recover the binary name, which survives a user's command
  // override in global/project .crs/actions.json (same id, different command).
  // Reuses resolveAgentLogo (which applies commandToBinary internally) so the
  // bin→logo lookup shares one code path.
  const bin = launcher.id.startsWith("agent:") ? launcher.id.slice("agent:".length) : null;
  return bin ? resolveAgentLogo(bin, theme) : null;
}
