import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// 1h in-memory TTL — `opencode models` shells out to every configured
// provider's API to build the catalog, which is slow and the catalog
// is effectively static. One process-wide cache shared by all callers.
const CACHE_TTL_MS = 60 * 60 * 1000;

let cache: { fetchedAt: number; models: string[] } | null = null;

export type ExecFn = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

export async function listOpenCodeModels(
  opts: { exec?: ExecFn; now?: () => number } = {},
): Promise<string[]> {
  const exec = opts.exec ?? ((file, args) => execFileP(file, args));
  const now = opts.now ?? Date.now;

  if (cache !== null && now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.models;
  }

  let stdout: string;
  try {
    ({ stdout } = await exec("opencode", ["models"]));
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
}

export function resetOpenCodeModelsCache(): void {
  cache = null;
}
