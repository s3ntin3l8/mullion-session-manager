/**
 * mcode's model catalog (issue #1784).
 *
 * ## Why this reads a FILE instead of shelling out
 *
 * The obvious implementation — shell out to `mcode provider list --json` — does
 * not work for the models that matter. mcode's own provider listing hardcodes
 * an EMPTY model list for both of its MiniMax providers:
 *
 * ```js
 * // mcode 0.6.13, chunks/chunk-H6JEREKX.js
 * { providerId: "minimax_oauth", name: "MiniMax OAuth", kind: "minimax-oauth",
 *   active: d === "token_plan", enabled: true, readOnly: true, hasApiKey: false,
 *   models: [] }
 * ```
 *
 * Only custom (BYOK) providers ever report models there, so on a host signed in
 * with MiniMax OAuth — the common case — that command answers `[]` for exactly
 * the models the user wants to pick from. (Verified on mcode 0.6.13:
 * `mcode provider list --json` returns `"models": []` for both
 * `minimax_oauth` and `minimax_api`.)
 *
 * The real catalog lives in mcode's own `config.yaml`, under
 * `provider.<providerId>.models`, and it is the SAME map mcode's own model
 * picker reads (its `listModels` service builds the picker list from
 * `Object.entries(config.provider ?? {})`). On a stock install:
 *
 * ```yaml
 * defaultModel: minimax/MiniMax-M3.1-Flash
 * provider:
 *   minimax:
 *     models:
 *       MiniMax-M3: { … }
 *       MiniMax-M3.1-Flash: { … }
 *     model_order: [MiniMax-M3.1-Flash, MiniMax-M3]
 *     whitelist: [MiniMax-M3, MiniMax-M3.1-Flash]
 * ```
 *
 * so the ids this service returns are `provider/model` — the exact shape
 * mcode's `-m, --model <provider/model>` flag takes.
 *
 * ## Read-only, always
 *
 * `config.yaml` is the USER's file and Mullion must never write it: it holds
 * `permissionMode`, the API keys and the model whitelist, and mutating it
 * would change the behaviour of every mcode on the host, not just the ones
 * Mullion hosts. This service only ever READS it. Every failure — the file
 * missing, the file unparseable, mcode not installed — answers `[]` rather
 * than throwing, so a broken or absent mcode can never break the Settings
 * section that fetches the catalog.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { resolveMcodeDataDir } from "./hook-adapters/mcode.js";
import { validateCliModel } from "./hook-adapters/shared.js";

/** 1h in-memory TTL — the same posture as the sibling catalogs in
 * `opencode-models.ts`. The catalog is effectively static (it only changes
 * when the user edits mcode's config or signs in with another provider), so
 * re-reading the file on every request would be pure overhead. */
const CACHE_TTL_MS = 60 * 60 * 1000;

let cache: { fetchedAt: number; models: string[] } | null = null;

/** The in-flight read, so N concurrent requests share ONE file read. */
let pending: Promise<string[]> | null = null;

export interface McodeModelCatalogOptions {
  /** Injectable clock, for the TTL test. */
  now?: () => number;
  /** Injectable data dir, for the test. Defaults to mcode's own resolution
   * (`MINIMAX_DATA_DIR` → `MAVIS_DATA_DIR` → `~/.minimax`). */
  dataDir?: string;
  /** Injectable config reader, for the test. Defaults to reading
   * `<dataDir>/config.yaml`. */
  readConfig?: () => string | null;
}

/** mcode's config file, inside its data dir. */
export function resolveMcodeConfigPath(dataDir: string = resolveMcodeDataDir()): string {
  return path.join(dataDir, "config.yaml");
}

/** Reads a file, returning its contents or null when it is missing or
 * unreadable. ONE read, no existence check first — an `existsSync` followed by
 * a `readFileSync` is a file-system race (CodeQL's `js/file-system-race`), the
 * same hazard the mcode adapter's own `readFileOrNull` documents. */
function readFileOrNull(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * The provider subtrees mcode's config can hold. `provider` is the map of
 * built-in/BYOK providers (`minimax`, …); `custom_provider` holds the
 * user-added ones. Both are keyed by provider id, and both carry the same
 * `models` / `model_order` / `whitelist` shape.
 */
function providerSubtrees(root: Record<string, unknown>): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  for (const key of ["provider", "custom_provider"] as const) {
    const subtree = root[key];
    if (!subtree || typeof subtree !== "object" || Array.isArray(subtree)) continue;
    for (const [providerId, provider] of Object.entries(subtree as Record<string, unknown>)) {
      out.push([providerId, provider]);
    }
  }
  return out;
}

