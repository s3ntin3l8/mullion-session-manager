import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";

const mockResult = vi.hoisted(() => vi.fn());
vi.mock("../../src/services/host-git.js", () => ({ resolveRepoRefResult: mockResult }));

import {
  MAX_UNRESOLVED_MS,
  pickRepoOwners,
  repoKey,
  resetRepoKeyCache,
  resolveRepoKeys,
  type ResolvedRepo,
} from "../../src/services/repo-key.js";

const app = { log: { warn: vi.fn(), debug: vi.fn() } } as unknown as FastifyInstance;
const entry = (key: string | null): ResolvedRepo => ({ ref: null, key });

describe("repoKey / pickRepoOwners", () => {
  it("lower-cases owner/repo", () => {
    expect(repoKey({ owner: "Acme", repo: "Widgets" })).toBe("acme/widgets");
  });

  it("the first (oldest) project on a repo owns it", () => {
    const resolved = new Map([
      [1, entry("a/b")],
      [2, entry("a/b")],
      [3, entry(null)],
      [4, entry("c/d")],
    ]);
    const owners = pickRepoOwners([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }], resolved);
    expect(owners.get("a/b")).toBe(1);
    expect(owners.get("c/d")).toBe(4);
  });

  it("defers a repo first seen after an unresolvable project (owner 0)", () => {
    const resolved = new Map([
      [2, entry("a/b")],
      [3, entry("c/d")],
    ]);
    const owners = pickRepoOwners([{ id: 1 }, { id: 2 }, { id: 3 }], resolved);
    expect(owners.get("a/b")).toBe(0);
    expect(owners.get("c/d")).toBe(0);
  });
});

describe("resolveRepoKeys", () => {
  beforeEach(() => {
    resetRepoKeyCache();
    mockResult.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("treats a legacy empty hostId as the local host", async () => {
    mockResult.mockResolvedValue({ ok: true, value: { owner: "A", repo: "B" } });
    const out = await resolveRepoKeys(app, [{ id: 1, cwd: "/x", hostId: "" }]);
    expect(mockResult).toHaveBeenCalledWith(app, { cwd: "/x", hostId: "local" });
    expect(out.get(1)?.key).toBe("a/b");
  });

  it("falls back to the remembered key (no ref) while the host is down", async () => {
    mockResult.mockResolvedValueOnce({ ok: true, value: { owner: "a", repo: "b" } });
    await resolveRepoKeys(app, [{ id: 1, cwd: "/x", hostId: "h" }]);
    mockResult.mockResolvedValueOnce({ ok: false });
    const out = await resolveRepoKeys(app, [{ id: 1, cwd: "/x", hostId: "h" }]);
    expect(out.get(1)).toEqual({ ref: null, key: "a/b" });
  });

  it("warns once per transition, repeats go to debug", async () => {
    mockResult.mockResolvedValue({ ok: false });
    vi.mocked(app.log.warn).mockClear();
    vi.mocked(app.log.debug).mockClear();
    const rows = [{ id: 1, cwd: "/x", hostId: "h" }];
    await resolveRepoKeys(app, rows);
    await resolveRepoKeys(app, rows);
    expect(app.log.warn).toHaveBeenCalledTimes(1); // newly unresolved
    expect(app.log.debug).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(MAX_UNRESOLVED_MS + 1);
    await resolveRepoKeys(app, rows);
    await resolveRepoKeys(app, rows);
    expect(app.log.warn).toHaveBeenCalledTimes(2); // newly expired
    expect(app.log.debug).toHaveBeenCalledTimes(2);
  });

  it("bounds the deferral: unresolved project is omitted, then treated as no repo (warn)", async () => {
    mockResult.mockResolvedValue({ ok: false });
    const rows = [{ id: 1, cwd: "/x", hostId: "h" }];
    expect((await resolveRepoKeys(app, rows)).has(1)).toBe(false);
    vi.advanceTimersByTime(MAX_UNRESOLVED_MS + 1);
    const out = await resolveRepoKeys(app, rows);
    expect(out.get(1)).toEqual({ ref: null, key: null, unresolved: true });
    expect(app.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 1 }),
      expect.stringContaining("too long"),
    );
    // it rejoins as soon as the host answers
    mockResult.mockResolvedValue({ ok: true, value: { owner: "a", repo: "b" } });
    expect((await resolveRepoKeys(app, rows)).get(1)?.key).toBe("a/b");
  });
});
