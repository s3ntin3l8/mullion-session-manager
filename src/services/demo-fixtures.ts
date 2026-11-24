import type { FastifyInstance } from "fastify";
import { devices, tasks, TASK_STATUSES } from "../db/schema.js";
import type { IosSimulator, SimulatorCatalog } from "./ios-simulators.js";

export { TASK_STATUSES };

/**
 * Insert demo task rows in one transaction (all or nothing: a throw on fixture
 * N, e.g. the unique (project_id, issue_number) index, leaves none behind).
 * `valuesFor` builds each row's insert values.
 */
export function insertDemoTasks(
  app: FastifyInstance,
  valuesFor: Array<Record<string, unknown>>,
): Array<typeof tasks.$inferSelect> {
  return app.db.transaction((tx) =>
    valuesFor.map((values) =>
      tx
        .insert(tasks)
        .values(values as typeof tasks.$inferInsert)
        .returning()
        .get(),
    ),
  );
}

// Settings → Devices fixtures. The demo has no adb and no Xcode, so the local
// host answers `GET /api/simulators` (and its catalog) from these when
// MULLION_DEMO is set (services/device-host.ts), and the seed inserts the rows
// that name them. Timestamps are fixed so a baseline never moves with the clock.
export const DEMO_SIMULATORS: IosSimulator[] = [
  {
    udid: "6D1F3A52-8C47-4E0B-9A31-5B7E2C4D9F10",
    name: "iPhone 16 Pro",
    runtime: "iOS 18.2",
    state: "Booted",
    deviceTypeId: "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro",
    lastBootedAt: "2026-09-30T08:12:00Z",
  },
  {
    udid: "A83B7C19-2D5E-4F60-8B14-0E9D6A3C7F21",
    name: "iPad Pro 13-inch (M4)",
    runtime: "iOS 18.2",
    state: "Shutdown",
    deviceTypeId: "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M4-8GB",
    lastBootedAt: "2026-09-24T15:40:00Z",
  },
  {
    udid: "C4E92D08-7A13-4B5C-9E67-1F8A3D5B2C32",
    name: "iPhone 16",
    runtime: "iOS 18.2",
    state: "Shutdown",
    deviceTypeId: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
  },
  {
    udid: "E1A5F6B3-9C28-4D71-A053-7B2E8C4F6D43",
    name: "iPhone SE (3rd generation)",
    runtime: "iOS 17.5",
    state: "Shutdown",
    deviceTypeId: "com.apple.CoreSimulator.SimDeviceType.iPhone-SE-3rd-generation",
  },
];

export const DEMO_SIMULATOR_CATALOG: SimulatorCatalog = {
  deviceTypes: [
    { id: "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro", name: "iPhone 16 Pro" },
    { id: "com.apple.CoreSimulator.SimDeviceType.iPhone-16", name: "iPhone 16" },
    {
      id: "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M4-8GB",
      name: "iPad Pro 13-inch (M4)",
    },
  ],
  runtimes: [
    { id: "com.apple.CoreSimulator.SimRuntime.iOS-18-2", name: "iOS 18.2" },
    { id: "com.apple.CoreSimulator.SimRuntime.iOS-17-5", name: "iOS 17.5" },
  ],
};

/** Inserts demo device rows (an emulator, a phone, a simulator) in one transaction. */
export function insertDemoDevices(
  app: FastifyInstance,
  valuesFor: Array<Record<string, unknown>>,
): Array<typeof devices.$inferSelect> {
  return app.db.transaction((tx) =>
    valuesFor.map((values) =>
      tx
        .insert(devices)
        .values(values as typeof devices.$inferInsert)
        .returning()
        .get(),
    ),
  );
}
