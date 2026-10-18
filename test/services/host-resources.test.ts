import type os from "node:os";
import { describe, it, expect } from "vitest";
import {
  getAvailableHostCores,
  computeTaskMasterCpuQuota,
  computeAdaptiveWorkers,
} from "../../src/services/host-resources.js";

describe("host-resources", () => {
  describe("getAvailableHostCores", () => {
    it("returns a positive integer representing host cores", () => {
      const cores = getAvailableHostCores();
      expect(Number.isInteger(cores)).toBe(true);
      expect(cores).toBeGreaterThan(0);
    });

    it("falls back to os.cpus() when availableParallelism is undefined or returns non-positive", () => {
      const mockOs = {
        availableParallelism: undefined,
        cpus: () => Array.from({ length: 6 }, () => ({} as os.CpuInfo)),
      } as unknown as typeof os;
      expect(getAvailableHostCores(mockOs)).toBe(6);

      const mockOsNonPositive = {
        availableParallelism: () => 0,
        cpus: () => Array.from({ length: 2 }, () => ({} as os.CpuInfo)),
      } as unknown as typeof os;
      expect(getAvailableHostCores(mockOsNonPositive)).toBe(2);
    });

    it("falls back to 4 when both availableParallelism and cpus() fail or return empty", () => {
      const mockOsEmpty = {
        availableParallelism: undefined,
        cpus: () => [] as os.CpuInfo[],
      } as unknown as typeof os;
      expect(getAvailableHostCores(mockOsEmpty)).toBe(4);

      const mockOsThrow = {
        availableParallelism: () => {
          throw new Error("unsupported");
        },
        cpus: () => {
          throw new Error("procfs unreadable");
        },
      } as unknown as typeof os;
      expect(getAvailableHostCores(mockOsThrow)).toBe(4);
    });
  });

  describe("computeTaskMasterCpuQuota", () => {
    it("calculates ~45% quota with a floor of 2 cores (200%)", () => {
      expect(computeTaskMasterCpuQuota(2)).toBe(200);
      expect(computeTaskMasterCpuQuota(4)).toBe(200);
      expect(computeTaskMasterCpuQuota(8)).toBe(300); // floor(8 * 0.45) = 3 -> 300%
      expect(computeTaskMasterCpuQuota(10)).toBe(400); // floor(10 * 0.45) = 4 -> 400%
      expect(computeTaskMasterCpuQuota(14)).toBe(600); // floor(14 * 0.45) = 6 -> 600%
      expect(computeTaskMasterCpuQuota(16)).toBe(700); // floor(16 * 0.45) = 7 -> 700%
      expect(computeTaskMasterCpuQuota(32)).toBe(1400); // floor(32 * 0.45) = 14 -> 1400%
      expect(computeTaskMasterCpuQuota(64)).toBe(2800); // floor(64 * 0.45) = 28 -> 2800%
    });
  });

  describe("computeAdaptiveWorkers", () => {
    it("gives full burst capacity on an idle host (load < 35%)", () => {
      expect(computeAdaptiveWorkers(14, 0)).toBe(14);
      expect(computeAdaptiveWorkers(14, 2.5)).toBe(14);
      expect(computeAdaptiveWorkers(8, 1.0)).toBe(8);
      expect(computeAdaptiveWorkers(4, 0.5)).toBe(4);
    });

    it("gives half capacity under moderate load (35% <= load < 75%)", () => {
      expect(computeAdaptiveWorkers(14, 6.0)).toBe(7); // ceil(14/2) = 7
      expect(computeAdaptiveWorkers(8, 4.0)).toBe(4);
      expect(computeAdaptiveWorkers(4, 2.0)).toBe(2);
    });

    it("gives conservative floor under high contention (load >= 75%)", () => {
      expect(computeAdaptiveWorkers(14, 12.0)).toBe(3); // floor(14/4) = 3
      expect(computeAdaptiveWorkers(14, 25.0)).toBe(3);
      expect(computeAdaptiveWorkers(8, 7.0)).toBe(2);
      expect(computeAdaptiveWorkers(4, 3.5)).toBe(2); // min 2
    });
  });
});
