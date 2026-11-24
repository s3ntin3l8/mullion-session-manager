import { describe, expect, it } from "vitest";
import { simulatorDevServerRoute, simulatorOpenUrl, simulatorTargetRoute } from "./simulatorUrl.js";

describe("simulatorOpenUrl", () => {
  it("targets 127.0.0.1 with the address's port and path for a same-host simulator", () => {
    expect(simulatorOpenUrl("http://localhost:3005/", { hostId: "local" }, "local")).toBe(
      "http://127.0.0.1:3005/",
    );
    expect(simulatorOpenUrl("http://dev.example.com:5173/app", { hostId: "mac" }, "mac")).toBe(
      "http://127.0.0.1:5173/app",
    );
  });

  it("forces http, since an https certificate cannot match 127.0.0.1", () => {
    expect(simulatorOpenUrl("https://localhost:8443/", { hostId: "local" }, "local")).toBe(
      "http://127.0.0.1:8443/",
    );
  });

  it("keeps an https default port instead of silently moving it to 80", () => {
    expect(simulatorOpenUrl("https://localhost/x", { hostId: "local" }, "local")).toBe(
      "http://127.0.0.1:443/x",
    );
    expect(simulatorOpenUrl("http://localhost/x", { hostId: "local" }, "local")).toBe(
      "http://127.0.0.1/x",
    );
  });

  it("refuses a simulator on a different host than the dev server", () => {
    expect(simulatorOpenUrl("http://localhost:3005/", { hostId: "mac-1" }, "local")).toBeNull();
  });

  it("refuses a malformed or non-http address", () => {
    expect(simulatorOpenUrl("not a url", { hostId: "local" }, "local")).toBeNull();
    expect(simulatorOpenUrl("ftp://localhost/x", { hostId: "local" }, "local")).toBeNull();
  });
});

describe("simulator route selection (#3491)", () => {
  const on = { previewsEnabled: true, previewBaseHost: "mullion.example.com" };
  const off = { previewsEnabled: false, previewBaseHost: "" };

  it("same host as the dev server: its loopback URL, previews or not", () => {
    for (const previews of [on, off, null]) {
      expect(
        simulatorDevServerRoute("http://localhost:3005/", { hostId: "mac" }, "mac", previews),
      ).toEqual({ kind: "direct", url: "http://127.0.0.1:3005/" });
    }
  });

  it("other host than the dev server: the preview URL when previews are enabled", () => {
    expect(
      simulatorDevServerRoute("http://localhost:3005/", { hostId: "mac" }, "local", on),
    ).toEqual({ kind: "preview" });
  });

  it("other host, previews off or not known yet: unavailable, with the reason", () => {
    for (const previews of [off, null]) {
      const route = simulatorDevServerRoute(
        "http://localhost:3005/",
        { hostId: "mac" },
        "local",
        previews,
      );
      expect(route).toMatchObject({ kind: "unavailable" });
      expect(route.kind === "unavailable" && route.reason).toMatch(/Previews are not enabled/);
    }
  });

  it("a named target always goes through its preview, on any host", () => {
    expect(simulatorTargetRoute({ hostId: "local" }, on)).toEqual({ kind: "preview" });
    expect(simulatorTargetRoute({ hostId: "mac" }, on)).toEqual({ kind: "preview" });
    expect(simulatorTargetRoute({ hostId: "local" }, off)).toMatchObject({ kind: "unavailable" });
  });

  it("a loopback preview host is unreachable from a simulator on an agent host", () => {
    for (const previewBaseHost of ["localhost:3000", "dev.localhost", "127.0.0.1", "[::1]:80"]) {
      const route = simulatorTargetRoute(
        { hostId: "mac" },
        { previewsEnabled: true, previewBaseHost },
      );
      expect(route.kind === "unavailable" && route.reason).toMatch(/loopback/);
      expect(
        simulatorTargetRoute({ hostId: "local" }, { previewsEnabled: true, previewBaseHost }),
      ).toEqual({ kind: "preview" });
    }
  });
});
