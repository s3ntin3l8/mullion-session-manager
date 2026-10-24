// Issue #29 — the Runway quota client.
//
// The contract these tests pin is the REAL one, verified against the
// installed Runway (runway-ai-usage-tracker):
//
//   GET {apiUrl}/api/v1/usage/limits   with   X-Admin-Key: <key>
//   -> { "limits": [LimitCard, ...] }
//
// and the fields that decide a quota question are the NUMERIC ones —
// `pct_used`, `used_value`, `limit_value`, `is_unlimited` — plus `stale`
// and `reset_at`. The DISPLAY fields (`remaining`, `reset`, `health`,
// `pace`) are strings and are never used for a decision.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { applySettingsPatch } from "../../src/services/settings.js";
import { setRunwayKey } from "../../src/services/runway-integration.js";
import {
  fetchRunwayLimits,
  isCardExhausted,
  isCardWindowReset,
  resetRunwayCache,
  toRunwayLimitCard,
  type RunwayLimitCard,
} from "../../src/services/runway-client.js";

/** A card shaped exactly like Runway's LimitCard, with the display fields
 * left at their defaults — which is the trap: `remaining` and `reset` are
 * STRINGS ("—"), so a client that treated them as numbers would read
 * NaN, and one that treated them as authoritative would read "unlimited". */
function runwayCard(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    service_name: "Claude",
    icon: "🤖",
    remaining: "—",
    unit: "units",
    reset: "—",
    health: "unknown",
    pace: "unknown",
    detail: "",
    used_value: null,
    limit_value: null,
    is_unlimited: false,
    unit_type: "generic",
    reset_at: null,
    data_source: "unknown",
    input_source: "unknown",
    updated_at: null,
    provider_id: "anthropic",
    window_type: "unknown",
    pct_used: null,
    stale: false,
    ...overrides,
  };
}

describe("toRunwayLimitCard", () => {
  it("reduces a card to the fields a decision can use", () => {
    const card = toRunwayLimitCard(
      runwayCard({
        provider_id: "anthropic",
        window_type: "weekly",
        pct_used: 87.5,
        used_value: 875,
        limit_value: 1000,
        reset_at: "2026-10-24T12:00:00Z",
      }),
    );
    expect(card).toEqual({
      providerId: "anthropic",
      windowType: "weekly",
      pctUsed: 87.5,
      usedValue: 875,
      limitValue: 1000,
      isUnlimited: false,
      resetAt: new Date("2026-10-24T12:00:00Z"),
      stale: false,
      errorType: null,
    });
  });

  it("ignores the DISPLAY fields, which are strings", () => {
    // `remaining` is "—" and `reset` is "—" — the very values that look
    // like "no limit" and "no reset" if they were read as facts.
    const card = toRunwayLimitCard(runwayCard({ remaining: "—", reset: "—" }))!;
    expect(card.pctUsed).toBeNull();
    expect(card.usedValue).toBeNull();
    expect(card.limitValue).toBeNull();
    expect(card.resetAt).toBeNull();
  });

  it("returns null for a card with no provider id", () => {
    // Nothing to map it to, and an unmapped card must never quarantine
    // anything.
    expect(toRunwayLimitCard(runwayCard({ provider_id: null }))).toBeNull();
    expect(toRunwayLimitCard(runwayCard({ provider_id: "  " }))).toBeNull();
    expect(toRunwayLimitCard(null)).toBeNull();
    expect(toRunwayLimitCard("nonsense")).toBeNull();
  });

  it("treats a malformed reset_at as absent", () => {
    const card = toRunwayLimitCard(runwayCard({ reset_at: "not a date" }))!;
    expect(card.resetAt).toBeNull();
  });
});

describe("isCardExhausted", () => {
  const card = (overrides: Partial<RunwayLimitCard>): RunwayLimitCard => ({
    providerId: "anthropic",
    windowType: "weekly",
    pctUsed: null,
    usedValue: null,
    limitValue: null,
    isUnlimited: false,
    resetAt: null,
    stale: false,
    errorType: null,
    ...overrides,
  });

  it("is exhausted at 100% used", () => {
    expect(isCardExhausted(card({ pctUsed: 100 }))).toBe(true);
    expect(isCardExhausted(card({ pctUsed: 100.1 }))).toBe(true);
    expect(isCardExhausted(card({ pctUsed: 99.9 }))).toBe(false);
  });

  it("falls back to used vs limit when there is no percentage", () => {
    expect(isCardExhausted(card({ usedValue: 1000, limitValue: 1000 }))).toBe(true);
    expect(isCardExhausted(card({ usedValue: 999, limitValue: 1000 }))).toBe(false);
    // A zero limit is not a quota of zero — it means "unknown".
    expect(isCardExhausted(card({ usedValue: 5, limitValue: 0 }))).toBe(false);
  });

  it("is NEVER exhausted for an unlimited plan", () => {
    expect(isCardExhausted(card({ pctUsed: 100, isUnlimited: true }))).toBe(false);
  });

  it("is NEVER exhausted for a STALE card", () => {
    // Runway sets `stale` when its collection is failing: the data is real
    // but old. Quarantining on it would stop work for a provider that may
    // well have quota again.
    expect(isCardExhausted(card({ pctUsed: 100, stale: true }))).toBe(false);
  });

  it("is NOT exhausted when it has no usable numbers", () => {
    // A card that cannot say anything says nothing — it must not be read
    // as "exhausted", and equally not as "fine".
    expect(isCardExhausted(card({}))).toBe(false);
  });
});

