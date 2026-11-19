import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type * as TempStorage from "../../src/services/temp-storage.js";
import type * as CacheStorage from "../../src/services/cache-storage.js";
import type * as OpencodeStorage from "../../src/services/opencode-storage.js";
import type * as DevWorktrees from "../../src/services/dev-worktrees.js";

// Every other source is mocked: a real prune here would touch the host. The
// Android source is real, against a temp SDK and a fake sdkmanager.
vi.mock("../../src/services/docker-storage.js", () => ({
  inspectDockerStorage: async () => ({ available: false, error: "mocked" }),
  pruneDockerStorage: async () => ({ output: "", reclaimedBytes: 0 }),
}));
vi.mock("../../src/services/temp-storage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof TempStorage>()),
  inspectTempStorage: async () => ({ available: false, error: "mocked" }),
  pruneTempStorage: async () => ({ output: "", reclaimedBytes: 0 }),
}));
vi.mock("../../src/services/cache-storage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof CacheStorage>()),
  inspectCacheStorage: async () => ({ available: true, caches: [] }),
  pruneCacheStorage: async () => ({ output: "", reclaimedBytes: 0 }),
}));
vi.mock("../../src/services/opencode-storage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof OpencodeStorage>()),
  inspectOpencodeStorage: async () => ({ available: true, reclaimableBytes: 0 }),
  pruneOpencodeStorage: async () => ({ output: "", reclaimedBytes: 0 }),
}));
vi.mock("../../src/services/dev-worktrees.js", async (importOriginal) => ({
  ...(await importOriginal<typeof DevWorktrees>()),
  inspectDevWorktrees: async () => ({ available: true, candidates: [], totalBytes: 0 }),
  pruneDevWorktrees: async () => ({ output: "", reclaimedBytes: 0 }),
}));

import type { CleanupJob, CleanupStatus } from "../../src/services/disk-cleanup-job.js";
import { buildTestApp } from "../helpers/app.js";

type App = Awaited<ReturnType<typeof buildTestApp>>;

const USED = "system-images;android-35;google_apis;x86_64";
const SPARE = "system-images;android-37.2;google_apis_ps16k;x86_64";

let tmp: string;
let argvLog: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["DEVICE_ANDROID_SDK_ROOT", "DEVICE_SDKMANAGER_PATH", "ANDROID_AVD_HOME", "HOME"];

function image(pkg: string) {
  const dir = path.join(
    tmp,
    "sdk",
    ...pkg.split(";").map((part, i) => (i === 0 ? "system-images" : part)),
  );
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "system.img"), Buffer.alloc(2048));
}

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "android-route-"));
  argvLog = path.join(tmp, "argv.log");
  fs.mkdirSync(path.join(tmp, "avd", "pixel.avd"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "avd", "pixel.avd", "config.ini"),
    "image.sysdir.1=system-images/android-35/google_apis/x86_64/\n",
  );
  image(USED);
  image(SPARE);
  const sdkmanager = path.join(tmp, "sdkmanager");
  fs.writeFileSync(sdkmanager, `#!/bin/sh\necho "$@" >> "${argvLog}"\n`, { mode: 0o755 });
  // HOME too: the SDK's default AVD folder is under it.
  process.env.HOME = path.join(tmp, "home");
  process.env.ANDROID_AVD_HOME = path.join(tmp, "avd");
  process.env.DEVICE_ANDROID_SDK_ROOT = path.join(tmp, "sdk");
  process.env.DEVICE_SDKMANAGER_PATH = sdkmanager;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const argv = () => (fs.existsSync(argvLog) ? fs.readFileSync(argvLog, "utf8").trim() : "");

async function runCleanup(app: App, payload: object) {
  const res = await app.inject({ method: "POST", url: "/api/storage/cleanup", payload });
  expect(res.statusCode).toBe(202);
  let job!: CleanupJob;
  await vi.waitFor(async () => {
    const current = (
      await app.inject({ method: "GET", url: "/api/storage/cleanup" })
    ).json<CleanupStatus>();
    expect(current.state).toBe("done");
    job = current as CleanupJob;
  });
  return job;
}

async function appWithOptIns(optIns: string[]) {
  const app = await buildTestApp();
  await app.inject({ method: "PATCH", url: "/api/settings", payload: { diskCleanup: { optIns } } });
  return app;
}

const AGGRESSIVE = { mode: "aggressive", optIns: ["android-system-images"] };

describe("android system images cleanup", () => {
  it("GET /api/storage/android-images lists the unreferenced image", async () => {
    const app = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/api/storage/android-images" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      state: "ready",
      available: true,
      images: [{ packagePath: SPARE }],
    });
  });

  it("uninstalls only unreferenced images when requested and stored agree", async () => {
    const app = await appWithOptIns(["android-system-images"]);
    const job = await runCleanup(app, AGGRESSIVE);
    const step = job.steps.find((s) => s.source === "android-images");
    expect(step).toMatchObject({ state: "done" });
    expect(step?.reclaimedBytes).toBeGreaterThan(0);
    expect(argv()).toBe(`--uninstall ${SPARE} --sdk_root=${path.join(tmp, "sdk")}`);
  });

  it("does nothing when only the request carries the id", async () => {
    const app = await appWithOptIns([]);
    const job = await runCleanup(app, AGGRESSIVE);
    expect(job.steps.map((s) => s.source)).not.toContain("android-images");
    expect(argv()).toBe("");
  });

  it("does nothing when only the stored settings carry the id", async () => {
    const app = await appWithOptIns(["android-system-images"]);
    for (const payload of [{ mode: "aggressive", optIns: [] }, { mode: "aggressive" }]) {
      const job = await runCleanup(app, payload);
      expect(job.steps.map((s) => s.source)).not.toContain("android-images");
    }
    expect(argv()).toBe("");
  });

  it("never runs in safe mode", async () => {
    const app = await appWithOptIns(["android-system-images"]);
    const job = await runCleanup(app, { mode: "safe", optIns: ["android-system-images"] });
    expect(job.steps.map((s) => s.source)).not.toContain("android-images");
    expect(argv()).toBe("");
  });

  it("removes nothing when an AVD cannot be read", async () => {
    fs.mkdirSync(path.join(tmp, "avd", "broken.avd"));
    const app = await appWithOptIns(["android-system-images"]);
    const job = await runCleanup(app, AGGRESSIVE);
    expect(job.steps.find((s) => s.source === "android-images")).toMatchObject({
      state: "skipped",
      reclaimedBytes: 0,
    });
    expect(argv()).toBe("");
  });
});
