import { describe, it, expect, vi, afterAll, beforeAll } from "vitest";
import { plainNodePtyMock } from "../helpers/mock-pty.js";

vi.mock("node-pty", () => plainNodePtyMock());

const { buildApp } = await import("../../src/app.js");

describe("projects route - remote host outcome unknown", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("surfaces outcome unknown when the host disconnects mid-pull", async () => {
    const { HostOutcomeUnknownError } = await import("../../src/services/remote-host-client.js");
    const host = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "git-pull-unknown-host", baseUrl: "http://127.0.0.1:1", token: "t" },
    });
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        allowDuplicate: true,
        name: "remote-git-pull-unknown",
        cwd: "/x",
        hostId: host.json().id,
      },
    });
    const clientModule = await import("../../src/services/remote-host-client.js");
    vi.spyOn(clientModule, "getRemoteHostClient").mockReturnValue({
      resolveGitPull: vi
        .fn()
        .mockRejectedValue(new HostOutcomeUnknownError(host.json().id, new Error("link dropped"))),
    } as never);

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${project.json().id}/git-pull`,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().message).toMatch(/outcome.*unknown/i);
  });

  it("surfaces outcome unknown when the host disconnects mid-branch-delete", async () => {
    const { HostOutcomeUnknownError } = await import("../../src/services/remote-host-client.js");
    const host = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "branch-del-unknown-host", baseUrl: "http://127.0.0.1:1", token: "t" },
    });
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        allowDuplicate: true,
        name: "remote-branch-del-unknown",
        cwd: "/x",
        hostId: host.json().id,
      },
    });
    const clientModule = await import("../../src/services/remote-host-client.js");
    vi.spyOn(clientModule, "getRemoteHostClient").mockReturnValue({
      resolveDeleteBranch: vi
        .fn()
        .mockRejectedValue(new HostOutcomeUnknownError(host.json().id, new Error("link dropped"))),
    } as never);

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${project.json().id}/git-branch-delete`,
      payload: { name: "feature" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().message).toMatch(/outcome.*unknown/i);
  });
});
