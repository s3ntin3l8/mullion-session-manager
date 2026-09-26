import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { validateCliModel } from "./task-model-resolve.js";

const execFileP = promisify(execFile);

// 1h in-memory TTL — `opencode models` shells out to every configured
// provider's API to build the catalog, which is slow and the catalog
// is effectively static. One process-wide cache shared by all callers.
// ONLY successful execs populate the cache — a transient failure
// (timeout, provider hang, ENOENT) leaves `cache` untouched, so the
// next call retries the shell-out rather than holding a 1h-long
// "nothing here" answer (Hermes review, PR #961 round 2).
const CACHE_TTL_MS = 60 * 60 * 1000;

// 10s hard cap — `opencode models` shells out to every configured
// provider, so a slow/hung provider blocks the endpoint indefinitely
// and leaks the child. Promise.race rejects, AND the AbortController
// fires so `execFile` actually SIGTERMs the child (a plain Promise.race
// only rejects the wrapper promise — the child keeps running).
const EXEC_TIMEOUT_MS = 10_000;

export type ExecFn = (
  file: string,
  args: string[],
  options: { signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string }>;

interface ModelCatalog {
  list: (opts?: { exec?: ExecFn; now?: () => number }) => Promise<string[]>;
  reset: () => void;
}

// One catalog per CLI that can list its own models. Each instance keeps its
// own cache and in-flight promise, so a slow `opencode models` never blocks
// (or poisons) `agy models`.
function createModelCatalog(config: {
  file: string;
  args: string[];
  parse: (stdout: string) => string[];
  // Cache a successful-but-empty parse. Off for CLIs whose output format we
  // don't control: an unrecognised format would otherwise pin "no models" for
  // an hour, where an empty result is cheap to retry.
  cacheEmpty?: boolean;
}): ModelCatalog {
  let cache: { fetchedAt: number; models: string[] } | null = null;

  // Dedup concurrent cold-cache calls — when multiple requests arrive while
  // the cache is cold, only one exec runs; the others await the same
  // in-flight promise.
  let pending: Promise<string[]> | null = null;

  async function list(opts: { exec?: ExecFn; now?: () => number } = {}): Promise<string[]> {
    const exec =
      opts.exec ??
      // `codex debug models` prints ~0.5 MB of JSON, past execFile's 1 MB
      // default headroom for comfort; give every catalog room.
      ((file, args, options) =>
        execFileP(file, args, { signal: options.signal, maxBuffer: 8 * 1024 * 1024 }));
    const now = opts.now ?? Date.now;

    if (cache !== null && now() - cache.fetchedAt < CACHE_TTL_MS) {
      return cache.models;
    }

    // Dedup — if a cold-cache exec is already in flight, wait for it.
    if (pending !== null) {
      return pending;
    }

    pending = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), EXEC_TIMEOUT_MS);
      try {
        let stdout: string;
        try {
          // Race the exec against a hard timeout. The AbortController
          // fires on timeout — execFile's signal option SIGTERMs the
          // child, so a hung provider actually stops, not just gets
          // abandoned. Promise.race's reject is for the wrapper promise
          // alone; the abort is what kills the child.
          ({ stdout } = await Promise.race([
            exec(config.file, config.args, { signal: controller.signal }),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error(`${config.file} models timed out`)),
                EXEC_TIMEOUT_MS,
              ),
            ),
          ]));
        } catch {
          // Hermes review, PR #961 round 2 — do NOT cache transient
          // failures (a hung provider shouldn't pin "[]" for a full
          // hour). Leave `cache` untouched, return [] for this call;
          // the next caller retries.
          return [];
        }

        const models = config.parse(stdout);
        if (models.length > 0 || config.cacheEmpty !== false) {
          cache = { fetchedAt: now(), models };
        }
        return models;
      } finally {
        clearTimeout(timer);
        controller.abort();
        pending = null;
      }
    })();

    return pending;
  }

  return {
    list,
    reset: () => {
      cache = null;
      pending = null;
    },
  };
}

const opencodeCatalog = createModelCatalog({
  file: "opencode",
  args: ["models"],
  parse: (stdout) =>
    Array.from(
      new Set(
        stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
      ),
    ).sort(),
});

// `agy models` prints `slug<whitespace>Display Name` rows on stdout (its
// "Fetching available models..." header goes to stderr, which execFile keeps
// separate). Take the first whitespace-delimited column so a change from tabs
// to spaces doesn't silently empty the list. The slug must also pass the same
// allowlist the launch path applies, so a value the picker offers is never one
// `resolveCliModel` would later drop. CLI order is kept — it groups families
// and tiers, which a sort would scramble.
const agyCatalog = createModelCatalog({
  file: "agy",
  args: ["models"],
  cacheEmpty: false,
  parse: (stdout) =>
    Array.from(
      new Set(
        stdout
          .split("\n")
          .map((line) => line.trim().split(/\s+/)[0] ?? "")
          .filter((slug) => validateCliModel(slug)),
      ),
    ),
});

// `codex debug models` prints JSON: { models: [{ slug, visibility, priority }] }.
// Only `visibility: "list"` entries are user-selectable (the rest are internal,
// e.g. codex-auto-review); `priority` is Codex's own ordering.
const codexCatalog = createModelCatalog({
  file: "codex",
  args: ["debug", "models"],
  cacheEmpty: false,
  parse: (stdout) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return [];
    }
    const models = (parsed as { models?: unknown } | null)?.models;
    if (!Array.isArray(models)) return [];
    const entries = models.filter(
      (m): m is { slug: string; priority?: number } =>
        typeof m === "object" &&
        m !== null &&
        (m as { visibility?: unknown }).visibility === "list" &&
        typeof (m as { slug?: unknown }).slug === "string" &&
        validateCliModel((m as { slug: string }).slug),
    );
    entries.sort((a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity));
    return Array.from(new Set(entries.map((m) => m.slug)));
  },
});

export const listOpenCodeModels = opencodeCatalog.list;
export const resetOpenCodeModelsCache = opencodeCatalog.reset;
export const listAgyModels = agyCatalog.list;
export const resetAgyModelsCache = agyCatalog.reset;
export const listCodexModels = codexCatalog.list;
export const resetCodexModelsCache = codexCatalog.reset;
