// Issue #1734 — the server-side sweep that turns a codex rollout's recorded
// rate limit into the `stop_failure` message the rest of Mullion already
// understands.
//
// The sweep is the only trigger available for codex: codex fires no hook at
// all for a turn that failed, so nothing else in the backend can notice.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestApp } from "../helpers/app.js";
import { detectCodexRateLimits } from "../../src/services/codex-rate-limit.js";
import type { StopFailureHookMessage } from "../../src/services/hook-protocol.js";

function rolloutWithError(error: Record<string, unknown>): string {
  return `${JSON.stringify({
    timestamp: "2026-10-24T08:45:21.000Z",
    ordinal: 42,
    type: "event_msg",
    payload: {
      type: "task_complete",
      turn_id: "turn-failed-1",
      last_agent_message: null,
      error,
      started_at: 1792791556,
      completed_at: 1792791556,
      duration_ms: 130,
    },
  })}\n`;
}

const RATE_LIMIT_ERROR = {
  message: "exceeded retry limit, last status: 429 Too Many Requests",
  codex_error_info: { response_too_many_failed_attempts: { http_status_code: 429 } },
};

const SERVER_ERROR = {
  message: "internal server error",
  codex_error_info: { internal_server_error: { http_status_code: 500 } },
};

// The sweep only reads rollouts inside codex's OWN sessions directory —
// the path arrives over the untrusted hook channel (see codex-rollout.mjs's
// header) — so the fixtures live there, under a scratch CODEX_HOME.
const originalCodexHome = process.env.CODEX_HOME;

function writeRollout(contents: string): string {
  const dir = join(process.env.CODEX_HOME!, "sessions", "2026", "10", "24");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "rollout-2026-10-24T08-45-21-abc.jsonl");
  writeFileSync(path, contents);
  return path;
}

