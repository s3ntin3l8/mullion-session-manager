import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Issue #1124 — discoverCommittedScaffoldOnHost's whole job is dispatching
// (app, hostId, cwd) to either the real local discoverCommittedScaffold scan
// or RemoteHostClient.scaffoldScan, degrading to "not committed" (with a
// warn log, never silently) on a host that can't answer. Same "mock the one
// collaborator (remote-host-client.js), test dispatch/mapping only" posture
// as test/services/host-files.test.ts and test/services/host-git.test.ts —
// discoverCommittedScaffold's OWN local scan logic (identity stamp vs shape
// fallback) is covered directly by
// test/services/session-lifecycle-scaffold-gate.test.ts.

const mockGetRemoteHostClient = vi.fn();

vi.mock("../../src/services/remote-host-client.js", () => ({
  getRemoteHostClient: mockGetRemoteHostClient,
  HostRequestError: class extends Error {
    statusCode: number;
    constructor(hostId: string, statusCode: number, body: string) {
      super(`Host ${hostId} rejected the request: HTTP ${statusCode}${body ? ` — ${body}` : ""}`);
      this.name = "HostRequestError";
      this.statusCode = statusCode;
    }
  },
  HostUnreachableError: class extends Error {
    constructor(hostId: string, cause: unknown) {
      super(
        `Host ${hostId} is unreachable: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      this.name = "HostUnreachableError";
    }
  },
}));

const { discoverCommittedScaffoldOnHost } = await import("../../src/services/session-lifecycle.js");
const { scaffoldSkillPath, scaffoldReviewerPath, scaffoldStampLine } =
  await import("../../src/services/mullion-scaffold.js");
const { HostRequestError, HostUnreachableError } =
  await import("../../src/services/remote-host-client.js");

function fakeApp() {
  return { config: {}, log: { warn: vi.fn() } } as unknown as Parameters<
    typeof discoverCommittedScaffoldOnHost
  >[0];
}

describe("discoverCommittedScaffoldOnHost (issue #1124)", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "scaffold-gate-onhost-"));
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("local: dispatches to the real local scan, against this filesystem directly", async () => {
    const slug = "acme-widgets";
    const skillPath = path.join(cwd, scaffoldSkillPath(slug));
    const reviewerPath = path.join(cwd, scaffoldReviewerPath(slug));
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(
      skillPath,
      `---\nname: ${slug}\ndescription: "x"\n---\n\n${scaffoldStampLine(slug)}\n\nBody.\n`,
    );
    fs.mkdirSync(path.dirname(reviewerPath), { recursive: true });
    fs.writeFileSync(
      reviewerPath,
      `---\nname: ${slug}-reviewer\ndescription: "x"\n---\n\n${scaffoldStampLine(slug)}\n\nBody.\n`,
    );

    const result = await discoverCommittedScaffoldOnHost(fakeApp(), "local", cwd);

    expect(result).toEqual({ skillCommitted: true, reviewerCommitted: true });
    // A local dispatch never touches the remote client at all.
    expect(mockGetRemoteHostClient).not.toHaveBeenCalled();
  });

  it("remote: proxies to RemoteHostClient.scaffoldScan and returns its value verbatim", async () => {
    const mockScaffoldScan = vi
      .fn()
      .mockResolvedValue({ skillCommitted: true, reviewerCommitted: false });
    mockGetRemoteHostClient.mockReturnValue({ scaffoldScan: mockScaffoldScan });

    const result = await discoverCommittedScaffoldOnHost(fakeApp(), "remote-host-1", "/remote/cwd");

    expect(mockScaffoldScan).toHaveBeenCalledWith("/remote/cwd");
    expect(result).toEqual({ skillCommitted: true, reviewerCommitted: false });
  });

  it("remote: an unreachable host degrades to not-committed and warns, never silently double-delivers", async () => {
    mockGetRemoteHostClient.mockReturnValue({
      scaffoldScan: vi
        .fn()
        .mockRejectedValue(new HostUnreachableError("remote-host-1", new Error("timeout"))),
    });
    const app = fakeApp();

    const result = await discoverCommittedScaffoldOnHost(app, "remote-host-1", "/remote/cwd");

    expect(result).toEqual({ skillCommitted: false, reviewerCommitted: false });
    expect(app.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: "remote-host-1", reason: "unreachable" }),
      expect.stringContaining("could not reach agent host"),
    );
  });

  it("remote: an old agent build (404) degrades to not-committed and warns to update the agent build", async () => {
    mockGetRemoteHostClient.mockReturnValue({
      scaffoldScan: vi.fn().mockRejectedValue(new HostRequestError("remote-host-1", 404, "")),
    });
    const app = fakeApp();

    const result = await discoverCommittedScaffoldOnHost(app, "remote-host-1", "/remote/cwd");

    expect(result).toEqual({ skillCommitted: false, reviewerCommitted: false });
    expect(app.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: "remote-host-1", reason: "unsupported" }),
      expect.stringContaining("update the agent build"),
    );
  });
});
