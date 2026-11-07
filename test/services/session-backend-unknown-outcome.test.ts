import type { FastifyInstance } from "fastify";
import type * as RemoteHostClientModule from "../../src/services/remote-host-client.js";
import { describe, expect, it, vi } from "vitest";

const lost = vi.hoisted(() => ({ err: undefined as unknown }));
const reject = vi.hoisted(() => () => Promise.reject(lost.err));
const clientMock = vi.hoisted(() => ({
  spawn: reject,
  terminate: reject,
  uploadImage: reject,
  uploadFile: reject,
  resolveReviewGate: reject,
  acknowledgeAttention: reject,
  resolvePendingPromote: reject,
  resolveStashSeed: reject,
  resolveSyncWorktree: reject,
  resolveCreateWorktree: reject,
  resolveCheckoutBranchWorktree: reject,
  resolveRemoveWorktree: reject,
  resolveResumeTaskWorktree: reject,
  resolveRemoveWorktreeIfClean: reject,
  resolvePruneWorktrees: reject,
  resolveClearOrphanedTaskWorktree: reject,
  resolveDeleteBranch: reject,
  resolveGitCheckout: reject,
  resolveGitBranchCreate: reject,
  resolveGitRebase: reject,
  resolveRemoveListedWorktree: reject,
  resolvePruneWorktreeMetadata: reject,
  resolveDeleteTaskReviewFindings: reject,
}));

vi.mock("../../src/services/remote-host-client.js", async (importActual) => ({
  ...(await importActual<typeof RemoteHostClientModule>()),
  getRemoteHostClient: () => clientMock,
}));

import {
  MutationOutcomeUnknownError,
  resolveBackend,
  unknownOutcomeMessage,
} from "../../src/services/session-backend.js";
import { HostOutcomeUnknownError } from "../../src/services/remote-host-errors.js";
import { HostUnreachableError } from "../../src/services/remote-host-client.js";

// #2691 — every mutating RemoteBackend call raises ONE typed unknown-outcome
// error when the channel closes after the request was sent. It is raised, never
// returned, so `if (await backend.resolveReviewGate(...))` cannot read it as ok.
const backend = () => resolveBackend({ db: {} } as unknown as FastifyInstance, "mac-1") as never;

type Call = [string, (b: Record<string, (...a: never[]) => Promise<unknown>>) => Promise<unknown>];
const CALLS: Call[] = [
  ["spawn", (b) => b.spawn({ id: "1", cwd: "/x", command: "c", cols: 1, rows: 1 } as never)],
  ["terminate", (b) => b.terminate("1" as never)],
  [
    "uploadImage",
    (b) => b.uploadImage("/x" as never, Buffer.alloc(1) as never, "image/png" as never),
  ],
  ["uploadFile", (b) => b.uploadFile("/x" as never, Buffer.alloc(1) as never, "a.txt" as never)],
  [
    "resolveReviewGate",
    (b) => b.resolveReviewGate("1" as never, undefined as never, "approved" as never),
  ],
  ["acknowledgeAttention", (b) => b.acknowledgeAttention("1" as never)],
  [
    "resolvePendingPromote",
    (b) => b.resolvePendingPromote("1" as never, { decision: "declined" } as never),
  ],
  ["stashSeed", (b) => b.stashSeed("1" as never, "seed" as never)],
  ["syncWorktree", (b) => b.syncWorktree("/w" as never, "main" as never)],
  ["createWorktree", (b) => b.createWorktree("/x" as never, "main" as never, "s" as never)],
  ["checkoutBranchWorktree", (b) => b.checkoutBranchWorktree("/x" as never, "main" as never)],
  ["removeWorktree", (b) => b.removeWorktree("/w" as never)],
  ["resumeTaskWorktree", (b) => b.resumeTaskWorktree("/x" as never, "b" as never)],
  ["removeWorktreeIfClean", (b) => b.removeWorktreeIfClean("/w" as never)],
  ["pruneWorktrees", (b) => b.pruneWorktrees("/x" as never, [] as never)],
  [
    "clearOrphanedTaskWorktree",
    (b) => b.clearOrphanedTaskWorktree("/x" as never, "/w" as never, "b" as never),
  ],
  ["deleteBranch", (b) => b.deleteBranch("/x" as never, "b" as never)],
  ["checkoutBranch", (b) => b.checkoutBranch("/x" as never, "b" as never)],
  ["createBranch", (b) => b.createBranch("/x" as never, "b" as never, "main" as never)],
  ["rebaseBranch", (b) => b.rebaseBranch("/x" as never)],
  ["removeListedWorktree", (b) => b.removeListedWorktree("/x" as never, "/w" as never)],
  ["pruneWorktreeMetadata", (b) => b.pruneWorktreeMetadata("/x" as never)],
  ["deleteTaskReviewFindings", (b) => b.deleteTaskReviewFindings(1 as never, 1 as never)],
];

