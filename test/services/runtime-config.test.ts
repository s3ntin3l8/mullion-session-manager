import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import { DEFAULT_SETTINGS, type AppSettings } from "../../src/services/settings.js";
import {
  resolveBrowserFramerate,
  resolveBrowserMaxInstances,
  resolveDeviceDiscoveryEnabled,
  resolveDeviceEmulatorLaunch,
  resolveGitHubPoll,
  resolveHeartbeatSeconds,
  resolveLogLevel,
  runtimeEnvDefaults,
  toActivityIntervals,
} from "../../src/services/runtime-config.js";

const app = {
  config: {
    GITHUB_POLL_INTERVAL_ACTIVE: 15,
    GITHUB_POLL_INTERVAL_QUIET: 60,
    GITHUB_POLL_STALE_THRESHOLD: 300,
    HOST_HEARTBEAT_INTERVAL_SECONDS: 30,
    BROWSER_FRAMERATE: 10,
    BROWSER_MAX_INSTANCES: 4,
    DEVICE_DISCOVERY_ENABLED: true,
    DEVICE_EMULATOR_HEADLESS: true,
    DEVICE_EMULATOR_GPU: "swiftshader_indirect",
    LOG_LEVEL: "info",
  },
} as unknown as FastifyInstance;

function withOverrides(patch: Partial<AppSettings>): AppSettings {
  return { ...DEFAULT_SETTINGS, ...patch };
}

describe("runtime-config", () => {
  it("reports the env defaults", () => {
    expect(runtimeEnvDefaults(app)).toEqual({
      githubPollActiveSeconds: 15,
      githubPollQuietSeconds: 60,
      githubPollStaleThresholdSeconds: 300,
      hostHeartbeatSeconds: 30,
      browserFramerate: 10,
      browserMaxInstances: 4,
      deviceDiscoveryEnabled: true,
      deviceEmulatorHeadless: true,
      deviceEmulatorGpu: "swiftshader_indirect",
      logLevel: "info",
    });
  });

  it("falls back to env for every -1 / inherit sentinel", () => {
    expect(resolveGitHubPoll(DEFAULT_SETTINGS, app)).toEqual({
      activeSeconds: 15,
      quietSeconds: 60,
      staleThresholdSeconds: 300,
    });
    expect(resolveHeartbeatSeconds(DEFAULT_SETTINGS, app)).toBe(30);
    expect(resolveBrowserFramerate(DEFAULT_SETTINGS, app)).toBe(10);
    expect(resolveLogLevel(DEFAULT_SETTINGS, app)).toBe("info");
  });

  it("lets a settings value win over env", () => {
    const s = withOverrides({
      github: { pollActiveSeconds: 20, pollQuietSeconds: 120, pollStaleThresholdSeconds: 600 },
      hosts: { heartbeatSeconds: 0 },
      browser: { framerate: 24, maxInstances: 8 },
      devices: { ...DEFAULT_SETTINGS.devices, discoveryEnabled: "off" },
      server: { logLevel: "debug" },
    });
    expect(resolveGitHubPoll(s, app)).toEqual({
      activeSeconds: 20,
      quietSeconds: 120,
      staleThresholdSeconds: 600,
    });
    expect(resolveHeartbeatSeconds(s, app)).toBe(0);
    expect(resolveBrowserFramerate(s, app)).toBe(24);
    expect(resolveLogLevel(s, app)).toBe("debug");
  });

  it("never resolves a frame rate below 1, even from a bad env value", () => {
    const zeroEnv = {
      config: { ...app.config, BROWSER_FRAMERATE: 0 },
    } as unknown as FastifyInstance;
    expect(resolveBrowserFramerate(DEFAULT_SETTINGS, zeroEnv)).toBe(1);
  });

  it("converts poll seconds to tracker milliseconds", () => {
    expect(
      toActivityIntervals({ activeSeconds: 15, quietSeconds: 60, staleThresholdSeconds: 300 }),
    ).toEqual({ activeIntervalMs: 15_000, quietIntervalMs: 60_000, staleThresholdMs: 300_000 });
  });

  it("resolves the boot-time knobs against env", () => {
    expect(resolveBrowserMaxInstances(DEFAULT_SETTINGS, app)).toBe(4);
    expect(resolveDeviceDiscoveryEnabled(DEFAULT_SETTINGS, app)).toBe(true);
    const s = withOverrides({
      browser: { framerate: -1, maxInstances: 8 },
      devices: { ...DEFAULT_SETTINGS.devices, discoveryEnabled: "off" },
    });
    expect(resolveBrowserMaxInstances(s, app)).toBe(8);
    expect(resolveDeviceDiscoveryEnabled(s, app)).toBe(false);
    const on = withOverrides({
      devices: { ...DEFAULT_SETTINGS.devices, discoveryEnabled: "on" },
    });
    expect(
      resolveDeviceDiscoveryEnabled(on, {
        config: { ...app.config, DEVICE_DISCOVERY_ENABLED: false },
      } as unknown as FastifyInstance),
    ).toBe(true);
  });

  it("resolves emulator launch flags from settings, then env", () => {
    expect(resolveDeviceEmulatorLaunch(DEFAULT_SETTINGS, app)).toEqual({
      headless: true,
      gpu: "swiftshader_indirect",
    });
    const overridden = withOverrides({
      devices: { ...DEFAULT_SETTINGS.devices, emulatorHeadless: "off", emulatorGpu: "host" },
    });
    expect(resolveDeviceEmulatorLaunch(overridden, app)).toEqual({ headless: false, gpu: "host" });
    const windowedEnv = {
      config: { ...app.config, DEVICE_EMULATOR_HEADLESS: false, DEVICE_EMULATOR_GPU: "auto" },
    } as unknown as FastifyInstance;
    expect(resolveDeviceEmulatorLaunch(DEFAULT_SETTINGS, windowedEnv)).toEqual({
      headless: false,
      gpu: "auto",
    });
    const forcedHeadless = withOverrides({
      devices: { ...DEFAULT_SETTINGS.devices, emulatorHeadless: "on" },
    });
    expect(resolveDeviceEmulatorLaunch(forcedHeadless, windowedEnv).headless).toBe(true);
  });
});
