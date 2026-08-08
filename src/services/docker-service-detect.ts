import { spawn as spawnChild } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

// Issue #73 — discovers Docker Compose services running on this host so the
// Dock (src/routes/projects.ts's GET /api/projects/:id/dock) can surface
// them as ordinary DockControl entries alongside `.crs/dock.json` ones. This
// module is read-only: it never starts/stops a container itself, only
// spawns `docker` to *ask* it what's already running — same posture as
// agent-detect.ts's binary probe and git-status.ts's `git status` shell-out,
// which this file's spawn/cache/timeout shape is deliberately copied from.
//
// Local-host only. A remote-hosted project's dock route never calls this
// (see projects.ts) — same scoping as dev-server port detection
// (docs/dock.md's "Only works for local-host projects" section).

const DOCKER_TIMEOUT_MS = 5_000;
// Longer than git-status.ts's 5s cache on purpose: the frontend polls each
// dock column on an independent 15s timer (Dock.tsx), and a TTL under that
// interval only collapses concurrent polls of a SINGLE column onto one
// spawn — multiple columns polling on their own 15s clocks would otherwise
// each pay for their own `docker ps`. 10s keeps state at most 10s stale
// while still collapsing near-concurrent polls across columns via the
// in-flight map below.
const CACHE_TTL_MS = 10_000;

const COMPOSE_DEFAULT_FILENAMES = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
];

export type ComposeServiceState =
  "running" | "exited" | "paused" | "restarting" | "created" | "dead" | "removing";

const KNOWN_STATES: readonly ComposeServiceState[] = [
  "running",
  "exited",
  "paused",
  "restarting",
  "created",
  "dead",
  "removing",
];

export interface ComposeService {
  composeProject: string;
  service: string;
  containerName: string;
  workingDir: string;
  state: ComposeServiceState;
  status: string;
  imageRef: string;
  imageId: string;
  /** No registry image to pull/compare — a `build:`-only service. Set at
   * discovery time only, from the image-name heuristic below (looksBuildOnly).
   * A failed check-update pull for a service NOT already flagged this way
   * (a private registry, transient network failure, …) surfaces as
   * `reason: "pull-failed"` instead — see projects.ts's docker/check-update
   * route — rather than being memoized into `buildOnly` here, so a
   * transient failure doesn't permanently hide the update actions for a
   * service that legitimately has a registry image. */
  buildOnly: boolean;
  /** Whether a default-named compose file exists directly in workingDir —
   * see toDockControls() for why this decides the synthesized command. */
  composeResolvable: boolean;
}

function warn(message: string, err?: unknown): void {
  // Same log-injection guard as project-config.ts's warn(): message/err can
  // both embed caller-controlled data (a container label), so substitute
  // rather than interpolate, and strip newlines from both.
  const safeMessage = message.replace(/[\r\n]+/g, " ");
  const safeErr =
    err === undefined
      ? ""
      : String(err instanceof Error ? err.message : err).replace(/[\r\n]+/g, " ");
  console.warn("[docker-service-detect] %s", safeMessage, safeErr);
}

function dockerEnv(): NodeJS.ProcessEnv {
  // LC_ALL=C for the same reason as git-env.ts's gitEnv(): this module
  // parses `docker`'s own CLI output structurally (tab-separated Go
  // template fields, not localized text), but pinning the locale is cheap
  // insurance against any future field that isn't.
  return { ...process.env, LC_ALL: "C" };
}

/** Runs `docker <args>`, capturing stdout on `'close'` (not `'exit'` — see
 * agent-detect.ts's probe() and git-status.ts's runGitStatus() for the same
 * documented stdout-delivery race). Never rejects; resolves `null` on any
 * non-zero exit, spawn error, or timeout — "docker failed" and "docker not
 * installed" are both just "nothing to show" here. */
