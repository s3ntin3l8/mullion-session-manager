import { describe, expect, it } from "vitest";
import { buildTestApp } from "../helpers/app.js";
import {
  deleteDeviceRow,
  findActivePhysicalOwner,
  getDeviceRow,
  insertDevice,
  listDeviceRows,
  setDeviceStatus,
  updateDeviceSerial,
} from "../../src/services/device-store.js";

describe("device-store", () => {
  async function setup() {
    const app = await buildTestApp();
    await app.ready();
    return app;
  }

  const phys = (serial: string) => ({
    kind: "physical" as const,
    serial,
    avdName: null,
    projectId: null,
    name: null,
  });

  it("inserts, reads, lists, updates and deletes a row", async () => {
    const app = await setup();
    const row = insertDevice(app, phys("10.0.0.1:5555"));
    expect(row.status).toBe("active");
    expect(getDeviceRow(app, row.id)?.serial).toBe("10.0.0.1:5555");
    expect(listDeviceRows(app).map((r) => r.id)).toContain(row.id);

    expect(updateDeviceSerial(app, row.id, "10.0.0.1:6666").serial).toBe("10.0.0.1:6666");

    deleteDeviceRow(app, row.id);
    expect(getDeviceRow(app, row.id)).toBeUndefined();
  });

  it("findActivePhysicalOwner only sees an ACTIVE physical row at that address", async () => {
    const app = await setup();
    const row = insertDevice(app, phys("10.0.0.2:5555"));
    expect(findActivePhysicalOwner(app, "10.0.0.2:5555")).toEqual({ id: row.id });
    expect(findActivePhysicalOwner(app, "10.0.0.9:1")).toBeUndefined();

    setDeviceStatus(app, row.id, "killed");
    expect(getDeviceRow(app, row.id)?.status).toBe("killed");
    expect(findActivePhysicalOwner(app, "10.0.0.2:5555")).toBeUndefined();

    setDeviceStatus(app, row.id, "active");
    expect(findActivePhysicalOwner(app, "10.0.0.2:5555")).toEqual({ id: row.id });
  });
});
