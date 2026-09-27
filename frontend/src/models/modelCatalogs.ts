// Model catalogs and CLI-detection helpers shared between Settings → Models
// (settings/sections/ModelsSection.tsx) and the command palette's per-session
// model picker (issue #1424). Moved out of ModelsSection.tsx so both sites
// use the same static lists and the same live-catalog fetch/fallback logic
// rather than two copies that could drift.
import { useEffect, useState } from "react";
import { api } from "../api/index.js";
import { commandToBinary } from "../cliLogos.js";
import type { ModelOption } from "../settings/ModelPicker.js";

export type ModelCli = "claude-code" | "codex" | "agy" | "opencode";

export type CatalogStatus = "loading" | "ready" | "error";

// Claude has no `models` command, so this is a fixed alias list. `opusplan`
// (Opus for planning, Sonnet for execution) is a Claude Code alias like the
// others; the `[1m]` variants select the 1M-token context window. Anything
// else — a full model ID — goes through Custom….
export const CLAUDE_MODELS: ModelOption[] = [
  { value: "fable" },
  { value: "opus" },
  { value: "sonnet" },
  { value: "haiku" },
  { value: "opusplan", label: "opusplan — Opus plans, Sonnet executes" },
  { value: "fable[1m]" },
  { value: "opus[1m]" },
  { value: "sonnet[1m]" },
  { value: "opusplan[1m]" },
];

// Fallback for when `codex debug models` yields nothing (codex missing, or its
// output format changed). It's a snapshot and will age; the live catalog wins
// whenever it returns anything, and Custom… covers the rest.
export const CODEX_FALLBACK_MODELS: ModelOption[] = [
  { value: "gpt-6-astra" },
  { value: "gpt-6-sol" },
  { value: "gpt-6-luna" },
  { value: "gpt-5.6-sol" },
];

// Every catalog is fetched from a CLI that may be missing or have no provider
// configured — the routes answer 200 [] for that, so only a genuine HTTP/network
// failure lands in "error". Each catalog loads independently so one failing
// doesn't blank the other, and the Array.isArray guard keeps a malformed
// response from throwing inside the Settings ErrorBoundary (App.tsx), which
// would lock the user out of every section.
//
// Fetches once per mount, not on every render — correct for ModelsSection,
// whose three call sites (opencode/agy/codex) each always fetch the same,
// unchanging CLI's catalog for the section's whole lifetime. A caller whose
// target CLI can change after mount (the command palette, as the user
// highlights different launchers) needs useModelOptions below instead.
export function useCatalog(fetcher: () => Promise<string[]>) {
  const [models, setModels] = useState<string[]>([]);
  const [status, setStatus] = useState<CatalogStatus>("loading");
  useEffect(() => {
    fetcher()
      .then((list) => {
        setModels(Array.isArray(list) ? list : []);
        setStatus("ready");
      })
      .catch(() => setStatus("error"));
    // The fetchers are stable api methods; fetch once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return { models, status };
}

// Which model-capable CLI (if any) `command` resolves to, mirroring the
// backend's own matching (src/services/hook-adapters/index.ts's
// commandModelCli/commandIsOpencode) closely enough for a UI hint — by
// COMMAND, not launcher id or kind, so a custom `.crs/actions.json` launcher
// that happens to run `claude …` still gets the picker. Built on
// commandToBinary (cliLogos.ts), which already strips a leading path and
// trailing args the same way the backend's anchored regexes do. Unlike the
// backend, this has no shell-metacharacter guard — a false positive here
// only shows an inert control; the backend is still the one source of truth
// that decides whether a model actually applies.
export function commandModelCli(command: string): ModelCli | null {
  switch (commandToBinary(command)) {
    case "claude":
      return "claude-code";
    case "codex":
      return "codex";
    case "agy":
      return "agy";
    case "opencode":
      return "opencode";
    default:
      return null;
  }
}

// True if `command` already has an explicit --model (or, for codex, -m)
// flag, mirroring buildModelFlag's own skip-if-present check
// (hook-adapters/shared.ts) so the picker doesn't offer to set a flag the
// backend would silently ignore. Meaningless for opencode, which never reads
// --model out of the command line — its model always comes from
// OPENCODE_CONFIG_CONTENT — so this always returns false there.
export function commandHasModelFlag(command: string, cli: ModelCli): boolean {
  if (cli === "opencode") return false;
  const re = cli === "codex" ? /(?:^|\s)(?:--model|-m)(?:[\s=]|$)/ : /(?:^|\s)--model(?:[\s=]|$)/;
  return re.test(command);
}

// Per-CLI options for the command palette's picker, where the target CLI can
// change after mount (the user highlights a different launcher). Unlike
// useCatalog above, this keys its fetch on `cli` itself, so switching
// launchers re-fetches (or, for Claude Code, switches to the static list)
// instead of keeping whatever the first-mounted CLI's catalog was.
export function useModelOptions(cli: ModelCli): {
  options: ModelOption[];
  status: CatalogStatus;
  allowCustom: boolean;
} {
  // `result` tags every fetch's outcome with the `cli` it was FOR — needed
  // because `cli` can change between when this effect starts a fetch and
  // when that fetch's promise settles (or before it even starts, on the
  // very next render). `react-hooks/set-state-in-effect` forbids a
  // synchronous `setState("loading")` at the top of the effect body (only
  // calls inside a settled callback are allowed), so "loading" for a `cli`
  // this state doesn't have an answer for yet is derived below during
  // render instead — same pattern as ModelPicker.tsx's `syncedValue` resync.
  const [result, setResult] = useState<{ cli: ModelCli; models: string[]; status: CatalogStatus }>(
    () => ({ cli, models: [], status: cli === "claude-code" ? "ready" : "loading" }),
  );

  useEffect(() => {
    // Claude Code's options are the static CLAUDE_MODELS list (below), which
    // never touches `result` — nothing to fetch or set here.
    if (cli === "claude-code") return;
    let cancelled = false;
    const fetcher =
      cli === "codex"
        ? api.listCodexModels
        : cli === "agy"
          ? api.listAgyModels
          : api.listOpenCodeModels;
    fetcher()
      .then((list) => {
        if (cancelled) return;
        setResult({ cli, models: Array.isArray(list) ? list : [], status: "ready" });
      })
      .catch(() => {
        if (!cancelled) setResult({ cli, models: [], status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [cli]);

  const status: CatalogStatus =
    cli === "claude-code" ? "ready" : result.cli === cli ? result.status : "loading";
  const models = result.cli === cli ? result.models : [];

  if (cli === "claude-code") return { options: CLAUDE_MODELS, status: "ready", allowCustom: true };
  if (cli === "codex") {
    const options = models.length > 0 ? models.map((value) => ({ value })) : CODEX_FALLBACK_MODELS;
    return { options, status, allowCustom: true };
  }
  return { options: models.map((value) => ({ value })), status, allowCustom: cli !== "opencode" };
}
