import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { devices } from "../db/schema.js";

// The `devices` table's read/write seam: routes/device.ts and routes/devices.ts
// go through these instead of querying `app.db` themselves (the routes>db
// import boundary). Every function is synchronous on purpose — better-sqlite3
// is synchronous, and the routes' check-then-write guards (the active-address
// collision check before an insert/update) rely on there being no `await`
// between the two.

export type DeviceRow = typeof devices.$inferSelect;
export type NewDevice = Pick<
  typeof devices.$inferInsert,
  "kind" | "serial" | "avdName" | "projectId" | "name"
>;

export function getDeviceRow(app: FastifyInstance, id: number): DeviceRow | undefined {
  const [row] = app.db.select().from(devices).where(eq(devices.id, id)).all();
  return row;
}

export function listDeviceRows(app: FastifyInstance): DeviceRow[] {
  return app.db.select().from(devices).all();
}

/** The id of the ACTIVE physical row that already owns this adb address, if any. */
export function findActivePhysicalOwner(
  app: FastifyInstance,
  address: string,
): { id: number } | undefined {
  const [owner] = app.db
    .select({ id: devices.id })
    .from(devices)
    .where(
      and(eq(devices.status, "active"), eq(devices.kind, "physical"), eq(devices.serial, address)),
    )
    .all();
  return owner;
}

export function insertDevice(app: FastifyInstance, values: NewDevice): DeviceRow {
  const [row] = app.db.insert(devices).values(values).returning().all();
  return row;
}

/** Repoints a row's stored adb address; returns the updated row. */
export function updateDeviceSerial(app: FastifyInstance, id: number, serial: string): DeviceRow {
  const [updated] = app.db
    .update(devices)
    .set({ serial })
    .where(eq(devices.id, id))
    .returning()
    .all();
  return updated as DeviceRow; // the caller just read this id; a missing row is its race to handle
}

export function setDeviceStatus(
  app: FastifyInstance,
  id: number,
  status: "active" | "killed",
): void {
  app.db.update(devices).set({ status }).where(eq(devices.id, id)).run();
}

export function deleteDeviceRow(app: FastifyInstance, id: number): void {
  app.db.delete(devices).where(eq(devices.id, id)).run();
}
