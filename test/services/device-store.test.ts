import { describe, expect, it } from "vitest";
import { buildTestApp } from "../helpers/app.js";
import { createPairedHost } from "../../src/services/host-registry.js";
import {
  deleteDeviceRow,
  findActiveIosOwner,
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

  it("findActiveIosOwner only sees an ACTIVE iOS row for that UDID on that host", async () => {
    const app = await setup();
    const udid = "0F4A9B7E-1111-2222-3333-444455556666";
    const ios = (hostId?: string) => ({
      kind: "emulator" as const,
      platform: "ios" as const,
      udid,
      serial: null,
      avdName: null,
      projectId: null,
      name: null,
      ...(hostId ? { hostId } : {}),
    });
    const mac2 = createPairedHost(app, {
      hostname: "mac-2",
      name: "mac-2",
      baseUrl: "http://mac2.test",
    }).hostId;
    const row = insertDevice(app, ios());
    expect(findActiveIosOwner(app, udid)).toEqual({ id: row.id });
    expect(findActiveIosOwner(app, "1A2B3C4D-1111-2222-3333-444455556666")).toBeUndefined();
    // Another host's simulator with the same UDID is another simulator.
    expect(findActiveIosOwner(app, udid, mac2)).toBeUndefined();
    const other = insertDevice(app, ios(mac2));
    expect(findActiveIosOwner(app, udid, mac2)).toEqual({ id: other.id });

    setDeviceStatus(app, row.id, "killed");
    expect(findActiveIosOwner(app, udid)).toBeUndefined();
  });
});
