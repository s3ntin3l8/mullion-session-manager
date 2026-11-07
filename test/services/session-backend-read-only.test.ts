import type { FastifyInstance } from "fastify";
import type * as RemoteHostClientModule from "../../src/services/remote-host-client.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const real = vi.hoisted(() => ({
  client: undefined as unknown,
  make: undefined as undefined | (() => unknown),
}));

vi.mock("../../src/services/remote-host-client.js", async (importActual) => {
  const actual = await importActual<typeof RemoteHostClientModule>();
  // A fresh client per test: some reads are cached on the client, and a cache
  // hit would send no request and prove nothing.
  real.make = () =>
    new actual.RemoteHostClient({
      hostId: "mac-1",
      baseUrl: "http://example.invalid:1234",
      token: "tok",
    });
  return { ...actual, getRemoteHostClient: () => real.client };
});

import { resolveBackend } from "../../src/services/session-backend.js";
import { isIdempotentRequest } from "../../src/services/remote-host-errors.js";
import { READ_ONLY } from "../helpers/remote-backend-classification.js";

// #2703 — READ_ONLY in the classification test is only a claim. Here each
// listed method is driven over a REAL RemoteHostClient (only `fetch` is
// stubbed) and every request it puts on the wire must be one the client treats
// as idempotent: a mid-request close then reads as plain unreachable, not as an
// unknown outcome. A method that does write (or POSTs a path missing from the
// idempotent list) fails here instead of passing as "read-only".
const backend = () => resolveBackend({ db: {} } as unknown as FastifyInstance, "mac-1") as never;

type Wire = { method: string; path: string; body: string | undefined };
const READ_ONLY_CALLS: Record<
  string,
  (b: Record<string, (...a: never[]) => Promise<unknown>>) => Promise<unknown>
> = {
  liveStatus: (b) => b.liveStatus(["1"] as never, 1000 as never),
  liveness: (b) => b.liveness(["1"] as never),
  compareWorktreePaths: (b) =>
    b.compareWorktreePaths("/w" as never, [{ id: "1", cwd: "/x" }] as never),
  getScrollback: (b) => b.getScrollback("1" as never),
  getRenderedScrollback: (b) => b.getRenderedScrollback("1" as never),
  getTranscript: (b) => b.getTranscript("1" as never, {} as never),
  listSessionProcesses: (b) => b.listSessionProcesses("1" as never),
  waitOutput: (b) =>
    b.waitOutput(
      "1" as never,
      {
        match: "x",
        regex: false,
        timeoutMs: 1000,
        signal: new AbortController().signal,
        alive: () => true,
      } as never,
    ),
  listTaskWorktreeDirs: (b) => b.listTaskWorktreeDirs("/x" as never),
  readTaskReviewFindings: (b) => b.readTaskReviewFindings(1 as never, 1 as never),
  resolveSessionsDir: (b) => b.resolveSessionsDir(),
  readTaskCommitTitle: (b) => b.readTaskCommitTitle(1 as never),
  readTaskRereviewRequest: (b) => b.readTaskRereviewRequest(1 as never, 1 as never),
};

describe("RemoteBackend read-only methods are idempotent on the wire (#2703)", () => {
  let wire: Wire[];
  beforeEach(() => {
    real.client = real.make!();
    wire = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        wire.push({
          method: init?.method ?? "GET",
          path: url.pathname + url.search,
          body: typeof init?.body === "string" ? init.body : undefined,
        });
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("has a driver for every READ_ONLY entry", () => {
    expect(READ_ONLY.filter((n) => !(n in READ_ONLY_CALLS))).toEqual([]);
    expect(Object.keys(READ_ONLY_CALLS).filter((n) => !READ_ONLY.includes(n))).toEqual([]);
  });

  it.each(READ_ONLY)("%s only issues idempotent requests", async (name) => {
    // The reply is `{}`, so a method may reject while parsing it: only the
    // requests it already sent matter.
    await READ_ONLY_CALLS[name]!(backend()).catch(() => undefined);
    const mutating = wire.filter((w) => !isIdempotentRequest(w.method, w.path, w.body));
    expect(mutating).toEqual([]);
  });

  it("drives real wire traffic for the methods that talk to the host", async () => {
    const talks = READ_ONLY.filter((n) => n !== "listSessionProcesses");
    for (const name of talks) {
      wire.length = 0;
      real.client = real.make!();
      await READ_ONLY_CALLS[name]!(backend()).catch(() => undefined);
      expect(wire.length, `${name} sent no request`).toBeGreaterThan(0);
    }
  });
});
