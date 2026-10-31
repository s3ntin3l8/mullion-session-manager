import type { FastifyInstance } from "fastify";
import { LOCAL_HOST_ID } from "../shared/constants.js";
import { effectiveProjectsRoots } from "./agent-projects-roots.js";
import { normalizeGitRemote, readOriginUrl } from "./git-remote.js";
import { getRemoteHostClient } from "./remote-host-client.js";

// Lazy checkout materialization needs to know, SYNCHRONOUSLY inside placement,
// whether a project is a git project (has an origin remote) and whether a host
// has projects roots to clone into. Both are cheap for the primary's own host
// and need a round trip for a remote one, so remote answers are cached here and
// refreshed in the background: until a remote project's origin has been read it
// reads as unknown (= not a git project), which only means "do not clone yet".

const ORIGIN_TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 500;

interface Entry {
  /** The raw `origin` URL; null = no origin (not a git project) or unreadable. */
  url: string | null;
  at: number;
}

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<string | null>>();

function keyOf(project: { hostId: string; cwd: string }): string {
  return `${project.hostId}\0${project.cwd}`;
}

function remember(key: string, url: string | null): void {
  if (!cache.has(key) && cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { url, at: Date.now() });
}

async function readRemoteOrigin(
  app: FastifyInstance,
  project: { hostId: string; cwd: string },
): Promise<string | null> {
  try {
    const list = await getRemoteHostClient(app, project.hostId).discover();
    if (!Array.isArray(list)) return null;
    const own = list.find((c) => c?.cwd === project.cwd);
    return typeof own?.origin === "string" && own.origin.length <= 4096 ? own.origin : null;
  } catch {
    return null;
  }
}

/**
 * The raw origin URL of the project's checkout on its own host, awaiting a
 * remote read when it is not cached. Null = not a git project, or unreadable.
 */
export function warmProjectOriginUrl(
  app: FastifyInstance,
  project: { hostId: string; cwd: string },
): Promise<string | null> {
  const key = keyOf(project);
  if (project.hostId === LOCAL_HOST_ID) {
    const url = readOriginUrl(project.cwd);
    remember(key, url);
    return Promise.resolve(url);
  }
  const running = inflight.get(key);
  if (running) return running;
  const pending = readRemoteOrigin(app, project)
    .then((url) => {
      remember(key, url);
      return url;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, pending);
  return pending;
}

/** The cached raw origin URL; kicks off a background read when stale or missing. */
export function cachedProjectOriginUrl(
  app: FastifyInstance,
  project: { hostId: string; cwd: string },
): string | null {
  if (project.hostId === LOCAL_HOST_ID) return readOriginUrl(project.cwd);
  const hit = cache.get(keyOf(project));
  if (!hit || Date.now() - hit.at >= ORIGIN_TTL_MS) void warmProjectOriginUrl(app, project);
  return hit?.url ?? null;
}

/** The normalized origin (`host/owner/repo`) or null; never blocks. */
export function cachedProjectOrigin(
  app: FastifyInstance,
  project: { hostId: string; cwd: string },
): string | null {
  const url = cachedProjectOriginUrl(app, project);
  return url === null ? null : normalizeGitRemote(url);
}

/**
 * The host's `PROJECTS_ROOTS` as far as the primary knows: its own are read
 * live, a remote host's come from the agent tracker. Null = unknown.
 */
export function hostProjectsRoots(app: FastifyInstance, hostId: string): string[] | null {
  if (hostId === LOCAL_HOST_ID) {
    try {
      return effectiveProjectsRoots(app);
    } catch {
      return null;
    }
  }
  return app.hostAgentTracker?.get(hostId)?.projectsRoots ?? null;
}

export function clearProjectOriginCacheForTests(): void {
  cache.clear();
  inflight.clear();
}

/**
 * The HTTPS URL to clone a project from, derived from its origin. Managed
 * clones are https-only: an ssh remote is rewritten to the same host and path,
 * and any userinfo is dropped (a token travels separately). Null when the
 * remote has no usable network form.
 */
export function cloneUrlFromRemote(raw: string): string | null {
  const url = raw.trim();
  if (normalizeGitRemote(url) === null) return null;
  const scp = /^[^@/\s]+@([^:/\s]+):(?!\d+\/)(.+)$/.exec(url);
  if (scp) return `https://${scp[1]}/${scp[2].replace(/^\/+/, "")}`;
  try {
    const parsed = new URL(url);
    if (!["https:", "http:", "ssh:", "git:"].includes(parsed.protocol)) return null;
    const keepPort = parsed.protocol.startsWith("http") && parsed.port !== "";
    return `https://${parsed.hostname}${keepPort ? `:${parsed.port}` : ""}${parsed.pathname}`;
  } catch {
    return null;
  }
}

/** The directory name for a clone: the repo's last path segment, one safe segment. */
export function cloneNameFromRemote(raw: string): string | null {
  const normalized = normalizeGitRemote(raw);
  if (normalized === null) return null;
  const last = normalized.split("/").pop() ?? "";
  const name = last.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9_]+/, "");
  return name === "" ? null : name.slice(0, 100);
}
