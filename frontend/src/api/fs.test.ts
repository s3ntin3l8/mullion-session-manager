import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse } from "../test/jsonResponse.js";
import { fsApi } from "./fs.js";

afterEach(() => vi.unstubAllGlobals());

describe("directory listing API", () => {
  it("requests hidden folders only when enabled and encodes the path", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(200, {})));
    vi.stubGlobal("fetch", fetchMock);
    await fsApi.listDirectories("/home/a & b");
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/fs/dirs?path=%2Fhome%2Fa%20%26%20b",
      expect.any(Object),
    );
    await fsApi.listDirectories("/home/a & b", { hidden: true });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/fs/dirs?path=%2Fhome%2Fa%20%26%20b&hidden=1",
      expect.any(Object),
    );
    await fsApi.listDirectories("/srv", { hostId: "h 1" });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/fs/dirs?path=%2Fsrv&hostId=h%201",
      expect.any(Object),
    );
  });
});