function runDocker(args: string[], timeoutMs = DOCKER_TIMEOUT_MS): Promise<string | null> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawnChild("docker", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: dockerEnv(),
    });

    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      warn("docker spawn error", err);
      finish(null);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        warn(`docker exited non-zero (code ${String(code)})`, stderr.trim());
        finish(null);
      } else {
        finish(stdout);
      }
    });
  });
}

// Field order must match the split() below. Not `--format '{{json .}}'`:
// Docker's JSON `Labels` field is a single comma-joined string, and label
// VALUES themselves contain commas (verified live against
// com.docker.compose.depends_on and …project.config_files), so it can't be
// split back apart unambiguously. A tab is never a legal character in any
// of these fields (names, image refs, and compose labels are all
// shell/DNS-safe token sets), so a literal-tab-joined template is safe to
// split on unambiguously — verified against a live multi-service stack.
const PS_FORMAT = [
  "{{.ID}}",
  "{{.Names}}",
  "{{.State}}",
  "{{.Status}}",
  "{{.Image}}",
  "{{.CreatedAt}}",
  '{{.Label "com.docker.compose.project"}}',
  '{{.Label "com.docker.compose.service"}}',
  '{{.Label "com.docker.compose.project.working_dir"}}',
  '{{.Label "com.docker.compose.image"}}',
  '{{.Label "com.docker.compose.oneoff"}}',
].join("\t");

interface RawRow {
  containerName: string;
  state: string;
  status: string;
  image: string;
  createdAt: string;
  composeProject: string;
  service: string;
  workingDir: string;
  imageId: string;
  oneoff: string;
}

function parsePsOutput(output: string): RawRow[] {
  const rows: RawRow[] = [];
  for (const line of output.split("\n")) {
    if (line.trim() === "") continue;
    const fields = line.split("\t");
    // id is fields[0], intentionally unused — containers are deduped by
    // (composeProject, service), not by container id.
    const [
      ,
      containerName,
      state,
      status,
      image,
      createdAt,
      composeProject,
      service,
      workingDir,
      imageId,
      oneoff,
    ] = fields;
    if (!composeProject || !service || !workingDir) continue;
    rows.push({
      containerName: containerName ?? "",
      state: state ?? "",
      status: status ?? "",
      image: image ?? "",
      createdAt: createdAt ?? "",
      composeProject,
      service,
      workingDir,
      imageId: imageId ?? "",
      oneoff: oneoff ?? "",
    });
  }
  return rows;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** compose's own default build-image name (`<project>-<service>[:latest]`,
 * verified live against a build:-only stack) — a service still using that
 * name never had a registry image pulled, so `docker compose pull` /
 * `check-update` can never do anything useful for it. */
function looksBuildOnly(imageRef: string, composeProject: string, service: string): boolean {
  const pattern = new RegExp(
    `^${escapeRegExp(composeProject)}-${escapeRegExp(service)}(:latest)?$`,
  );
  return pattern.test(imageRef);
}

function isComposeResolvable(workingDir: string): boolean {
  if (!path.isAbsolute(workingDir)) return false;
  return COMPOSE_DEFAULT_FILENAMES.some((name) => existsSync(path.join(workingDir, name)));
}

function toComposeState(raw: string): ComposeServiceState {
  return (KNOWN_STATES as readonly string[]).includes(raw) ? (raw as ComposeServiceState) : "dead";
}

/** Collapses replicas and stray leftovers to one entry per (project,
 * service): drops `docker compose run` one-offs entirely, then picks a
 * single representative per key — a running container over an
 * exited/other one, and among ties the most recently created (CreatedAt
 * sorts lexically here since every row shares docker's fixed timestamp
 * format). */