/**
 * Orders a provider's model ids by the provider's own `model_order`, with any
 * model the order does not mention appended afterwards (alphabetically). The
 * order is the provider's own preference — on a stock install it puts the free
 * M3.1-Flash first — so preserving it keeps the picker in the order mcode
 * itself would present.
 */
function orderModelIds(modelIds: string[], modelOrder: unknown): string[] {
  const order = Array.isArray(modelOrder)
    ? modelOrder.filter((value): value is string => typeof value === "string")
    : [];
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...modelIds].sort((a, b) => {
    const ra = rank.get(a);
    const rb = rank.get(b);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return a.localeCompare(b);
  });
}

/**
 * Parses a mcode `config.yaml` into the catalog of `provider/model` ids.
 *
 * Pure — exported for tests. Never throws: an unparseable document, a
 * document that is not a mapping, and a document with no providers all yield
 * `[]`.
 *
 * A provider's `whitelist` restricts which of its models are selectable. When
 * it is present and non-empty it wins; on a stock install it equals the model
 * set exactly, so it is a no-op there, but honouring it means the picker never
 * offers a model mcode itself would refuse.
 */
export function parseMcodeModelCatalog(yamlText: string): string[] {
  let document: unknown;
  try {
    document = YAML.parse(yamlText);
  } catch {
    return [];
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) return [];

  const root = document as Record<string, unknown>;
  const models: string[] = [];
  const seen = new Set<string>();

  for (const [providerId, providerValue] of providerSubtrees(root)) {
    if (!providerValue || typeof providerValue !== "object" || Array.isArray(providerValue))
      continue;
    const provider = providerValue as Record<string, unknown>;

    const modelMap = provider.models;
    if (!modelMap || typeof modelMap !== "object" || Array.isArray(modelMap)) continue;

    const modelIds = Object.keys(modelMap).filter((id) => id.trim().length > 0);

    const whitelist = provider.whitelist;
    const allowed =
      Array.isArray(whitelist) && whitelist.length > 0
        ? new Set(whitelist.filter((value): value is string => typeof value === "string"))
        : null;

    for (const modelId of orderModelIds(modelIds, provider.model_order)) {
      if (allowed && !allowed.has(modelId)) continue;
      const id = `${providerId}/${modelId}`;
      // The same allowlist the launch path applies, so a value the picker
      // offers is never one `resolveCliModel` would later drop at spawn time.
      if (!validateCliModel(id)) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      models.push(id);
    }
  }

  return models;
}

/**
 * The catalog of model ids mcode can be launched with, or `[]` when there is
 * none to report.
 *
 * Cached for an hour on SUCCESS only: an empty result is never cached, so a
 * config file that is momentarily unreadable (a concurrent write, a
 * half-flushed file) is retried on the next call instead of pinning "no
 * models" for an hour.
 */
export async function listMcodeModels(opts: McodeModelCatalogOptions = {}): Promise<string[]> {
  const now = opts.now ?? Date.now;

  if (cache !== null && now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.models;
  }

  if (pending !== null) return pending;

  // The read below is synchronous, so the promise settles before the
  // assignment on the next line — clearing `pending` from INSIDE the async
  // function would therefore run first and the assignment would then install
  // an already-settled promise as the in-flight slot, pinning every later
  // call to the first result forever. The slot is cleared by the awaiting
  // caller instead, after the assignment has happened.
  const promise = (async () => {
    try {
      const dataDir = opts.dataDir ?? resolveMcodeDataDir();
      const text = opts.readConfig
        ? opts.readConfig()
        : readFileOrNull(resolveMcodeConfigPath(dataDir));
      if (text === null) return [];
      const models = parseMcodeModelCatalog(text);
      if (models.length > 0) {
        cache = { fetchedAt: now(), models };
      }
      return models;
    } catch {
      // A catalog is a convenience, never a hard dependency — a failure here
      // must not take the Settings section down with it.
      return [];
    }
  })();
  pending = promise;

  try {
    return await promise;
  } finally {
    if (pending === promise) pending = null;
  }
}

/** Drops the cached catalog. Exported for tests. */
export function resetMcodeModelsCache(): void {
  cache = null;
  pending = null;
}
