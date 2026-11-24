import { describe, it, expect, vi } from "vitest";
import {
  resolveDevServerPort,
  resolveDockerServices,
  runDockerComposeAction,
} from "../../src/services/remote-host-docker.js";

// Issue #3427 — the request shapes the docker facet puts on the wire.
describe("remote-host-docker facet", () => {
  it("asks for the services under a cwd, URL-encoded", async () => {
    const request = vi.fn().mockResolvedValue({ services: [], composeAvailable: false });
    await resolveDockerServices(request, "/a b/proj");
    expect(request).toHaveBeenCalledWith("/internal/docker-services?cwd=%2Fa%20b%2Fproj");
  });

  it("posts a compose action naming the service, never a docker argument, with a long timeout", async () => {
    const request = vi.fn().mockResolvedValue({ success: true });
    await runDockerComposeAction(request, "/p", { composeProject: "s", service: "web" }, "restart");
    const [path, init, timeout] = request.mock.calls[0];
    expect(path).toBe("/internal/docker-compose-action");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      cwd: "/p",
      composeProject: "s",
      service: "web",
      action: "restart",
    });
    expect(timeout).toBeGreaterThan(60_000);
  });

  it("sends the session ids as a comma list", async () => {
    const request = vi.fn().mockResolvedValue({ port: "3000" });
    expect(await resolveDevServerPort(request, ["1", "2"])).toEqual({ port: "3000" });
    expect(request).toHaveBeenCalledWith("/internal/dev-server-port?sessionIds=1%2C2");
  });
});
