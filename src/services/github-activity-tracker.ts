type RepoState = "active" | "quiet" | "stalled";

interface RepoActivity {
  state: RepoState;
  lastWebhookAt: number;
  lastActiveAt: number;
}

// Tracks per-repo activity state for the adaptive poller. A repo is "active"
// when it has open PRs or running CI; "quiet" when it doesn't; "stalled"
// when no webhook has been received for >staleThresholdMs (safety-net
// re-sync trigger).
export class ActivityTracker {
  private repos = new Map<string, RepoActivity>();
  private readonly activeIntervalMs: number;
  private readonly quietIntervalMs: number;
  private readonly activeTimeoutMs: number;
  private readonly staleThresholdMs: number;

  constructor(
    opts: {
      activeIntervalMs?: number;
      quietIntervalMs?: number;
      activeTimeoutMs?: number;
      staleThresholdMs?: number;
    } = {},
  ) {
    this.activeIntervalMs = opts.activeIntervalMs ?? 15_000;
    this.quietIntervalMs = opts.quietIntervalMs ?? 60_000;
    this.activeTimeoutMs = opts.activeTimeoutMs ?? 120_000;
    this.staleThresholdMs = opts.staleThresholdMs ?? 300_000;
  }

  getIntervalFor(repoKey: string): number {
    const activity = this.repos.get(repoKey);
    if (!activity) return this.quietIntervalMs;

    const now = Date.now();

    // Stalled: no webhook too long, go aggressive.
    if (now - activity.lastWebhookAt > this.staleThresholdMs) {
      activity.state = "stalled";
      return Math.floor(this.activeIntervalMs * 2); // 30s with default 15s active
    }

    // Quiet for too long → go slow.
    if (activity.state !== "active" || now - activity.lastActiveAt > this.activeTimeoutMs) {
      activity.state = "quiet";
      return this.quietIntervalMs;
    }

    return this.activeIntervalMs;
  }

  recordWebhook(repoKey: string): void {
    const now = Date.now();
    const existing = this.repos.get(repoKey);
    this.repos.set(repoKey, {
      state: existing?.state === "stalled" ? "active" : (existing?.state ?? "active"),
      lastWebhookAt: now,
      lastActiveAt: now,
    });
  }

  recordPollResult(repoKey: string, hasActivity: boolean): void {
    const now = Date.now();
    const existing = this.repos.get(repoKey);

    if (hasActivity) {
      this.repos.set(repoKey, {
        state: "active",
        lastWebhookAt: now,
        lastActiveAt: now,
      });
    } else if (!existing) {
      this.repos.set(repoKey, {
        state: "quiet",
        lastWebhookAt: now,
        lastActiveAt: now,
      });
    } else {
      // keep last known active time (unchanged)
    }
  }

  /** Test-only introspection. */
  getStateForTests(repoKey: string): RepoState | undefined {
    return this.repos.get(repoKey)?.state;
  }

  clearForTests(): void {
    this.repos.clear();
  }
}

declare module "fastify" {
  interface FastifyInstance {
    githubActivityTracker?: ActivityTracker;
  }
}