describe("isCardWindowReset", () => {
  const card = (resetAt: Date | null): RunwayLimitCard => ({
    providerId: "anthropic",
    windowType: "weekly",
    pctUsed: 100,
    usedValue: null,
    limitValue: null,
    isUnlimited: false,
    resetAt,
    stale: false,
    errorType: null,
  });

  it("is true once the window's reset time has passed", () => {
    const past = new Date(Date.now() - 60_000);
    expect(isCardWindowReset(card(past))).toBe(true);
  });

  it("is false while the window is still running", () => {
    const future = new Date(Date.now() + 60_000);
    expect(isCardWindowReset(card(future))).toBe(false);
  });

  it("is false without a reset time — such a card is refreshed by the next poll", () => {
    expect(isCardWindowReset(card(null))).toBe(false);
  });
});

describe("fetchRunwayLimits", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    resetRunwayCache();
    app = await buildApp();
    await app.ready();
  });

  afterEach(async () => {
    // The settings live in the database, which outlives a single test —
    // so a test that turns polling off has to turn it back on, or the
    // next one inherits "never poll".
    applySettingsPatch(app, { runway: { pollSeconds: 60 } });
    await app.close();
    resetRunwayCache();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Puts the feature into the "configured" state the way an operator
   * would: a URL in the settings and a key in the integrations table. */
  function configure(apiUrl = "https://runway.example"): void {
    applySettingsPatch(app, { runway: { apiUrl } });
    setRunwayKey(app, "runway-admin-key"); // pragma: allowlist secret
  }

  it("returns null when the feature is off (no apiUrl) and never calls out", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const limits = await fetchRunwayLimits(app);
    expect(limits).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null when no key is configured", async () => {
    applySettingsPatch(app, { runway: { apiUrl: "https://runway.example" } });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const limits = await fetchRunwayLimits(app);
    expect(limits).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null when Runway is unreachable — never 'quota exhausted'", async () => {
    configure();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const limits = await fetchRunwayLimits(app);
    expect(limits).toBeNull();
  });

  it("returns null on a non-2xx response", async () => {
    configure();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({}) }),
    );
    const limits = await fetchRunwayLimits(app);
    expect(limits).toBeNull();
  });

  it("returns null for a body that is not the expected shape", async () => {
    configure();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ limits: "not a list" }) }),
    );
    const limits = await fetchRunwayLimits(app);
    expect(limits).toBeNull();
  });

  it("fetches the documented path with the admin key, and maps the cards", async () => {
    configure();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        limits: [
          runwayCard({
            provider_id: "anthropic",
            window_type: "weekly",
            pct_used: 87.5,
            reset_at: "2026-10-24T12:00:00Z",
          }),
          runwayCard({ provider_id: "opencode", pct_used: 12 }),
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const limits = await fetchRunwayLimits(app);
    expect(limits).not.toBeNull();
    expect(limits!.cards).toHaveLength(2);
    expect(limits!.cards[0].providerId).toBe("anthropic");
    expect(limits!.cards[0].pctUsed).toBe(87.5);

    // The exact path and the auth header the installed Runway expects.
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://runway.example/api/v1/usage/limits");
    expect((init.headers as Record<string, string>)["X-Admin-Key"]).toBe("runway-admin-key");
  });

  it("never calls out when polling is off, and serves the last snapshot instead", async () => {
    // `pollSeconds: 0` means "never poll" in the sweep, so the READ path has
    // to mean it too: the badge route must not reach Runway with the admin
    // key on every poll of the UI. `Math.max(1, pollSeconds)` would have
    // turned "never poll" into a one-second cache and a fetch per read.
    configure();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ limits: [runwayCard({ provider_id: "anthropic", pct_used: 42 })] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    // A read while polling is ON populates the cache.
    const first = await fetchRunwayLimits(app);
    expect(first).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Polling OFF: the last snapshot is the answer, and nothing is fetched.
    applySettingsPatch(app, { runway: { pollSeconds: 0 } });
    const second = await fetchRunwayLimits(app);
    expect(second).not.toBeNull();
    expect(second!.cards[0].pctUsed).toBe(42);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("has no snapshot to serve when polling is off from the start", async () => {
    // Nothing was ever fetched, so there is no last reading: the answer is
    // null ("no quota information"), never a fetch.
    configure();
    applySettingsPatch(app, { runway: { pollSeconds: 0 } });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const limits = await fetchRunwayLimits(app);
    expect(limits).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drops a card with no provider id rather than mapping it to something", async () => {
    configure();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ limits: [runwayCard({ provider_id: null })] }),
      }),
    );
    const limits = await fetchRunwayLimits(app);
    expect(limits!.cards).toHaveLength(0);
  });
});
