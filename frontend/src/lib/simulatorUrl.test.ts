import { describe, expect, it } from "vitest";
import { simulatorOpenUrl } from "./simulatorUrl.js";

describe("simulatorOpenUrl", () => {
  it("turns a bare port into a loopback URL for a same-host simulator", () => {
    expect(simulatorOpenUrl("3005", { hostId: "local" }, "local")).toBe("http://127.0.0.1:3005/");
  });

  it("keeps scheme, port and path of a full URL but always targets 127.0.0.1", () => {
    expect(simulatorOpenUrl("http://localhost:5173/app", { hostId: "local" }, "local")).toBe(
      "http://127.0.0.1:5173/app",
    );
    expect(simulatorOpenUrl("https://dev.example.com:8443", { hostId: "mac" }, "mac")).toBe(
      "https://127.0.0.1:8443/",
    );
  });

  it("refuses a simulator on a different host than the dev server", () => {
    expect(simulatorOpenUrl("3005", { hostId: "mac-1" }, "local")).toBeNull();
  });

  it("refuses an out-of-range port, a malformed value and a non-http URL", () => {
    expect(simulatorOpenUrl("70000", { hostId: "local" }, "local")).toBeNull();
    expect(simulatorOpenUrl("0", { hostId: "local" }, "local")).toBeNull();
    expect(simulatorOpenUrl("not a url", { hostId: "local" }, "local")).toBeNull();
    expect(simulatorOpenUrl("ftp://localhost/x", { hostId: "local" }, "local")).toBeNull();
  });
});
