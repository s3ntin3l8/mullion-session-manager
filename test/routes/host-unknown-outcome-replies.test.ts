import { describe, it, expect, vi, afterAll, beforeAll, afterEach } from "vitest";
import { plainNodePtyMock } from "../helpers/mock-pty.js";

vi.mock("node-pty", () => plainNodePtyMock());

const { buildApp } = await import("../../src/app.js");
const clientModule = await import("../../src/services/remote-host-client.js");

// A mutation whose connection dropped after the request was sent may have run.
// Each route below used to report that as "Host X is unreachable", which invites
// a blind retry of something that already landed (#2723). They must all say the
// request MAY HAVE BEEN DELIVERED, and say it once.
const MAY = /MAY HAVE BEEN DELIVERED/g;
const mayCount = (message: string) => (message.match(MAY) ?? []).length;

describe("remote mutations that lose the connection mid-request", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let hostId: string;
  let projectId: number;
  const unknown = () => new clientModule.HostOutcomeUnknownError(hostId, new Error("link dropped"));

  beforeAll(async () => {
    app = await buildApp();
    const host = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "unknown-outcome-host", baseUrl: "http://127.0.0.1:1", token: "t" },
    });
    hostId = host.json().id;
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, name: "remote-unknown-outcome", cwd: "/x", hostId },
    });
    projectId = project.json().id;
  });

  afterAll(async () => {
    await app?.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function stubClient(method: string) {
    vi.spyOn(clientModule, "getRemoteHostClient").mockReturnValue({
      [method]: vi.fn().mockRejectedValue(unknown()),
    } as never);
  }

  it("git branch delete says so exactly once, through the backend's typed error", async () => {
    stubClient("resolveDeleteBranch");
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/git-branch-delete`,
      payload: { name: "feature" },
    });
    expect(res.statusCode).toBe(503);
    expect(mayCount(res.json().message)).toBe(1);
    // The transport detail rides along; the error's own sentence is not repeated.
    expect(res.json().message).toContain("link dropped");
    expect(res.json().message).not.toMatch(/lost the outbound connection/);
  });

  it("git pull says so exactly once", async () => {
    stubClient("resolveGitPull");
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/git-pull`,
    });
    expect(res.statusCode).toBe(503);
    expect(mayCount(res.json().message)).toBe(1);
  });

  it("git fetch reports an unknown outcome, not 'unreachable'", async () => {
    stubClient("resolveGitFetch");
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/git-fetch`,
    });
    expect(res.statusCode).toBe(503);
    expect(mayCount(res.json().message)).toBe(1);
    expect(res.json().message).not.toMatch(/is unreachable/);
  });

  it("worktree metadata prune reports an unknown outcome, not 'unreachable'", async () => {
    stubClient("resolvePruneWorktreeMetadata");
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/git-worktree-prune`,
    });
    expect(res.statusCode).toBe(503);
    expect(mayCount(res.json().message)).toBe(1);
  });

  it("writing an agent rule reports an unknown outcome as 502, not 'unreachable'", async () => {
    stubClient("writeAgentRule");
    const res = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/agent-rules/claude-code:project`,
      payload: { content: "rule" },
    });
    expect(res.statusCode).toBe(502);
    expect(mayCount(res.json().message)).toBe(1);
  });

  it("deleting an agent rule reports an unknown outcome", async () => {
    stubClient("deleteAgentRule");
    const res = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}/agent-rules/claude-code:project`,
    });
    expect(res.statusCode).toBe(502);
    expect(mayCount(res.json().message)).toBe(1);
  });

  it("writing the dock config reports an unknown outcome", async () => {
    stubClient("writeDockConfig");
    const res = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/dock/config`,
      payload: { controls: [] },
    });
    expect(res.statusCode).toBe(502);
    expect(mayCount(res.json().message)).toBe(1);
  });

  it("toggling a skill reports an unknown outcome", async () => {
    stubClient("writeSkillEnabled");
    const res = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/skills`,
      payload: { agent: "claude-code", name: "some-skill", enabled: true },
    });
    expect(res.statusCode).toBe(502);
    expect(mayCount(res.json().message)).toBe(1);
  });

  it("changing the host's project roots reports an unknown outcome", async () => {
    stubClient("resolveSetProjectsRoots");
    const res = await app.inject({
      method: "PUT",
      url: `/api/hosts/${hostId}/config/projects-roots`,
      payload: { roots: ["/srv/projects"] },
    });
    expect(res.statusCode).toBe(502);
    expect(mayCount(res.json().message)).toBe(1);
  });

  it("a plain unreachable host still reads 'unreachable', never an unknown outcome", async () => {
    vi.spyOn(clientModule, "getRemoteHostClient").mockReturnValue({
      writeAgentRule: vi
        .fn()
        .mockRejectedValue(
          new clientModule.HostUnreachableError(hostId, new Error("ECONNREFUSED")),
        ),
    } as never);
    const res = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/agent-rules/claude-code:project`,
      payload: { content: "rule" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().message).toMatch(/is unreachable/);
    expect(mayCount(res.json().message)).toBe(0);
  });
});
