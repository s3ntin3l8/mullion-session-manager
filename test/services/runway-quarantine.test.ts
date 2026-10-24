// Issue #29 — the per-agent quota quarantine, and the pre-claim gate it
// guards.
//
// The rule the whole feature rests on: a task whose agent's provider is out
// of quota must not be CLAIMED, because claiming it takes a concurrency
// slot it cannot use and then fails later for a reason the operator cannot
// see. And the rule that keeps it safe: an agent with NO mapping is never
// quarantined — absence of data must not stop work.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import { eq } from "drizzle-orm";

// Same fakes as test/services/task-claim.test.ts — the claim path spawns a
// real session, faked so this file exercises the service directly without a
// real systemd --user session in CI.
vi.mock("node-pty", () => ({
  spawn: vi.fn(() => ({
    onData: () => ({ dispose: () => {} }),
    onExit: () => ({ dispose: () => {} }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: vi.fn((command: string, args?: readonly string[], options?: object) => {
      if (command === "git") return actual.spawn(command, args, options);
      const ee = new EventEmitter() as EventEmitter & { stdout?: EventEmitter };
      setImmediate(() => {
        ee.emit("exit", 0);
        ee.stdout = new EventEmitter();
        setImmediate(() => ee.emit("close", 0));
      });
      return ee;
    }),
  };
});

vi.mock("../../src/services/task-github-sync.js", () => ({
  syncTaskTransition: vi.fn().mockResolvedValue(undefined),
}));

import { buildApp } from "../../src/app.js";
import { tasks } from "../../src/db/schema.js";
import { applySettingsPatch } from "../../src/services/settings.js";
import { enqueueTask } from "../../src/services/task-claim.js";
import {
  agentForProvider,
  agentQuarantineInfo,
  applyRunwaySnapshot,
  isAgentQuarantined,
  pollRunwayQuota,
  resetRunwayQuarantine,
} from "../../src/services/runway-quarantine.js";
import { setRunwayKey } from "../../src/services/runway-integration.js";
import { resetRunwayCache } from "../../src/services/runway-client.js";

/** A quota snapshot in the shape the client produces. */
function snapshot(
  cards: Array<{
    providerId: string;
    pctUsed?: number | null;
    resetAt?: string | null;
    stale?: boolean;
    isUnlimited?: boolean;
  }>,
) {
  return {
    fetchedAt: new Date(),
    cards: cards.map((card) => ({
      providerId: card.providerId,
      windowType: "weekly",
      pctUsed: card.pctUsed ?? null,
      usedValue: null,
      limitValue: null,
      isUnlimited: card.isUnlimited ?? false,
      resetAt: card.resetAt ? new Date(card.resetAt) : null,
      stale: card.stale ?? false,
      errorType: null,
    })),
  };
}

describe("the Runway quota quarantine (issue #29)", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    resetRunwayQuarantine();
    resetRunwayCache();
    app = await buildApp();
    await app.ready();
    applySettingsPatch(app, {
      runway: { providerMap: { anthropic: "claude", opencode: "opencode" } },
    });
  });

  afterEach(async () => {
    await app.close();
    resetRunwayQuarantine();
    resetRunwayCache();
    vi.restoreAllMocks();
  });

  it("quarantines an agent whose mapped provider is out of quota", () => {
    applyRunwaySnapshot(app, snapshot([{ providerId: "anthropic", pctUsed: 100 }]));
    expect(isAgentQuarantined(app, "claude")).toBe(true);
    expect(isAgentQuarantined(app, "opencode")).toBe(false);
  });

  it("NEVER quarantines an agent that is not in the provider map", () => {
    // The most important negative case: absence of data must not stop work.
    // Runway reports providers Mullion has no agent for (gemini, github,
    // ollama, …), and Mullion has agents Runway does not report (agy) —
    // neither may ever be quarantined.
    applyRunwaySnapshot(app, snapshot([{ providerId: "anthropic", pctUsed: 100 }]));
    expect(isAgentQuarantined(app, "agy")).toBe(false);
    expect(isAgentQuarantined(app, "codex")).toBe(false);
    expect(isAgentQuarantined(app, "gemini")).toBe(false);
  });

  it("does not quarantine a provider whose card is stale", () => {
    // Runway sets `stale` when its collection is failing: the data is real
    // but old, and quarantining on it would stop work for a provider that
    // may well have quota again.
    applyRunwaySnapshot(app, snapshot([{ providerId: "anthropic", pctUsed: 100, stale: true }]));
    expect(isAgentQuarantined(app, "claude")).toBe(false);
  });

  it("does not quarantine an unlimited plan", () => {
    applyRunwaySnapshot(
      app,
      snapshot([{ providerId: "anthropic", pctUsed: 100, isUnlimited: true }]),
    );
    expect(isAgentQuarantined(app, "claude")).toBe(false);
  });

  it("lifts the quarantine when a fresh snapshot says the provider is fine", () => {
    applyRunwaySnapshot(app, snapshot([{ providerId: "anthropic", pctUsed: 100 }]));
    expect(isAgentQuarantined(app, "claude")).toBe(true);
    applyRunwaySnapshot(app, snapshot([{ providerId: "anthropic", pctUsed: 20 }]));
    expect(isAgentQuarantined(app, "claude")).toBe(false);
  });

  it("lifts the quarantine when the provider's window has reset", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    applyRunwaySnapshot(app, snapshot([{ providerId: "anthropic", pctUsed: 100, resetAt: past }]));
    expect(isAgentQuarantined(app, "claude")).toBe(false);
  });

  it("releases an agent the snapshot no longer mentions", () => {
    // Runway stopped reporting the provider: an agent that is not being
    // watched must not stay quarantined on the strength of an old reading.
    applyRunwaySnapshot(app, snapshot([{ providerId: "anthropic", pctUsed: 100 }]));
    expect(isAgentQuarantined(app, "claude")).toBe(true);
    applyRunwaySnapshot(app, snapshot([{ providerId: "opencode", pctUsed: 10 }]));
    expect(isAgentQuarantined(app, "claude")).toBe(false);
  });

  it("lifts the quarantine when the LAST of a provider's windows resets", () => {
    // Keeping the EARLIEST reset would lift the quarantine while a later
    // window is still exhausted — and auto-claim would then proceed onto a
    // provider with nothing left.
    const soon = new Date(Date.now() + 60_000).toISOString();
    const later = new Date(Date.now() + 600_000).toISOString();
    applyRunwaySnapshot(
      app,
      snapshot([
        { providerId: "anthropic", pctUsed: 100, resetAt: soon },
        { providerId: "anthropic", pctUsed: 100, resetAt: later },
      ]),
    );
    expect(isAgentQuarantined(app, "claude")).toBe(true);
    const info = agentQuarantineInfo(app, "claude");
    // The LATEST window's reset, not the earliest.
    expect(info.resetAt?.getTime()).toBe(new Date(later).getTime());
  });

  it("quarantines when ANY of a provider's cards is exhausted", () => {
    // Runway can report several cards per provider (per model, per window).
    // A provider is out of quota when ANY of them is — Mullion cannot use
    // the provider at all, so a sibling card with room left does not help.
    applyRunwaySnapshot(
      app,
      snapshot([
        { providerId: "anthropic", pctUsed: 10 },
        { providerId: "anthropic", pctUsed: 100 },
      ]),
    );
    expect(isAgentQuarantined(app, "claude")).toBe(true);
  });

  it("maps a provider to its agent through the settings map", () => {
    expect(agentForProvider(app, "anthropic")).toBe("claude");
    expect(agentForProvider(app, "opencode")).toBe("opencode");
    expect(agentForProvider(app, "gemini")).toBeNull();
  });

  describe("the poll", () => {
    it("releases every quarantine when the integration is UNCONFIGURED", async () => {
      // Nothing left to refresh the reading with, and nothing that could
      // ever lift it — holding the quarantine would strand every task on
      // that agent until a restart.
      applyRunwaySnapshot(app, snapshot([{ providerId: "anthropic", pctUsed: 100 }]));
      expect(isAgentQuarantined(app, "claude")).toBe(true);

      // The URL is cleared (or the key deleted) — the feature is off.
      applySettingsPatch(app, { runway: { apiUrl: "" } });
      const result = await pollRunwayQuota(app);
      expect(result.quarantinedAgents).toEqual([]);
      expect(isAgentQuarantined(app, "claude")).toBe(false);
    });

    it("keeps the previous reading when a CONFIGURED Runway is unreachable", async () => {
      // A transient outage is not the operator turning the feature off: the
      // reading stands until a later poll succeeds.
      applySettingsPatch(app, { runway: { apiUrl: "https://runway.example" } });
      setRunwayKey(app, "runway-admin"); // pragma: allowlist secret
      applyRunwaySnapshot(app, snapshot([{ providerId: "anthropic", pctUsed: 100 }]));
      expect(isAgentQuarantined(app, "claude")).toBe(true);

      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
      const result = await pollRunwayQuota(app);
      expect(result.quarantinedAgents).toEqual(["claude"]);
      expect(isAgentQuarantined(app, "claude")).toBe(true);
      vi.unstubAllGlobals();
    });

    it("honours the operator's poll interval instead of fetching on every tick", async () => {
      applySettingsPatch(app, {
        runway: { apiUrl: "https://runway.example", pollSeconds: 3600 },
      });
      setRunwayKey(app, "runway-admin"); // pragma: allowlist secret
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ limits: [] }),
      });
      vi.stubGlobal("fetch", fetchMock);

      await pollRunwayQuota(app);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // A second tick inside the interval fetches nothing.
      await pollRunwayQuota(app);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      vi.unstubAllGlobals();
    });

    it("never polls when the interval is 0", async () => {
      applySettingsPatch(app, {
        runway: { apiUrl: "https://runway.example", pollSeconds: 0 },
      });
      setRunwayKey(app, "runway-admin"); // pragma: allowlist secret
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await pollRunwayQuota(app);
      expect(fetchMock).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });
  });

  describe("the pre-claim gate", () => {
    function insertReadyTask(projectId: number, issueNumber: number) {
      const [row] = app.db
        .insert(tasks)
        .values({ projectId, issueNumber, title: "t", body: "some details", status: "ready" })
        .returning()
        .all();
      return row;
    }

    async function createProject(cwd: string): Promise<number> {
      const res = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "runway-p", cwd },
      });
      return res.json().id as number;
    }

    it("refuses an AUTO-claim for a quarantined agent, leaving the task untouched", async () => {
      const cwd = mkdtempSync(path.join(os.tmpdir(), "runway-claim-"));
      const projectId = await createProject(cwd);
      await app.inject({
        method: "PATCH",
        url: `/api/projects/${projectId}`,
        payload: { defaultAgent: "claude" },
      });
      const task = insertReadyTask(projectId, 71);
      applyRunwaySnapshot(app, snapshot([{ providerId: "anthropic", pctUsed: 100 }]));

      const outcome = await enqueueTask(app, task.id, { auto: true });

      expect(outcome).toMatchObject({ ok: false, reason: "agent-quarantined" });
      // No reservation: the task takes NO concurrency slot.
      const [row] = app.db.select().from(tasks).where(eq(tasks.id, task.id)).all();
      expect(row.status).toBe("ready");
      expect(row.sessionId).toBeNull();
    });

    it("still claims MANUALLY for a quarantined agent", async () => {
      // A human is present, they may know the quota recovered, and refusing
      // a deliberate act would be worse than letting it fail.
      const cwd = mkdtempSync(path.join(os.tmpdir(), "runway-claim-"));
      const projectId = await createProject(cwd);
      await app.inject({
        method: "PATCH",
        url: `/api/projects/${projectId}`,
        payload: { defaultAgent: "claude" },
      });
      const task = insertReadyTask(projectId, 72);
      applyRunwaySnapshot(app, snapshot([{ providerId: "anthropic", pctUsed: 100 }]));

      const outcome = await enqueueTask(app, task.id, { auto: false });

      expect(outcome.ok).toBe(true);
      const [row] = app.db.select().from(tasks).where(eq(tasks.id, task.id)).all();
      expect(row.status).toBe("claimed");
    });

    it("claims normally for an agent that is not quarantined", async () => {
      const cwd = mkdtempSync(path.join(os.tmpdir(), "runway-claim-"));
      const projectId = await createProject(cwd);
      await app.inject({
        method: "PATCH",
        url: `/api/projects/${projectId}`,
        payload: { defaultAgent: "claude" },
      });
      const task = insertReadyTask(projectId, 73);

      const outcome = await enqueueTask(app, task.id, { auto: true });

      expect(outcome.ok).toBe(true);
      const [row] = app.db.select().from(tasks).where(eq(tasks.id, task.id)).all();
      expect(row.status).toBe("claimed");
    });
  });
});
