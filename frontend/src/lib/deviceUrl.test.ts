import { describe, expect, it } from "vitest";
import type { Device } from "../api/index.js";
import {
  deviceDevServerRoute,
  deviceOpenUrl,
  deviceTargetRoute,
  isOpenableDevice,
} from "./deviceUrl.js";

describe("deviceOpenUrl", () => {
  it("targets 127.0.0.1 with the address's port and path for a same-host device", () => {
    expect(deviceOpenUrl("http://localhost:3005/", { hostId: "local" }, "local")).toBe(
      "http://127.0.0.1:3005/",
    );
    expect(deviceOpenUrl("http://dev.example.com:5173/app", { hostId: "mac" }, "mac")).toBe(
      "http://127.0.0.1:5173/app",
    );
  });

  it("forces http, since an https certificate cannot match 127.0.0.1", () => {
    expect(deviceOpenUrl("https://localhost:8443/", { hostId: "local" }, "local")).toBe(
      "http://127.0.0.1:8443/",
    );
  });

  it("keeps an https default port instead of silently moving it to 80", () => {
    expect(deviceOpenUrl("https://localhost/x", { hostId: "local" }, "local")).toBe(
      "http://127.0.0.1:443/x",
    );
    expect(deviceOpenUrl("http://localhost/x", { hostId: "local" }, "local")).toBe(
      "http://127.0.0.1/x",
    );
  });

  it("refuses a device on a different host than the dev server", () => {
    expect(deviceOpenUrl("http://localhost:3005/", { hostId: "mac-1" }, "local")).toBeNull();
  });

  it("refuses a malformed or non-http address", () => {
    expect(deviceOpenUrl("not a url", { hostId: "local" }, "local")).toBeNull();
    expect(deviceOpenUrl("ftp://localhost/x", { hostId: "local" }, "local")).toBeNull();
  });
});

describe("device route selection (#3491)", () => {
  const on = { previewsEnabled: true, previewBaseHost: "mullion.example.com" };
  const off = { previewsEnabled: false, previewBaseHost: "" };

  it("same host as the dev server: its loopback URL, previews or not", () => {
    for (const previews of [on, off, "loading" as const, "failed" as const]) {
      expect(
        deviceDevServerRoute("http://localhost:3005/", { hostId: "mac" }, "mac", previews),
      ).toEqual({ kind: "direct", url: "http://127.0.0.1:3005/" });
    }
  });

  it("other host than the dev server: the preview URL when previews are enabled", () => {
    expect(deviceDevServerRoute("http://localhost:3005/", { hostId: "mac" }, "local", on)).toEqual({
      kind: "preview",
    });
  });

  it("same host with an unusable address: unavailable, never the preview", () => {
    const route = deviceDevServerRoute("ftp://localhost/x", { hostId: "mac" }, "mac", on);
    expect(route.kind === "unavailable" && route.reason).toMatch(/not an http\(s\) URL/);
  });

  it("other host, previews off: unavailable, with the reason", () => {
    const route = deviceDevServerRoute("http://localhost:3005/", { hostId: "mac" }, "local", off);
    expect(route.kind === "unavailable" && route.reason).toMatch(/Previews are not enabled/);
  });

  it("settings still loading or unreadable: unavailable, never reported as previews off", () => {
    const loading = deviceTargetRoute({ hostId: "mac" }, "loading");
    expect(loading.kind === "unavailable" && loading.reason).toMatch(/Checking/);
    const failed = deviceTargetRoute({ hostId: "mac" }, "failed");
    expect(failed.kind === "unavailable" && failed.reason).toMatch(/Could not read/);
  });

  it("a named target always goes through its preview, on any host", () => {
    expect(deviceTargetRoute({ hostId: "local" }, on)).toEqual({ kind: "preview" });
    expect(deviceTargetRoute({ hostId: "mac" }, on)).toEqual({ kind: "preview" });
    expect(deviceTargetRoute({ hostId: "local" }, off)).toMatchObject({ kind: "unavailable" });
  });

  it("a loopback preview host is unreachable from a device on an agent host", () => {
    for (const previewBaseHost of [
      "localhost:3000",
      "dev.localhost",
      "127.0.0.1",
      "[::1]:80",
      "::1",
      "0.0.0.0:8080",
    ]) {
      const route = deviceTargetRoute(
        { hostId: "mac" },
        { previewsEnabled: true, previewBaseHost },
      );
      expect(route.kind === "unavailable" && route.reason).toMatch(/loopback/);
      expect(
        deviceTargetRoute({ hostId: "local" }, { previewsEnabled: true, previewBaseHost }),
      ).toEqual({ kind: "preview" });
    }
  });

  it("a device that is still starting or booting is unavailable, with the reason (#3559)", () => {
    for (const status of ["starting", "booting"] as const) {
      const live = { status } as NonNullable<Device["live"]>;
      const direct = deviceDevServerRoute(
        "http://localhost:3005/",
        { hostId: "local", live },
        "local",
        on,
      );
      expect(direct.kind === "unavailable" && direct.reason).toMatch(/still booting/);
      const target = deviceTargetRoute({ hostId: "local", live }, on);
      expect(target.kind === "unavailable" && target.reason).toMatch(/still booting/);
    }
    const live = { status: "streaming" } as NonNullable<Device["live"]>;
    expect(deviceTargetRoute({ hostId: "local", live }, on)).toEqual({ kind: "preview" });
  });
});

describe("isOpenableDevice (#3559)", () => {
  const base = {
    id: 1,
    hostId: "local",
    projectId: null,
    name: "Pixel",
    kind: "emulator",
    avdName: "pixel",
    serial: null,
    udid: null,
    status: "active",
    createdAt: "2026-01-01",
  } as const;
  const live = (status: string) => ({ status }) as unknown as Device["live"];

  it("lists a running iOS Simulator and a running Android device", () => {
    expect(isOpenableDevice({ ...base, platform: "ios", live: live("streaming") } as Device)).toBe(
      true,
    );
    expect(
      isOpenableDevice({ ...base, platform: "android", live: live("streaming") } as Device),
    ).toBe(true);
    expect(
      isOpenableDevice({ ...base, platform: "android", live: live("booting") } as Device),
    ).toBe(true);
  });

  it("skips a stopped, exited or failed device", () => {
    expect(isOpenableDevice({ ...base, platform: "android", live: null } as Device)).toBe(false);
    expect(
      isOpenableDevice({
        ...base,
        platform: "android",
        status: "killed",
        live: live("streaming"),
      } as Device),
    ).toBe(false);
    expect(isOpenableDevice({ ...base, platform: "android", live: live("exited") } as Device)).toBe(
      false,
    );
    expect(isOpenableDevice({ ...base, platform: "ios", live: live("error") } as Device)).toBe(
      false,
    );
  });
});
