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
 *
 * ## Invalidation is by FILE MTIME, not by a timer
 *
 * Adding a model, signing a different provider in, or changing the whitelist
 * all rewrite `config.yaml` — so the file's own mtime is the exact signal for
 * "the catalog changed". A TTL alone would serve a stale list for up to an
 * hour after the user did the thing they were trying to do, and the Settings
 * section has no refresh button to paper over it. The cache is therefore keyed
 * by the resolved config PATH and invalidated by that file's mtime: the second
 * read of an unchanged file costs one open+fstat and no parse, and any write
 * to the file is picked up on the very next request.
 */

import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { resolveMcodeDataDir } from "./hook-adapters/mcode.js";
import { validateCliModel } from "./hook-adapters/shared.js";

/**
 * The provider subtrees mcode's config can hold.
 *
 * - `provider` — the map of built-in/BYOK providers (`minimax`, …). Pinned by
 *   mcode's own model-picker service, which reads
 *   `Object.entries(config.provider ?? {})`.
 * - `custom_provider` — the user-added providers. Pinned by mcode's own
 *   config reader, which lifts it as
 *   `custom_provider: bE(me(t.custom_provider) ? t.custom_provider : void 0)`
 *   — a TOP-LEVEL key, not a sub-key of `provider`.
 *
 * Both are keyed by provider id, and both carry the same
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
 * Matches a whitelist entry against a model.
 *
 * A stock mcode install lists BARE model ids in `whitelist`
 * (`["MiniMax-M3", "MiniMax-M3.1-Flash"]` — verified against the host's own
 * `~/.minimax/config.yaml`). But a whitelist is a filter we do not own, and a
 * filter we cannot interpret must not silently empty the catalog: an entry
 * could equally be a full `provider/model` id, or a glob. All three shapes
 * are therefore accepted, and the caller IGNORES a whitelist that matches
 * nothing at all rather than serving an empty list.
 */
function whitelistEntryMatches(entry: string, providerId: string, modelId: string): boolean {
  if (entry === modelId) return true;
  if (entry === `${providerId}/${modelId}`) return true;
  // A glob, with `*` as the only wildcard. Everything else is literal, so
  // the pattern is anchored and the rest is regex-escaped.
  if (!entry.includes("*")) return false;
  const pattern = entry
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  const re = new RegExp(`^${pattern}$`);
  return re.test(modelId) || re.test(`${providerId}/${modelId}`);
}

/**
 * What a parse found that the caller may want to report.
 *
 * A `whitelist` is a filter Mullion does not own, so an entry that matches no
 * model makes the whole whitelist uninterpretable — and an uninterpretable
 * filter must not empty the picker (see parseMcodeModelCatalog). That is the
 * right behaviour, but it is also what a TYPO'd or not-yet-populated
 * whitelist looks like, so the dropped entries are reported rather than
 * swallowed: the picker then offers models mcode itself would refuse, and the
 * operator needs to be able to see why.
 */
export interface McodeCatalogDiagnostics {
  /** Providers whose whitelist matched nothing, and the entries that were
   * dropped. */
  ignoredWhitelists: Array<{ providerId: string; entries: string[] }>;
}

/**
 * Parses a mcode `config.yaml` into the catalog of `provider/model` ids.
 *
 * Pure — exported for tests. Never throws: an unparseable document, a
 * document that is not a mapping, and a document with no providers all yield
 * `[]`.
 *
 * A provider's `whitelist` restricts which of its models are selectable. It is
 * honoured only when it actually matches something: a whitelist in a shape
 * this service does not understand would otherwise filter out every model and
 * leave the picker empty, which is worse than not applying it at all. The
 * dropped entries are recorded in `diagnostics` when one is supplied.
 */
