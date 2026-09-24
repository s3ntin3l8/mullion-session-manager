import type { FastifyInstance } from "fastify";
import type { AppSettings, LogLevel } from "./settings.js";

// Env-configured behaviour knobs that the Settings UI can override at
// runtime. Each settings field uses -1 / "inherit" to mean "no override";
// these resolvers turn that into the effective value, falling back to the
// env var. Pure over (settings, env) so they're testable without a DB.

export interface RuntimeEnvDefaults {
  githubPollActiveSeconds: number;
  githubPollQuietSeconds: number;
  githubPollStaleThresholdSeconds: number;
  hostHeartbeatSeconds: number;
  browserFramerate: number;
  logLevel: LogLevel;
}

type ConfigSource = Pick<FastifyInstance, "config">;

export function runtimeEnvDefaults(app: ConfigSource): RuntimeEnvDefaults {
  return {
    githubPollActiveSeconds: app.config.GITHUB_POLL_INTERVAL_ACTIVE,
    githubPollQuietSeconds: app.config.GITHUB_POLL_INTERVAL_QUIET,
    githubPollStaleThresholdSeconds: app.config.GITHUB_POLL_STALE_THRESHOLD,
    hostHeartbeatSeconds: app.config.HOST_HEARTBEAT_INTERVAL_SECONDS,
    browserFramerate: app.config.BROWSER_FRAMERATE,
    logLevel: app.config.LOG_LEVEL as LogLevel,
  };
}

function inherit(value: number, fallback: number): number {
  return value === -1 ? fallback : value;
}

export interface GitHubPollIntervals {
  activeSeconds: number;
  quietSeconds: number;
  staleThresholdSeconds: number;
}

export function resolveGitHubPoll(settings: AppSettings, app: ConfigSource): GitHubPollIntervals {
  const env = runtimeEnvDefaults(app);
  return {
    activeSeconds: inherit(settings.github.pollActiveSeconds, env.githubPollActiveSeconds),
    quietSeconds: inherit(settings.github.pollQuietSeconds, env.githubPollQuietSeconds),
    staleThresholdSeconds: inherit(
      settings.github.pollStaleThresholdSeconds,
      env.githubPollStaleThresholdSeconds,
    ),
  };
}

export function toActivityIntervals(poll: GitHubPollIntervals): {
  activeIntervalMs: number;
  quietIntervalMs: number;
  staleThresholdMs: number;
} {
  return {
    activeIntervalMs: poll.activeSeconds * 1000,
    quietIntervalMs: poll.quietSeconds * 1000,
    staleThresholdMs: poll.staleThresholdSeconds * 1000,
  };
}

export function resolveHeartbeatSeconds(settings: AppSettings, app: ConfigSource): number {
  return inherit(settings.hosts.heartbeatSeconds, runtimeEnvDefaults(app).hostHeartbeatSeconds);
}

export function resolveBrowserFramerate(settings: AppSettings, app: ConfigSource): number {
  return Math.max(1, inherit(settings.browser.framerate, runtimeEnvDefaults(app).browserFramerate));
}

export function resolveLogLevel(settings: AppSettings, app: ConfigSource): LogLevel {
  return settings.server.logLevel === "inherit"
    ? runtimeEnvDefaults(app).logLevel
    : settings.server.logLevel;
}
