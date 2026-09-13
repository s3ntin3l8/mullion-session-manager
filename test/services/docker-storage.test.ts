import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  DOCKER_PRUNE_ARGS,
  inspectDockerStorage,
  parseDockerUsage,
  pruneDockerStorage,
  type SpawnDocker,
} from "../../src/services/docker-storage.js";

function fakeSpawn(
  options: { stdout?: string; stderr?: string; code?: number; hold?: boolean } = {},
) {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  let child: ChildProcessWithoutNullStreams;
  const spawn: SpawnDocker = (command, args) => {
    const emitter = new EventEmitter() as ChildProcessWithoutNullStreams;
    Object.assign(emitter, {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      kill: vi.fn(),
    });
    child = emitter;
    calls.push({ command, args });
    if (!options.hold) {
      queueMicrotask(() => {
        if (options.stdout) emitter.stdout.write(options.stdout);
        if (options.stderr) emitter.stderr.write(options.stderr);
        emitter.emit("close", options.code ?? 0);
      });
    }
    return emitter;
  };
  return {
    spawn,
    calls,
    get child() {
      return child;
    },
  };
}

describe("Docker storage", () => {
  it("parses Docker's JSON-lines usage and reclaimable estimates", () => {
    const rows = parseDockerUsage(
      '{"Type":"Images","TotalCount":"3","Active":"1","Size":"1.5GB","Reclaimable":"512MB (33%)"}\n',
    );
    expect(rows).toEqual([
      {
        type: "Images",
        totalCount: 3,
        activeCount: 1,
        sizeBytes: 1.5 * 1000 ** 3,
        reclaimableBytes: 512 * 1000 ** 2,
      },
    ]);
  });

  it("uses the fixed conservative prune arguments without --all or --volumes", async () => {
    const fake = fakeSpawn({ stdout: "Total reclaimed space: 1GB" });
    await expect(pruneDockerStorage(fake.spawn)).resolves.toEqual({
      output: "Total reclaimed space: 1GB",
    });
    expect(fake.calls).toEqual([{ command: "docker", args: DOCKER_PRUNE_ARGS }]);
    expect(DOCKER_PRUNE_ARGS).not.toContain("--all");
    expect(DOCKER_PRUNE_ARGS).not.toContain("--volumes");
  });

  it("reports Docker as unavailable on a non-zero exit", async () => {
    const fake = fakeSpawn({ stderr: "permission denied", code: 1 });
    await expect(inspectDockerStorage(fake.spawn)).resolves.toMatchObject({
      available: false,
      error: "permission denied",
    });
  });

  it("bounds combined Docker output and kills a command that exceeds the limit", async () => {
    const fake = fakeSpawn({
      stdout: "x".repeat(600 * 1024),
      stderr: "y".repeat(600 * 1024),
    });
    await expect(inspectDockerStorage(fake.spawn)).resolves.toMatchObject({
      available: false,
      error: "Docker output exceeded the 1 MiB limit",
    });
    expect(fake.child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("rejects a concurrent prune while the first run is active", async () => {
    const fake = fakeSpawn({ hold: true });
    const first = pruneDockerStorage(fake.spawn);
    await expect(pruneDockerStorage(fake.spawn)).rejects.toThrow("DOCKER_PRUNE_IN_PROGRESS");
    fake.child.emit("close", 0);
    await expect(first).resolves.toEqual({ output: "" });
  });

  it("kills and rejects a Docker command that exceeds its timeout", async () => {
    vi.useFakeTimers();
    const fake = fakeSpawn({ hold: true });
    const inspection = inspectDockerStorage(fake.spawn);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(inspection).resolves.toMatchObject({
      available: false,
      error: "Docker command timed out",
    });
    expect(fake.child.kill).toHaveBeenCalledWith("SIGKILL");
    vi.useRealTimers();
  });
});
