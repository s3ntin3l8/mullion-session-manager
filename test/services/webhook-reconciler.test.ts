import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";

const mockGetToken = vi.hoisted(() => vi.fn());
const mockGetWebhookSecret = vi.hoisted(() => vi.fn());
const mockRegisterProjectWebhook = vi.hoisted(() => vi.fn());
const mockBuildWebhookUrl = vi.hoisted(() => vi.fn());

vi.mock("../../src/services/github-integration.js", () => ({
  GITHUB_PROVIDER: "github",
  getToken: mockGetToken,
}));

vi.mock("../../src/services/github-webhook.js", () => ({
  buildWebhookUrl: mockBuildWebhookUrl,
  getWebhookSecret: mockGetWebhookSecret,
  registerProjectWebhook: mockRegisterProjectWebhook,
}));

import { startWebhookReconciler } from "../../src/services/webhook-reconciler.js";

interface MockOpts {
  webhookBaseUrl?: string;
  webhookEnabled?: boolean;
  registeredProjectIds?: number[];
  projectRows?: { id: number; cwd: string; hostId: string }[];
}

function mockApp(opts: MockOpts = {}): FastifyInstance {
  const webhookEnabled = opts.webhookEnabled ?? true;
  const registeredProjectIds = opts.registeredProjectIds ?? [];
  const projectRows = opts.projectRows ?? [];

  return {
    db: {
      select: (projection?: unknown) => ({
        from: () => ({
          where: () => ({
            get: () => ({ webhookEnabled }),
            // Told apart by projection shape: {webhookEnabled}-style query is
            // handled by .get() above; the two remaining .all() consumers
            // here are the registered-ids lookup (returns every registered
            // id verbatim) and the projects lookup (emulates the real
            // notInArray(...) exclusion — a hand mock can't introspect
            // drizzle's opaque where-clause object, so the same filtering
            // logic is applied here directly, in JS, against the same
            // `registeredProjectIds` the query would otherwise exclude by).
            all: () =>
              projection && "projectId" in (projection as object)
                ? registeredProjectIds.map((id) => ({ projectId: id }))
                : projectRows.filter((row) => !registeredProjectIds.includes(row.id)),
          }),
        }),
      }),
    },
    log: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    config: {
      MULLION_WEBHOOK_BASE_URL: opts.webhookBaseUrl ?? "https://hooks.example.com",
    },
  } as unknown as FastifyInstance;
}

const INITIAL_DELAY_MS = 30_000;

describe("startWebhookReconciler (#490b)", () => {
  beforeEach(() => {
    mockGetToken.mockReset();
    mockGetToken.mockReturnValue("ghp_token");
    mockGetWebhookSecret.mockReset();
    mockGetWebhookSecret.mockReturnValue("wh_secret");
    mockRegisterProjectWebhook.mockReset();
    mockRegisterProjectWebhook.mockResolvedValue("registered");
    mockBuildWebhookUrl.mockReset();
    mockBuildWebhookUrl.mockReturnValue("https://hooks.example.com/api/webhooks/github");
  });

  it("does nothing when MULLION_WEBHOOK_BASE_URL is unset", async () => {
    const app = mockApp({ webhookBaseUrl: "" });
    vi.useFakeTimers();
    const cleanup = startWebhookReconciler(app);

    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);

    expect(mockRegisterProjectWebhook).not.toHaveBeenCalled();
    cleanup();
    vi.useRealTimers();
  });

  it("does nothing when webhooks aren't enabled", async () => {
    const app = mockApp({
      webhookEnabled: false,
      projectRows: [{ id: 1, cwd: "/tmp/one", hostId: "local" }],
    });
    vi.useFakeTimers();
    const cleanup = startWebhookReconciler(app);

    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);

    expect(mockRegisterProjectWebhook).not.toHaveBeenCalled();
    cleanup();
    vi.useRealTimers();
  });

  it("does nothing when no token or no secret is available", async () => {
    mockGetToken.mockReturnValue(null);
    const app = mockApp({ projectRows: [{ id: 1, cwd: "/tmp/one", hostId: "local" }] });
    vi.useFakeTimers();
    const cleanup = startWebhookReconciler(app);

    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);

    expect(mockRegisterProjectWebhook).not.toHaveBeenCalled();
    cleanup();
    vi.useRealTimers();
  });

  it("registers only projects missing from webhook_registrations, skipping already-registered ones", async () => {
    const app = mockApp({
      projectRows: [
        { id: 1, cwd: "/tmp/one", hostId: "local" },
        { id: 2, cwd: "/tmp/two", hostId: "local" },
      ],
      registeredProjectIds: [1],
    });
    vi.useFakeTimers();
    const cleanup = startWebhookReconciler(app);

    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);

    expect(mockRegisterProjectWebhook).toHaveBeenCalledTimes(1);
    expect(mockRegisterProjectWebhook).toHaveBeenCalledWith(
      app,
      { id: 2, cwd: "/tmp/two", hostId: "local" },
      "ghp_token",
      "https://hooks.example.com/api/webhooks/github",
      "wh_secret",
    );
    cleanup();
    vi.useRealTimers();
  });

  it("does nothing (no GitHub calls) when every project is already registered", async () => {
    const app = mockApp({
      projectRows: [{ id: 1, cwd: "/tmp/one", hostId: "local" }],
      registeredProjectIds: [1],
    });
    vi.useFakeTimers();
    const cleanup = startWebhookReconciler(app);

    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);

    expect(mockRegisterProjectWebhook).not.toHaveBeenCalled();
    cleanup();
    vi.useRealTimers();
  });

  it("runs again on the periodic interval after the initial pass", async () => {
    const app = mockApp({ projectRows: [{ id: 1, cwd: "/tmp/one", hostId: "local" }] });
    vi.useFakeTimers();
    const cleanup = startWebhookReconciler(app);

    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(mockRegisterProjectWebhook).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(mockRegisterProjectWebhook).toHaveBeenCalledTimes(2);

    cleanup();
    vi.useRealTimers();
  });

  it("isolates a rejected reconcile pass — logs a warning rather than throwing", async () => {
    mockRegisterProjectWebhook.mockRejectedValueOnce(new Error("boom"));
    const app = mockApp({ projectRows: [{ id: 1, cwd: "/tmp/one", hostId: "local" }] });
    vi.useFakeTimers();
    const cleanup = startWebhookReconciler(app);

    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);

    expect(app.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining("reconcile pass failed"),
    );
    cleanup();
    vi.useRealTimers();
  });

  it("cleanup prevents further passes from firing", async () => {
    const app = mockApp({ projectRows: [{ id: 1, cwd: "/tmp/one", hostId: "local" }] });
    vi.useFakeTimers();
    const cleanup = startWebhookReconciler(app);
    cleanup();

    await vi.advanceTimersByTimeAsync(7 * 60 * 60 * 1000);

    expect(mockRegisterProjectWebhook).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
