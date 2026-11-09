import { describe, it, expect, vi, beforeEach } from "vitest";
import { jsonResponse } from "../test/jsonResponse.js";
import { sessionsApi } from "./sessions.js";
import { setReportedPalette } from "../lib/reportedPalette.js";

describe("sessionsApi.uploadSessionFile", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue(jsonResponse(200, { path: "/p" }));
    vi.stubGlobal("fetch", fetchMock);
  });

  function lastHeaders(): Headers {
    const [, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    return new Headers(init.headers);
  }

  it("sends a recognized image under its own mime, with no filename header", async () => {
    await sessionsApi.uploadSessionFile(3, new Blob(["x"], { type: "image/png" }), "a.png");

    expect(fetchMock.mock.calls[0]![0]).toContain("/api/sessions/3/uploads");
    expect(lastHeaders().get("content-type")).toBe("image/png");
    expect(lastHeaders().get("x-upload-filename")).toBeNull();
  });

  it("sends anything else as octet-stream with the URI-encoded original name", async () => {
    await sessionsApi.uploadSessionFile(
      3,
      new Blob(["x"], { type: "application/pdf" }),
      "Q3 résumé.pdf",
    );

    expect(lastHeaders().get("content-type")).toBe("application/octet-stream");
    expect(decodeURIComponent(lastHeaders().get("x-upload-filename")!)).toBe("Q3 résumé.pdf");
  });

  it("falls back to the name `file` when none is given", async () => {
    await sessionsApi.uploadSessionFile(3, new Blob(["x"], { type: "image/svg+xml" }));

    expect(lastHeaders().get("x-upload-filename")).toBe("file");
  });

  it("asGeneric sends even a recognized image mime as octet-stream with the name", async () => {
    await sessionsApi.uploadSessionFile(3, new Blob(["x"], { type: "image/png" }), "a.png", {
      asGeneric: true,
    });

    expect(lastHeaders().get("content-type")).toBe("application/octet-stream");
    expect(lastHeaders().get("x-upload-filename")).toBe("a.png");
  });
});

describe("sessionsApi create/promote carry the dashboard's palette (#2528)", () => {
  const fetchMock = vi.fn();
  const PALETTE = { foreground: "#1d1d1d", background: "#f2f2f2", cursor: "#1d1d1d" };
  beforeEach(() => {
    fetchMock.mockReset().mockImplementation(async () => jsonResponse(201, {}));
    vi.stubGlobal("fetch", fetchMock);
  });
  const lastBody = () =>
    JSON.parse((fetchMock.mock.calls.at(-1) as [string, RequestInit])[1].body as string);

  it("sends the reported palette on create and on promote", async () => {
    setReportedPalette(PALETTE);
    await sessionsApi.createSession(1, "bash");
    expect(lastBody().palette).toEqual(PALETTE);
    await sessionsApi.promoteSession(1, { baseRef: "main" });
    expect(lastBody().palette).toEqual(PALETTE);
  });

  it("sends none when no palette has been reported", async () => {
    setReportedPalette(undefined);
    await sessionsApi.createSession(1, "bash");
    expect("palette" in lastBody()).toBe(false);
  });
});