export function parseMcodeModelCatalog(
  yamlText: string,
  diagnostics?: McodeCatalogDiagnostics,
): string[] {
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

    const modelIds = orderModelIds(
      Object.keys(modelMap).filter((id) => id.trim().length > 0),
      provider.model_order,
    );

    const whitelist = provider.whitelist;
    const entries = Array.isArray(whitelist)
      ? whitelist.filter((value): value is string => typeof value === "string")
      : [];
    const allowed = entries.filter((entry) =>
      modelIds.some((modelId) => whitelistEntryMatches(entry, providerId, modelId)),
    );
    // A whitelist that matches nothing is in a shape we do not understand, so
    // it is not applied — an empty catalog is a worse answer than an
    // unrestricted one. The dropped entries are reported so a typo'd or
    // not-yet-populated whitelist is diagnosable.
    const restricted = allowed.length > 0;
    if (!restricted && entries.length > 0) {
      diagnostics?.ignoredWhitelists.push({ providerId, entries });
    }

    for (const modelId of modelIds) {
      if (restricted && !allowed.some((entry) => whitelistEntryMatches(entry, providerId, modelId)))
        continue;
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

/** One cached catalog, keyed by the config file it came from. */
interface CatalogCacheEntry {
  /** The config file this entry describes. */
  configPath: string;
  /** That file's mtime when it was read. */
  mtimeMs: number;
  /** The models it produced. */
  models: string[];
}

let cache: CatalogCacheEntry | null = null;

/** The in-flight reads, keyed by config path, so N concurrent callers for the
 * SAME path share ONE file read — and a caller for a DIFFERENT path never
 * receives another path's catalog.
 *
 * Each entry is wrapped in an object with a numeric id so the "is this still
 * the current read?" check compares numbers rather than comparing promises,
 * which is what CodeQL's `js/missing-await` rule flags. */
const pending = new Map<string, { id: number; promise: Promise<string[]> }>();
let pendingCounter = 0;

/** What one look at the config file found. */
type ConfigRead =
  { kind: "missing" } | { kind: "unchanged" } | { kind: "changed"; text: string; mtimeMs: number };

/**
 * Looks at the config file and reports whether it changed since the cached
 * entry.
 *
 * The file is opened ONCE and its mtime comes from that same descriptor
 * (`fstatSync`), so the mtime and the content cannot disagree: there is no
 * stat-then-read window for a concurrent writer to slip into. (A separate
 * `statSync` followed by a `readFileSync` would be exactly the file-system
 * race CodeQL's `js/file-system-race` rule flags — the same hazard the mcode
 * adapter's `readFileOrNull` documents.)
 */
function readConfigFile(configPath: string): ConfigRead {
  let fd: number | null = null;
  try {
    fd = openSync(configPath, "r");
    const mtimeMs = fstatSync(fd).mtimeMs;
    if (cache?.configPath === configPath && cache.mtimeMs === mtimeMs) {
      return { kind: "unchanged" };
    }
    return { kind: "changed", text: readFileSync(fd, "utf8"), mtimeMs };
  } catch {
    return { kind: "missing" };
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // A failed close must not change the answer.
      }
    }
  }
}

/** mcode's config file, inside its data dir. */
export function resolveMcodeConfigPath(dataDir: string = resolveMcodeDataDir()): string {
  return path.join(dataDir, "config.yaml");
}

export interface McodeModelCatalogOptions {
  /** Injectable data dir, for the test. Defaults to mcode's own resolution
   * (`MINIMAX_DATA_DIR` → `MAVIS_DATA_DIR` → `~/.minimax`). */
  dataDir?: string;
}

/**
 * The catalog of model ids mcode can be launched with, or `[]` when there is
 * none to report.
 *
 * The cached entry is keyed by the resolved config path and invalidated by
 * that file's mtime, so a change to mcode's own config is reflected on the
 * next call rather than after a TTL.
 */
export async function listMcodeModels(opts: McodeModelCatalogOptions = {}): Promise<string[]> {
  const configPath = resolveMcodeConfigPath(opts.dataDir ?? resolveMcodeDataDir());

  // Concurrency: one file read shared by N simultaneous callers for the SAME
  // path. A caller for a different path starts its own read — the slot is
  // keyed, so it can never receive another path's catalog.
  const inFlight = pending.get(configPath);
  if (inFlight !== undefined) return await inFlight.promise;

  const id = ++pendingCounter;
  const promise = (async () => {
    try {
      const read = readConfigFile(configPath);
      if (read.kind === "missing") {
        // The file is gone (or unreadable): drop any entry for it, so a
        // later reappearance is read fresh.
        if (cache?.configPath === configPath) cache = null;
        return [];
      }
      if (read.kind === "unchanged") {
        // readConfigFile only reports "unchanged" when the cached entry is
        // for THIS path and this file's mtime — so the entry is there.
        return cache?.models ?? [];
      }
      const diagnostics: McodeCatalogDiagnostics = { ignoredWhitelists: [] };
      const models = parseMcodeModelCatalog(read.text, diagnostics);
      for (const ignored of diagnostics.ignoredWhitelists) {
        // A whitelist that matched nothing was dropped (see
        // parseMcodeModelCatalog) — which is also what a typo'd or
        // not-yet-populated whitelist looks like, so say which one it was.
        console.debug("[mcode-models] ignored a whitelist that matched no model", {
          providerId: ignored.providerId,
          entries: ignored.entries,
        });
      }
      cache = { configPath, mtimeMs: read.mtimeMs, models };
      return models;
    } catch {
      // A catalog is a convenience, never a hard dependency — a failure here
      // must not take the Settings section down with it.
      return [];
    }
  })();
  pending.set(configPath, { id, promise });

  try {
    return await promise;
  } finally {
    if (pending.get(configPath)?.id === id) pending.delete(configPath);
  }
}

/** Drops the cached catalog. Exported for tests. */
export function resetMcodeModelsCache(): void {
  cache = null;
  pending.clear();
}
