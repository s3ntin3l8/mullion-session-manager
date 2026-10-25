// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { filesApi } from "./files.js";
import { ApiError } from "./client.js";

class FakeXhr {
  static last: FakeXhr;
  method = "";
  url = "";
  headers: Record<string, string> = {};
  sent: unknown;
  status = 0;
  responseText = "";
  aborted = false;
  upload: {
    onprogress?: (e: { lengthComputable: boolean; loaded: number; total: number }) => void;
  } = {};
  onload?: () => void;
  onerror?: () => void;
  onabort?: () => void;
  constructor() {
    FakeXhr.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  send(body: unknown) {
    this.sent = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  finish(status: number, body: string) {
    this.status = status;
    this.responseText = body;
    this.onload?.();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("filesApi transfer", () => {
  it("builds a same-origin download URL with the path and session encoded", () => {
    expect(filesApi.projectFileDownloadUrl(3, "a b/c&d.txt")).toBe(
      "/api/projects/3/files/download?path=a%20b%2Fc%26d.txt",
    );
    expect(filesApi.projectFileDownloadUrl(3, "x", 9)).toBe(
      "/api/projects/3/files/download?path=x&sessionId=9",
    );
  });

  describe("uploadProjectFile", () => {
    const file = new File(["abc"], "a.bin");

    it("posts the file body as octet-stream and resolves with the result", async () => {
      vi.stubGlobal("XMLHttpRequest", FakeXhr);
      const onProgress = vi.fn();
      const p = filesApi.uploadProjectFile(3, "d/a.bin", file, {
        sessionId: 7,
        mkdirs: true,
        onProgress,
      });
      const xhr = FakeXhr.last;
      expect(xhr.method).toBe("POST");
      expect(xhr.url).toBe("/api/projects/3/files/upload?path=d%2Fa.bin&mkdirs=1&sessionId=7");
      expect(xhr.headers["Content-Type"]).toBe("application/octet-stream");
      expect(xhr.sent).toBe(file);
      xhr.upload.onprogress?.({ lengthComputable: true, loaded: 2, total: 3 });
      xhr.upload.onprogress?.({ lengthComputable: false, loaded: 0, total: 0 });
      expect(onProgress).toHaveBeenCalledTimes(1);
      expect(onProgress).toHaveBeenCalledWith(2, 3);
      xhr.finish(200, JSON.stringify({ path: "d/a.bin", size: 3 }));
      await expect(p).resolves.toEqual({ path: "d/a.bin", size: 3 });
    });

    it("rejects with the server's message and code", async () => {
      vi.stubGlobal("XMLHttpRequest", FakeXhr);
      const p = filesApi.uploadProjectFile(3, "a.bin", file);
      FakeXhr.last.finish(409, JSON.stringify({ message: "exists", code: "conflict" }));
      const err = (await p.catch((e: unknown) => e)) as ApiError;
      expect(err).toBeInstanceOf(ApiError);
      expect(err).toMatchObject({ statusCode: 409, code: "conflict", message: "exists" });
    });

    it("falls back to a generic message for a non-JSON error body", async () => {
      vi.stubGlobal("XMLHttpRequest", FakeXhr);
      const p = filesApi.uploadProjectFile(3, "a.bin", file);
      FakeXhr.last.finish(502, "<html>Bad gateway</html>");
      const err = (await p.catch((e: unknown) => e)) as ApiError;
      expect(err.statusCode).toBe(502);
      expect(err.code).toBeUndefined();
      expect(err.message).toMatch(/502/);
    });

    it("rejects an unparseable success body", async () => {
      vi.stubGlobal("XMLHttpRequest", FakeXhr);
      const p = filesApi.uploadProjectFile(3, "a.bin", file);
      FakeXhr.last.finish(200, "not json");
      await expect(p).rejects.toBeInstanceOf(ApiError);
    });

    it("rejects on a network error", async () => {
      vi.stubGlobal("XMLHttpRequest", FakeXhr);
      const p = filesApi.uploadProjectFile(3, "a.bin", file);
      FakeXhr.last.onerror?.();
      await expect(p).rejects.toMatchObject({ statusCode: 0 });
    });

    it("aborts the request when the signal fires, rejecting with AbortError", async () => {
      vi.stubGlobal("XMLHttpRequest", FakeXhr);
      const controller = new AbortController();
      const p = filesApi.uploadProjectFile(3, "a.bin", file, { signal: controller.signal });
      controller.abort();
      expect(FakeXhr.last.aborted).toBe(true);
      await expect(p).rejects.toMatchObject({ name: "AbortError" });
    });

    it("rejects immediately, without sending, when already aborted", async () => {
      vi.stubGlobal("XMLHttpRequest", FakeXhr);
      const controller = new AbortController();
      controller.abort();
      const p = filesApi.uploadProjectFile(3, "a.bin", file, { signal: controller.signal });
      await expect(p).rejects.toMatchObject({ name: "AbortError" });
      expect(FakeXhr.last.sent).toBeUndefined();
    });
  });

  describe("fetchProjectFileBlob", () => {
    it("returns the bytes, retyped to the caller's type", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response("<svg/>", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const blob = await filesApi.fetchProjectFileBlob(3, "i.svg", {
        sessionId: 2,
        type: "image/svg+xml",
      });
      expect(fetchMock.mock.calls[0]![0]).toBe(
        "/api/projects/3/files/download?path=i.svg&sessionId=2",
      );
      expect(blob.type).toBe("image/svg+xml");
      expect(await blob.text()).toBe("<svg/>");
    });

    it("throws an ApiError carrying the server code on failure", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ message: "too big", code: "too_large" }), {
            status: 413,
          }),
        ),
      );
      await expect(filesApi.fetchProjectFileBlob(3, "big")).rejects.toMatchObject({
        statusCode: 413,
        code: "too_large",
      });
    });
  });
});