describe("detectCodexRateLimits (issue #1734)", () => {
  beforeEach(() => {
    process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), "codex-sweep-home-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
  });

  it("emits a stop_failure with errorType rate_limit for a rate-limited codex turn", async () => {
    const app = await buildTestApp();
    await app.ready();
    const session = app.pty.getOrCreate({
      id: "17341",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    const path = writeRollout(rolloutWithError(RATE_LIMIT_ERROR));
    app.pty.setCodexTranscriptPath("17341", path);

    const emitSpy = vi.spyOn(app.pty, "emitHookEvent");
    await detectCodexRateLimits(app);

    expect(emitSpy).toHaveBeenCalledTimes(1);
    // The emitted message IS the stop_failure shape (asserted right below) —
    // narrow the spy's call tuple to it, so `errorType`/`error` are typed
    // instead of the old blanket `Record<string, unknown>`.
    const [sessionId, message] = emitSpy.mock.calls[0] as [string, StopFailureHookMessage];
    expect(sessionId).toBe("17341");
    expect(message.kind).toBe("stop_failure");
    // The exact string task-rate-limit-grace.ts keys off.
    expect(message.errorType).toBe("rate_limit");
    expect(String(message.error)).toContain("429");
    expect(session.id).toBe("17341");
    expect(sessionId).toBe("17341");
  });

  it("emits nothing for a codex turn that failed for another reason", async () => {
    // A server error is not a quota failure. Reporting it as one would park
    // the task in a rate-limit grace window that will never clear.
    const app = await buildTestApp();
    await app.ready();
    app.pty.getOrCreate({ id: "17342", cwd: "/tmp", command: "bash", cols: 80, rows: 24 });
    const path = writeRollout(rolloutWithError(SERVER_ERROR));
    app.pty.setCodexTranscriptPath("17342", path);

    const emitSpy = vi.spyOn(app.pty, "emitHookEvent");
    await detectCodexRateLimits(app);
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("emits nothing for a session with no codex rollout path", async () => {
    const app = await buildTestApp();
    await app.ready();
    app.pty.getOrCreate({ id: "17343", cwd: "/tmp", command: "bash", cols: 80, rows: 24 });

    const emitSpy = vi.spyOn(app.pty, "emitHookEvent");
    await detectCodexRateLimits(app);
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("emits nothing for a rate-limited turn with NO usable identity", async () => {
    // With no `turn_id`, no `ordinal` and no `completed_at`, there is no way
    // to tell "the same failed turn" from "a new one". Reporting it anyway
    // would re-emit on every reconcile tick, and each re-emit restarts the
    // rate-limit grace window — so the window would never expire.
    const app = await buildTestApp();
    await app.ready();
    app.pty.getOrCreate({ id: "17347", cwd: "/tmp", command: "bash", cols: 80, rows: 24 });
    const line = JSON.stringify({
      type: "event_msg",
      payload: {
        type: "task_complete",
        error: {
          message: "429 Too Many Requests",
          codex_error_info: { response_too_many_failed_attempts: { http_status_code: 429 } },
        },
      },
    });
    const path = writeRollout(`${line}\n`);
    app.pty.setCodexTranscriptPath("17347", path);

    const emitSpy = vi.spyOn(app.pty, "emitHookEvent");
    await detectCodexRateLimits(app);
    await detectCodexRateLimits(app);
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("does NOT latch hooksProven — a synthesized message is not a delivered hook", async () => {
    // The sweep's message is Mullion's own reading of a rollout file, not
    // evidence that the session's hook pipeline fires. Latching `hooksProven`
    // from it would let a session read as hook-proven with no hook ever
    // delivered to it — the one signal codex's `/hooks` trust gate would
    // otherwise keep honest.
    const app = await buildTestApp();
    await app.ready();
    app.pty.getOrCreate({ id: "17348", cwd: "/tmp", command: "bash", cols: 80, rows: 24 });
    const path = writeRollout(rolloutWithError(RATE_LIMIT_ERROR));
    app.pty.setCodexTranscriptPath("17348", path);

    await detectCodexRateLimits(app);

    // The session's own hooks-proven latch must still read false.
    expect(app.pty.areHooksProven("17348")).toBe(false);
  });

  it("reports the SAME failed turn only once", async () => {
    // Codex's rollout keeps saying the last turn failed until the next turn
    // completes, so without this latch every tick would re-report the same
    // failure and restart the rate-limit grace window forever.
    const app = await buildTestApp();
    await app.ready();
    app.pty.getOrCreate({ id: "17344", cwd: "/tmp", command: "bash", cols: 80, rows: 24 });
    const path = writeRollout(rolloutWithError(RATE_LIMIT_ERROR));
    app.pty.setCodexTranscriptPath("17344", path);

    const emitSpy = vi.spyOn(app.pty, "emitHookEvent");
    await detectCodexRateLimits(app);
    await detectCodexRateLimits(app);
    await detectCodexRateLimits(app);
    expect(emitSpy).toHaveBeenCalledTimes(1);
  });

  it("reports a NEW failed turn even after an earlier one was reported", async () => {
    const app = await buildTestApp();
    await app.ready();
    app.pty.getOrCreate({ id: "17345", cwd: "/tmp", command: "bash", cols: 80, rows: 24 });
    const path = writeRollout(rolloutWithError(RATE_LIMIT_ERROR));
    app.pty.setCodexTranscriptPath("17345", path);

    const emitSpy = vi.spyOn(app.pty, "emitHookEvent");
    await detectCodexRateLimits(app);
    expect(emitSpy).toHaveBeenCalledTimes(1);

    // The next turn fails too, with its own turn id.
    writeFileSync(
      path,
      rolloutWithError(RATE_LIMIT_ERROR).replace("turn-failed-1", "turn-failed-2"),
    );
    await detectCodexRateLimits(app);
    expect(emitSpy).toHaveBeenCalledTimes(2);
  });

  it("does not throw when the rollout file has gone missing", async () => {
    const app = await buildTestApp();
    await app.ready();
    app.pty.getOrCreate({ id: "17346", cwd: "/tmp", command: "bash", cols: 80, rows: 24 });
    app.pty.setCodexTranscriptPath("17346", join(tmpdir(), "gone-1734.jsonl"));

    const emitSpy = vi.spyOn(app.pty, "emitHookEvent");
    await expect(detectCodexRateLimits(app)).resolves.toBeUndefined();
    expect(emitSpy).not.toHaveBeenCalled();
  });
});