function dedupe(rows: RawRow[]): RawRow[] {
  const byKey = new Map<string, RawRow>();
  for (const row of rows) {
    if (row.oneoff === "True") continue;
    const key = `${row.composeProject} ${row.service}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, row);
      continue;
    }
    const existingRunning = existing.state === "running";
    const rowRunning = row.state === "running";
    if (rowRunning && !existingRunning) {
      byKey.set(key, row);
    } else if (rowRunning === existingRunning && row.createdAt > existing.createdAt) {
      byKey.set(key, row);
    }
  }
  return [...byKey.values()];
}

function toComposeService(row: RawRow): ComposeService {
  return {
    composeProject: row.composeProject,
    service: row.service,
    containerName: row.containerName,
    workingDir: row.workingDir,
    state: toComposeState(row.state),
    status: row.status,
    imageRef: row.image,
    imageId: row.imageId,
    buildOnly: looksBuildOnly(row.image, row.composeProject, row.service),
    composeResolvable: isComposeResolvable(row.workingDir),
  };
}

async function probeComposeServices(): Promise<ComposeService[]> {
  const output = await runDocker([
    "ps",
    "-a",
    "--no-trunc",
    "--filter",
    "label=com.docker.compose.project",
    "--format",
    PS_FORMAT,
  ]);
  if (output === null) return [];
  return dedupe(parsePsOutput(output)).map(toComposeService);
}

let cache: { data: ComposeService[]; expiresAt: number } | null = null;
let inFlight: Promise<ComposeService[]> | null = null;

/** Best-effort discovery of every Compose service on this host, TTL-cached
 * with in-flight dedup so concurrent dock-column polls share one `docker
 * ps` spawn. Never throws — `docker` missing or failing degrades to `[]`. */
export async function getComposeServices(forceRefresh = false): Promise<ComposeService[]> {
  if (!forceRefresh && cache && cache.expiresAt > Date.now()) {
    return cache.data;
  }
  if (inFlight) return inFlight;

  const promise = probeComposeServices()
    .then((data) => {
      cache = { data, expiresAt: Date.now() + CACHE_TTL_MS };
      return data;
    })
    .finally(() => {
      inFlight = null;
    });
  inFlight = promise;
  return promise;
}

/** Exported for tests only — production never needs to clear this. */
export function clearComposeCacheForTests(): void {
  cache = null;
  inFlight = null;
}

/** Runtime probe for `docker compose` (v2 plugin) availability, cached
 * alongside the main service cache's lifetime — cheap and stable enough
 * per-process that a dedicated TTL would be pure overhead. */
let composeAvailable: boolean | null = null;

export async function isDockerComposeAvailable(forceRefresh = false): Promise<boolean> {
  if (!forceRefresh && composeAvailable !== null) return composeAvailable;
  const output = await runDocker(["compose", "version"]);
  composeAvailable = output !== null;
  return composeAvailable;
}

/** Exported for tests only. */
export function clearComposeAvailabilityCacheForTests(): void {
  composeAvailable = null;
}

// A pull can genuinely take a while on a slow link / large image — much
// longer than the 5s default used for the cheap `ps`/`inspect` probes above.
const PULL_TIMEOUT_MS = 120_000;

/** Runs `docker compose ... pull --quiet <service>` for one service — an
 * argv array built entirely from this ComposeService's own fields (never
 * from a request body directly; see projects.ts's resolveOwnedService),
 * so no shell-quoting is needed here, unlike the logs command above.
 * Returns whether the pull succeeded; never throws. */
export async function pullComposeImageQuietly(service: ComposeService): Promise<boolean> {
  const output = await runDocker(
    [
      "compose",
      "-p",
      service.composeProject,
      "--project-directory",
      service.workingDir,
      "pull",
      "--quiet",
      service.service,
    ],
    PULL_TIMEOUT_MS,
  );
  return output !== null;
}

/** `docker image inspect <ref> --format '{{.Id}}'` — the "latest" half of
 * the check-update comparison (the "current" half is the running
 * container's own `com.docker.compose.image` label, already in
 * ComposeService.imageId). Null on any failure. */
export async function inspectImageId(imageRef: string): Promise<string | null> {
  const output = await runDocker(["image", "inspect", imageRef, "--format", "{{.Id}}"]);
  if (output === null) return null;
  const trimmed = output.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Assigns each service to at most one registered project cwd: the
 * *longest* matching cwd among `allProjectCwds` that equals or is an
 * ancestor of the service's workingDir. This matters when two registered
 * projects nest (a monorepo root and a subdirectory both registered) —
 * without picking the longest match, a service that belongs to the nested
 * project would also appear in the parent project's Dock column.
 */
function resolveOwnerCwd(workingDir: string, allProjectCwds: string[]): string | null {
  const resolved = path.resolve(workingDir);
  let best: string | null = null;
  for (const candidate of allProjectCwds) {
    const resolvedCandidate = path.resolve(candidate);
    const isMatch =
      resolved === resolvedCandidate || resolved.startsWith(resolvedCandidate + path.sep);
    if (isMatch && (best === null || resolvedCandidate.length > best.length)) {
      best = resolvedCandidate;
    }
  }
  return best;
}

/** Filters `services` down to the ones owned by `projectCwd` — see
 * resolveOwnerCwd() for the nested-project tie-break. `allProjectCwds`
 * should include every registered local-host project's cwd (including
 * `projectCwd` itself). */
export function mapServicesToProject(
  services: ComposeService[],
  projectCwd: string,
  allProjectCwds: string[],
): ComposeService[] {
  const resolvedProjectCwd = path.resolve(projectCwd);
  return services.filter(
    (service) => resolveOwnerCwd(service.workingDir, allProjectCwds) === resolvedProjectCwd,
  );
}

/** Single-quote wraps a value for safe interpolation into a shell command
 * string — dock control commands run through PtyManager's shell, and every
 * component here (project name, service name, working dir) originates from
 * a container label, so this is not optional. `'` -> `'\''` (close quote,
 * escaped literal quote, reopen quote) is the standard POSIX-shell-safe
 * single-quote escape. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function composeLogsCommand(svc: ComposeService, composeAvailableNow: boolean): string {
  if (composeAvailableNow && svc.composeResolvable) {
    return (
      `docker compose -p ${shellQuote(svc.composeProject)} ` +
      `--project-directory ${shellQuote(svc.workingDir)} ` +
      `logs -f --tail=200 ${shellQuote(svc.service)}`
    );
  }
  // Fallback: either `docker compose` itself is unavailable (Compose
  // V1-only host), or dropping -f means compose would have to resolve its
  // config by default filename under --project-directory, and no
  // default-named file exists there (a stack started with an explicit
  // `-f docker-compose.prod.yml`, or a compose dir that's since been
  // removed) — either way, the compose invocation would fail the instant
  // it's toggled on. `docker logs` needs no compose config at all.
  return `docker logs -f --tail=200 ${shellQuote(svc.containerName)}`;
}

export interface DockerDockControl {
  id: string;
  title: string;
  command: string;
  source: "docker";
  docker: {
    composeProject: string;
    service: string;
    containerName: string;
    state: ComposeServiceState;
    status: string;
    imageRef: string;
    imageId: string;
    buildOnly: boolean;
  };
}

/** Synthesizes one DockControl-shaped object per service. Deliberately does
 * NOT round-trip through project-config.ts's normalizeRawControl() — that
 * function is the trust boundary for user-authored `.crs/dock.json`, and
 * leaving it untouched makes it structurally impossible for a project's own
 * dock.json to forge a `source`/`docker` field. */
export async function toDockControls(services: ComposeService[]): Promise<DockerDockControl[]> {
  const composeAvailableNow = await isDockerComposeAvailable();
  return services.map((svc) => ({
    id: `docker:${svc.composeProject}:${svc.service}`,
    title: svc.service,
    command: composeLogsCommand(svc, composeAvailableNow),
    source: "docker",
    docker: {
      composeProject: svc.composeProject,
      service: svc.service,
      containerName: svc.containerName,
      state: svc.state,
      status: svc.status,
      imageRef: svc.imageRef,
      imageId: svc.imageId,
      buildOnly: svc.buildOnly,
    },
  }));
}
