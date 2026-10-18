// A slow measurement (a `/tmp` walk can take minutes) must never hold an HTTP
// request open, and must never run twice at once. This wraps one such
// measurement: a read starts it when nothing fresh is held, waits briefly for
// it, and otherwise answers "measuring" while the run carries on in the
// background. The TTL counts from when a run *finishes*, so a long run can't
// expire its own result and trigger a second one alongside it.

export interface ProbeMeta {
  state: "measuring" | "ready" | "error";
  /** ISO time the held value was measured; null until a first run lands. */
  measuredAt: string | null;
  error?: string;
}

export type Measured<T> = (T & ProbeMeta) | ProbeMeta;

export interface MeasuredProbe<T> {
  read(options?: { refresh?: boolean }): Promise<Measured<T>>;
  /** Drops the held value and orphans any run in flight (its result is discarded). */
  invalidate(): void;
}

export interface MeasuredProbeOptions {
  /** How long a finished measurement stays fresh. */
  ttlMs: number;
  /** How long a read waits for a run before answering "measuring". */
  waitMs?: number;
  now?: () => number;
}

interface Held<T> {
  value?: T;
  measuredAt?: number;
  error?: string;
  /** When the held value or error stops being fresh. */
  freshUntil: number;
}

export function createMeasuredProbe<T extends object>(
  run: () => Promise<T>,
  options: MeasuredProbeOptions,
): MeasuredProbe<T> {
  const now = options.now ?? Date.now;
  const waitMs = options.waitMs ?? 1_500;
  let held: Held<T> | null = null;
  let inFlight: Promise<void> | null = null;
  let generation = 0;

  const start = () => {
    const mine = generation;
    const finish = (next: Held<T>) => {
      // invalidate() bumped the generation: this result is for a world that no
      // longer exists, so it must not overwrite anything.
      if (mine !== generation) return;
      held = next;
      inFlight = null;
    };
    // `new Promise` so a run that throws before returning a promise is a
    // failed measurement like any other, not an exception out of read().
    inFlight = new Promise<T>((resolve) => resolve(run())).then(
      (value) => finish({ value, measuredAt: now(), freshUntil: now() + options.ttlMs }),
      (error: unknown) =>
        // Kept (and kept fresh) so a failing probe retries on the TTL, not on
        // every poll.
        finish({
          // Keep the last good figures visible next to the failure.
          ...(held?.value !== undefined ? { value: held.value, measuredAt: held.measuredAt } : {}),
          error: error instanceof Error ? error.message : "Measurement failed",
          freshUntil: now() + options.ttlMs,
        }),
    );
  };

  const snapshot = (): Measured<T> => {
    const measuring = inFlight !== null;
    const meta: ProbeMeta = {
      state: measuring ? "measuring" : held?.error ? "error" : held ? "ready" : "measuring",
      measuredAt: held?.measuredAt !== undefined ? new Date(held.measuredAt).toISOString() : null,
      ...(!measuring && held?.error ? { error: held.error } : {}),
    };
    return held?.value !== undefined ? { ...held.value, ...meta } : meta;
  };

  return {
    async read({ refresh = false } = {}) {
      const stale = !held || held.freshUntil <= now();
      if (!inFlight && (refresh || stale)) start();
      if (inFlight) {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          inFlight,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, waitMs);
            timer.unref();
          }),
        ]);
        clearTimeout(timer);
      }
      return snapshot();
    },
    invalidate() {
      generation += 1;
      held = null;
      inFlight = null;
    },
  };
}
