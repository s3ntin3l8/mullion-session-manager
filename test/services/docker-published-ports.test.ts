import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";

// #3003 — the host ports a Compose service publishes, read from `docker
// ps`'s `{{.Ports}}` (the last PS_FORMAT field), for the Browser pane's quick
// pick. Kept apart from docker-service-detect.test.ts, which is at its size
// ceiling; `docker` is faked the same way.

let psOutput = "";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: vi.fn((_cmd: string, args: string[]) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: () => void;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      setImmediate(() => {
        if (args[0] === "ps") child.stdout.emit("data", Buffer.from(psOutput));
        else if (args[0] === "compose" && args.includes("config")) {
          child.stdout.emit("data", Buffer.from('{"services":{}}'));
        }
        child.emit("close", 0);
      });
      return child;
    }),
  };
});

const { parsePublishedPorts, getComposeServices, clearComposeCacheForTests } =
  await import("../../src/services/docker-service-detect.js");

// Field order matches PS_FORMAT, with {{.Ports}} last.
function psLine(id: string, state: string, service: string, ports: string): string {
  return [
    id,
    `shop-${service}`,
    state,
    "Up",
    "nginx:latest",
    "2026-07-12 21:53:25 +0000 UTC",
    "shop",
    service,
    "/tmp/shop",
    "sha256:x",
    "False",
    "",
    "",
    "",
    ports,
  ].join("\t");
}

describe("parsePublishedPorts", () => {
  it("keeps published TCP host ports once each, ascending", () => {
    expect(
      parsePublishedPorts(
        "0.0.0.0:8080->80/tcp, [::]:8080->80/tcp, 127.0.0.1:3000->3000/tcp, 5432/tcp, 0.0.0.0:53->53/udp",
      ),
    ).toEqual([3000, 8080]);
  });

  it("counts a published range by its first port and ignores the rest", () => {
    expect(parsePublishedPorts("0.0.0.0:8000-8001->8000-8001/tcp")).toEqual([8000]);
    expect(parsePublishedPorts("")).toEqual([]);
    expect(parsePublishedPorts("garbage, :0->1/tcp")).toEqual([]);
  });
});

describe("getComposeServices — published ports", () => {
  beforeEach(() => clearComposeCacheForTests());

  it("records a running container's published ports, and none for a stopped one", async () => {
    psOutput = [
      psLine("a", "running", "web", "0.0.0.0:8080->80/tcp, [::]:8080->80/tcp"),
      psLine("b", "exited", "old", "0.0.0.0:9090->80/tcp"),
    ].join("\n");
    const services = await getComposeServices(true);
    expect(services.find((s) => s.service === "web")?.publishedPorts).toEqual([8080]);
    expect(services.find((s) => s.service === "old")?.publishedPorts).toEqual([]);
  });

  it("parses a row without the Ports field as publishing nothing", async () => {
    psOutput = psLine("a", "running", "web", "").split("\t").slice(0, 14).join("\t");
    const services = await getComposeServices(true);
    expect(services[0]?.publishedPorts).toEqual([]);
  });
});
