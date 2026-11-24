import { describe, expect, it } from "vitest";
import { simulatorOpenUrl } from "./simulatorUrl.js";

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