// Every RemoteBackend method must be classified here. A new method that is in
// neither list fails the test below, so it cannot be added unclassified:
// mutating ones belong in CALLS (above), read-only ones in READ_ONLY.
// `prompt` is mutating but answers an unknown outcome as a VALUE (a refusal with
// the "MAY HAVE BEEN DELIVERED" error), covered in session-backend-remote-control.test.ts.
const MUTATING_AS_VALUE = ["prompt"];
const READ_ONLY = [
  "liveStatus",
  "liveness",
  "compareWorktreePaths",
  "getScrollback",
  "getRenderedScrollback",
  "getTranscript",
  "listSessionProcesses",
  "waitOutput",
  "listTaskWorktreeDirs",
  "readTaskReviewFindings",
  "resolveSessionsDir",
  "readTaskCommitTitle",
  "readTaskRereviewRequest",
];

describe("RemoteBackend method classification (#2703)", () => {
  it("every method is classified mutating (CALLS) or read-only (READ_ONLY), exactly once", () => {
    const proto = Object.getPrototypeOf(backend()) as object;
    const methods = Object.getOwnPropertyNames(proto).filter(
      (n) => n !== "constructor" && typeof (proto as Record<string, unknown>)[n] === "function",
    );
    // Private helpers are not part of the SessionBackend surface.
    const surface = methods.filter(
      (n) => n !== "mutating" && n !== "changedWorktrees" && n !== "remoteRefusal",
    );
    const classified = [...CALLS.map(([n]) => n), ...MUTATING_AS_VALUE, ...READ_ONLY];
    expect(classified.filter((n, i) => classified.indexOf(n) !== i)).toEqual([]);
    expect(surface.filter((n) => !classified.includes(n))).toEqual([]);
    expect(classified.filter((n) => !surface.includes(n))).toEqual([]);
  });

  it("the Local/Remote backend methods that mutate are the ones in CALLS", () => {
    // A read-only entry must never also be a mutating call.
    expect(READ_ONLY.filter((n) => CALLS.some(([c]) => c === n))).toEqual([]);
  });
});

describe("RemoteBackend mutating calls: unknown outcome (#2691)", () => {
  it.each(CALLS)(
    "%s raises MutationOutcomeUnknownError when the connection is lost mid-request",
    async (_name, run) => {
      lost.err = new HostOutcomeUnknownError("mac-1", new Error("channel closed"));
      const err = await run(backend()).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(MutationOutcomeUnknownError);
      expect(unknownOutcomeMessage(err)).toMatch(/MAY HAVE BEEN DELIVERED/);
    },
  );

  it.each(CALLS)(
    "%s leaves a plain unreachable host a plain unreachable error",
    async (_name, run) => {
      lost.err = new HostUnreachableError("mac-1", new Error("ECONNREFUSED"));
      const err = await run(backend()).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(HostUnreachableError);
      expect(err).not.toBeInstanceOf(MutationOutcomeUnknownError);
      expect(unknownOutcomeMessage(err)).toBeNull();
    },
  );
});
