import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, opendir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type * as FsPromises from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof FsPromises>();
  return { ...original, opendir: vi.fn(original.opendir) };
});

let app: FastifyInstance;
let root: string;
const headers = { authorization: "Bearer fs-test-token" };

async function list(path: string, hidden = false) {
  return app.inject({
    method: "GET",
    url: `/api/fs/dirs?path=${encodeURIComponent(path)}${hidden ? "&hidden=1" : ""}`,
    headers,
  });
}

describe("GET /api/fs/dirs", () => {
  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "mullion-fs-test-")));
    process.env.DATABASE_URL = `file:${join(root, "test.db")}`;
    process.env.MULLION_AUTH_TOKEN = "fs-test-token";
    process.env.MULLION_SESSION_SECRET = "fs-test-session-secret"; // pragma: allowlist secret
    await mkdir(join(root, "beta"));
    await mkdir(join(root, "alpha"));
    await mkdir(join(root, ".hidden"));
    await writeFile(join(root, "private-file.txt"), "never return this");
    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    closeDb();
    await rm(root, { recursive: true, force: true });
    delete process.env.DATABASE_URL;
    delete process.env.MULLION_AUTH_TOKEN;
    delete process.env.MULLION_SESSION_SECRET;
  });

  it("lists sorted immediate directories only, hides dotfolders, and returns the parent", async () => {
    const res = await list(root);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      path: root,
      parent: dirname(root),
      directories: [
        { name: "alpha", path: join(root, "alpha") },
        { name: "beta", path: join(root, "beta") },
      ],
      truncated: false,
    });
  });

  it("includes hidden directories only when requested", async () => {
    const res = await list(root, true);
    expect(res.json().directories.map((entry: { name: string }) => entry.name)).toEqual([
      ".hidden",
      "alpha",
      "beta",
    ]);
  });

  it("returns a message and 4xx for nonexistent paths and files", async () => {
    for (const path of [join(root, "missing"), join(root, "private-file.txt")]) {
      const res = await list(path);
      expect(res.statusCode).toBe(404);
      expect(res.json().message).toBe("Directory does not exist.");
      expect(res.body).not.toContain("private-file.txt");
    }
  });

  it("returns a 4xx message for an unreadable directory", async () => {
    vi.mocked(opendir).mockRejectedValueOnce(
      Object.assign(new Error("denied"), { code: "EACCES" }),
    );
    const res = await list(root);
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toBe("Directory is not readable.");
  });

  it("rejects relative, empty and missing paths", async () => {
    expect((await list("relative/path")).statusCode).toBe(400);
    expect((await list("")).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/fs/dirs", headers })).statusCode).toBe(400);
  });

  it("expands the server home directory and returns no parent at the root", async () => {
    expect((await list("~")).json().path).toBe(await realpath(homedir()));
    expect((await list("/")).json().parent).toBeNull();
  });

  it("uses normal symlink navigation and never returns links to files or broken links", async () => {
    const links = join(root, "links");
    await mkdir(links);
    await symlink(join(root, "alpha"), join(links, "folder-link"));
    await symlink(join(root, "private-file.txt"), join(links, "file-link"));
    await symlink(join(root, "missing"), join(links, "broken-link"));
    const res = await list(links);
    expect(res.json().directories).toEqual([
      { name: "folder-link", path: join(links, "folder-link") },
    ]);
    expect((await list(join(links, "folder-link"))).json().path).toBe(join(root, "alpha"));
    expect((await list(`${links}/folder-link/..`)).json().path).toBe(root);
  });

  it("caps a large listing", async () => {
    const large = join(root, "large");
    await mkdir(large);
    await Promise.all(Array.from({ length: 1002 }, (_, i) => mkdir(join(large, `dir-${i}`))));
    const res = await list(large);
    expect(res.statusCode).toBe(200);
    expect(res.json().directories).toHaveLength(1000);
    expect(res.json().truncated).toBe(true);
  });

  it("requires the same authentication as other API routes", async () => {
    const res = await app.inject({ url: `/api/fs/dirs?path=${encodeURIComponent(root)}` });
    expect(res.statusCode).toBe(401);
  });

  it("bounds scanning even when every entry is a file", async () => {
    let scanned = 0;
    let closed = false;
    vi.mocked(opendir).mockResolvedValueOnce({
      async *[Symbol.asyncIterator]() {
        try {
          for (let i = 0; i < 20000; i++) {
            scanned++;
            yield {
              name: `file-${i}`,
              isDirectory: () => false,
              isSymbolicLink: () => false,
            };
          }
        } finally {
          closed = true;
        }
      },
    } as Awaited<ReturnType<typeof opendir>>);
    const res = await list(root);
    expect(res.statusCode).toBe(200);
    expect(res.json().directories).toEqual([]);
    expect(res.json().truncated).toBe(true);
    expect(scanned).toBe(10001);
    expect(closed).toBe(true);
  });
});
