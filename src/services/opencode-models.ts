import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// 1h in-memory TTL — `opencode models` shells out to every configured
// provider's API to build the catalog, which is slow and the catalog
// is effectively static. One process-wide cache shared by all callers.
const CACHE_TTL_MS = 60 * 60 * 1000;

// 10s hard cap — `opencode models` shells out to every configured
// provider, so a slow/hung provider blocks the endpoint indefinitely
// and leaks the child. AbortController kills the child on timeout.
const EXEC_TIMEOUT_MS = 10_000;

let cache: { fetchedAt: number; models: string[] } | null = null;

// Dedup concurrent cold-cache calls — when multiple requests arrive while
// the cache is cold, only one `opencode models` exec runs; the others
// await the same in-flight promise.
let pending: Promise<string[]> | null = null;

export type ExecFn = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

export async function listOpenCodeModels(
  opts: { exec?: ExecFn; now?: () => number } = {},
): Promise<string[]> {
  const exec = opts.exec ?? ((file, args) => execFileP(file, args));
  const now = opts.now ?? Date.now;

  if (cache !== null && now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.models;
  }

  // Dedup — if a cold-cache exec is already in flight, wait for it.
  if (pending !== null) {
    return pending;
  }

  pending = (async () => {
    try {
      let stdout: string;
      try {
        // Race the exec against a hard timeout — a slow/hung provider
        // (e.g. one that never responds) would otherwise block the
        // endpoint indefinitely and leak the child process.
        ({ stdout } = await Promise.race([
          exec("opencode", ["models"]),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("opencode models timed out")), EXEC_TIMEOUT_MS),
          ),
        ]));
      } catch {
        cache = { fetchedAt: now(), models: [] };
        return [];
      }

      const models = Array.from(
        new Set(
          stdout
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0),
        ),
      ).sort();
      cache = { fetchedAt: now(), models };
      return models;
    } finally {
      pending = null;
    }
  })();

  return pending;
}

export function resetOpenCodeModelsCache(): void {
  cache = null;
  pending = null;
}
