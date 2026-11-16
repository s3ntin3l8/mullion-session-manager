import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type * as ChildProcess from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ failVerbose: false, verbose: "" }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: (command: string, args: readonly string[]) => {
      if (command !== "docker") throw new Error(`unexpected spawn: ${command}`);
      const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      Object.assign(child, { stdout, stderr, stdin: new PassThrough(), kill: () => true });
      queueMicrotask(() => {
        if (args.includes("-v")) {
          if (state.failVerbose) {
            stderr.write("boom");
            child.emit("close", 1);
            return;
          }
          stdout.write(state.verbose);
        } else if (args[0] === "system") {
          stdout.write(
            '{"Type":"Local Volumes","TotalCount":"3","Active":"1","Size":"2GB","Reclaimable":"1GB"}\n',
          );
        }
        child.emit("close", 0);
      });
      return child;
    },
  };
});

import { buildTestApp } from "../helpers/app.js";

const anon = "ab".repeat(32);

describe("GET /api/storage/docker volumes", () => {
  beforeEach(() => {
    state.failVerbose = false;
    state.verbose = JSON.stringify({
      Images: [],
      Containers: [],
      BuildCache: [],
      Volumes: [
        { Name: anon, Links: "0", Size: "68MB" },
        { Name: "pgdata", Links: "1", Size: "1GB" },
      ],
    });
  });

  it("returns the anonymous/named split", async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/api/storage/docker?refresh=1" });
    expect(res.json().volumes).toEqual({
      anonymousUnused: { count: 1, bytes: 68 * 1000 ** 2 },
      named: { count: 1, bytes: 1000 ** 3 },
      inUse: { count: 0, bytes: 0 },
    });
  });

  it("omits volumes when the verbose call fails", async () => {
    state.failVerbose = true;
    const app = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/api/storage/docker?refresh=1" });
    expect(res.json().available).toBe(true);
    expect(res.json()).not.toHaveProperty("volumes");
  });
});
