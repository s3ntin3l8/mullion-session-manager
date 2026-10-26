import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import http from "node:http";
import { Readable } from "node:stream";
import { execFileSync } from "node:child_process";
import { closeDb } from "../../src/db/client.js";
import { sessions } from "../../src/db/schema.js";
import { gitEnv } from "../../src/services/git-env.js";

const tmpDb = path.join(os.tmpdir(), `project-files-test-${process.pid}.db`);
process.env.DATABASE_URL = `file:${tmpDb}`;

// Same two-real-app-instances setup as agent-rules.test.ts: the agent gets
// its own SESSIONS_DIR so its hooks.sock doesn't collide with the primary's.
function uniqueSessionsDir(): string {
  return path.join(
    os.tmpdir(),
    `project-files-agent-sessions-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
  );
}

const { buildApp } = await import("../../src/app.js");

// A client still sending a large body must SEE the refusal, not a reset.
async function postMidUpload(
  app: Awaited<ReturnType<typeof buildApp>>,
  urlPath: string,
  declaredLength: number,
): Promise<{ status?: number; error?: string }> {
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: address.port,
        path: urlPath,
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(declaredLength),
        },
      },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode });
        req.destroy();
      },
    );
    req.on("error", (err) => resolve({ error: (err as NodeJS.ErrnoException).code }));
    // keep the body coming well after the server has made up its mind
    let sent = 0;
    const pump = setInterval(() => {
      if (sent >= declaredLength || req.destroyed) return clearInterval(pump);
      const chunk = Buffer.alloc(Math.min(64 * 1024, declaredLength - sent));
      sent += chunk.length;
      req.write(chunk);
    }, 5);
  });
}

describe("project-files routes", () => {
  let projectCwd: string;

  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
  });

  beforeEach(() => {
    projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-project-files-route-"));
  });

  afterEach(() => {
    fs.rmSync(projectCwd, { recursive: true, force: true });
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  async function createProject() {
    const app = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { createDir: true, name: "project-files-test", cwd: projectCwd },
    });
    return { app, projectId: created.json().id as number };
  }

  it("404s for an unknown project and 400s for a bad id", async () => {
    const app = await buildApp();
    expect(
      (await app.inject({ method: "GET", url: "/api/projects/999999/files" })).statusCode,
    ).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/projects/abc/files" })).statusCode).toBe(
      400,
    );
    expect(
      (await app.inject({ method: "GET", url: "/api/projects/999999/file?path=a" })).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/projects/999999/file",
          payload: { path: "a", content: "" },
        })
      ).statusCode,
    ).toBe(404);
    await app.close();
  });

  it("lists, reads, creates, updates and detects conflicts end to end", async () => {
    fs.writeFileSync(path.join(projectCwd, ".env"), "A=1\n");
    const { app, projectId } = await createProject();

    const list = await app.inject({ method: "GET", url: `/api/projects/${projectId}/files` });
    expect(list.statusCode).toBe(200);
    expect(list.json().entries.map((e: { name: string }) => e.name)).toContain(".env");

    const read = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/file?path=.env`,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ path: ".env", content: "A=1\n" });
    const { mtimeMs } = read.json();

    const put = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/file`,
      payload: { path: ".env", content: "A=2\n", expectedMtimeMs: mtimeMs },
    });
    expect(put.statusCode).toBe(200);
    expect(fs.readFileSync(path.join(projectCwd, ".env"), "utf8")).toBe("A=2\n");

    const stale = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/file`,
      payload: { path: ".env", content: "A=3\n", expectedMtimeMs: mtimeMs - 5000 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe("conflict");

    const created = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/file`,
      payload: { path: "new.txt", content: "hi", create: true },
    });
    expect(created.statusCode).toBe(200);
    const again = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/file`,
      payload: { path: "new.txt", content: "hi", create: true },
    });
    expect(again.statusCode).toBe(409);
    await app.close();
  });

  it("accepts a ~900 KB newline-heavy file whose JSON-escaped body exceeds 1 MiB", async () => {
    const { app, projectId } = await createProject();
    const content = "\n".repeat(900 * 1024);
    const res = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/file`,
      payload: { path: "nl.txt", content, create: true },
    });
    expect(res.statusCode).toBe(200);
    expect(fs.statSync(path.join(projectCwd, "nl.txt")).size).toBe(content.length);
    await app.close();
  });

  describe("sessionId re-roots the editor at that session's cwd", () => {
    let outsideDir: string;
    let subDir: string;

    beforeEach(() => {
      outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-project-files-outside-"));
      subDir = path.join(projectCwd, "packages", "app");
      fs.mkdirSync(subDir, { recursive: true });
      fs.writeFileSync(path.join(subDir, ".env"), "SUB=1\n");
      fs.writeFileSync(path.join(projectCwd, ".env"), "PROJECT=1\n");
    });

    afterEach(() => {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    });

    function addSession(
      app: Awaited<ReturnType<typeof buildApp>>,
      projectId: number,
      cwd: string | null,
    ) {
      return app.db
        .insert(sessions)
        .values({ projectId, name: "s", command: "bash", cwd })
        .returning({ id: sessions.id })
        .get().id;
    }

    // gitEnv() strips the GIT_* vars a pre-push hook leaks into `npm test`
    // (GIT_DIR / GIT_INDEX_FILE ...): without it `git add -A` here would run
    // against the REAL repo's index with this temp dir as its work tree.
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
        cwd,
        stdio: "ignore",
        env: gitEnv(),
      });

    it("lists, reads and writes in a session cwd inside the project, not the project root", async () => {
      const { app, projectId } = await createProject();
      const sessionId = addSession(app, projectId, subDir);

      const read = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/file?path=.env&sessionId=${sessionId}`,
      });
      expect(read.json().content).toBe("SUB=1\n");
      const list = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/files?sessionId=${sessionId}`,
      });
      expect(list.statusCode).toBe(200);

      const put = await app.inject({
        method: "PUT",
        url: `/api/projects/${projectId}/file`,
        payload: { path: ".env", content: "SUB=2\n", sessionId },
      });
      expect(put.statusCode).toBe(200);
      expect(fs.readFileSync(path.join(subDir, ".env"), "utf8")).toBe("SUB=2\n");
      expect(fs.readFileSync(path.join(projectCwd, ".env"), "utf8")).toBe("PROJECT=1\n");
      await app.close();
    });

    it("accepts a registered git worktree that lives OUTSIDE the project root", async () => {
      git(projectCwd, "init", "-q", "-b", "main");
      fs.writeFileSync(path.join(projectCwd, "seed.txt"), "x");
      git(projectCwd, "add", "-A");
      git(projectCwd, "commit", "-q", "-m", "init");
      const wt = path.join(outsideDir, "feat-x");
      git(projectCwd, "worktree", "add", "-q", "-b", "feat-x", wt);
      fs.writeFileSync(path.join(wt, ".env"), "WT=1\n");

      const { app, projectId } = await createProject();
      const sessionId = addSession(app, projectId, wt);
      const read = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/file?path=.env&sessionId=${sessionId}`,
      });
      expect(read.statusCode).toBe(200);
      expect(read.json().content).toBe("WT=1\n");
      await app.close();
    });

    it("refuses a session cwd that is neither inside the project nor a registered worktree", async () => {
      fs.writeFileSync(path.join(outsideDir, ".env"), "SECRET=1\n");
      const { app, projectId } = await createProject();
      const arbitrary = addSession(app, projectId, outsideDir);
      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/file?path=.env&sessionId=${arbitrary}`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/outside the project/);
      const del = await app.inject({
        method: "DELETE",
        url: `/api/projects/${projectId}/file?path=.env&sessionId=${arbitrary}`,
      });
      expect(del.statusCode).toBe(400);
      expect(fs.existsSync(path.join(outsideDir, ".env"))).toBe(true);
      await app.close();
    });

    it("refuses an in-project session cwd that is a symlink leading outside", async () => {
      fs.writeFileSync(path.join(outsideDir, ".env"), "SECRET=1\n");
      fs.symlinkSync(outsideDir, path.join(projectCwd, "escape"));
      const { app, projectId } = await createProject();
      const sessionId = addSession(app, projectId, path.join(projectCwd, "escape"));
      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/file?path=.env&sessionId=${sessionId}`,
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("treats an in-project session cwd that is a symlink loop as not allowed (400, not 500)", async () => {
      fs.symlinkSync("loop-b", path.join(projectCwd, "loop-a"));
      fs.symlinkSync("loop-a", path.join(projectCwd, "loop-b"));
      const { app, projectId } = await createProject();
      const sessionId = addSession(app, projectId, path.join(projectCwd, "loop-a"));
      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/files?sessionId=${sessionId}`,
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("rejects a non-positive sessionId and over-long paths", async () => {
      const { app, projectId } = await createProject();
      for (const bad of ["0", "-3"]) {
        const res = await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/file?path=.env&sessionId=${bad}`,
        });
        expect(res.statusCode).toBe(400);
      }
      const put = await app.inject({
        method: "PUT",
        url: `/api/projects/${projectId}/file`,
        payload: { path: "a", content: "", sessionId: 0 },
      });
      expect(put.statusCode).toBe(400);
      const long = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/files/mkdir`,
        payload: { path: "a".repeat(4097) },
      });
      expect(long.statusCode).toBe(400);
      await app.close();
    });

    it("falls back to the project cwd for a session without a cwd override", async () => {
      const { app, projectId } = await createProject();
      const sessionId = addSession(app, projectId, null);
      const read = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/file?path=.env&sessionId=${sessionId}`,
      });
      expect(read.json().content).toBe("PROJECT=1\n");
      await app.close();
    });

    it("404s for another project's session and 400s for a bad id", async () => {
      const { app, projectId } = await createProject();
      const otherCwd = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-project-files-other-"));
      const other = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { createDir: true, name: "other", cwd: otherCwd },
      });
      const foreign = addSession(app, other.json().id as number, subDir);
      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/file?path=.env&sessionId=${foreign}`,
      });
      expect(res.statusCode).toBe(404);
      const missing = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/file?path=.env&sessionId=999999`,
      });
      expect(missing.statusCode).toBe(404);
      const bad = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/file?path=.env&sessionId=abc`,
      });
      expect(bad.statusCode).toBe(400);
      fs.rmSync(otherCwd, { recursive: true, force: true });
      await app.close();
    });
  });

  it("creates folders, renames and deletes end to end, honouring sessionId", async () => {
    const { app, projectId } = await createProject();
    const mk = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/files/mkdir`,
      payload: { path: "docs" },
    });
    expect(mk.statusCode).toBe(200);
    expect(mk.json()).toEqual({ path: "docs" });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/files/mkdir`,
          payload: { path: "docs" },
        })
      ).statusCode,
    ).toBe(409);

    fs.writeFileSync(path.join(projectCwd, "docs", "a.md"), "x");
    const mv = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/files/rename`,
      payload: { from: "docs/a.md", to: "docs/b.md" },
    });
    expect(mv.json()).toEqual({ path: "docs/b.md" });
    const clash = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/files/rename`,
      payload: { from: "docs/b.md", to: "docs/b.md" },
    });
    expect(clash.statusCode).toBe(409);

    const full = await app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}/file?path=docs`,
    });
    expect(full.statusCode).toBe(409);
    expect(full.json().code).toBe("not_empty");
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/projects/${projectId}/file?path=docs/b.md`,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "DELETE", url: `/api/projects/${projectId}/file?path=docs` }))
        .statusCode,
    ).toBe(200);
    expect(fs.existsSync(path.join(projectCwd, "docs"))).toBe(false);
    expect(
      (await app.inject({ method: "DELETE", url: `/api/projects/${projectId}/file` })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "DELETE", url: `/api/projects/${projectId}/file?path=../x` }))
        .statusCode,
    ).toBe(400);
    await app.close();
  });

  it("searches filenames, honouring sessionId", async () => {
    fs.writeFileSync(path.join(projectCwd, ".env"), "");
    fs.mkdirSync(path.join(projectCwd, "src"));
    fs.writeFileSync(path.join(projectCwd, "src", "env.ts"), "");
    const { app, projectId } = await createProject();
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/files/search?q=env`,
    });
    expect(res.statusCode).toBe(200);
    expect(
      res
        .json()
        .results.map((r: { path: string }) => r.path)
        .sort(),
    ).toEqual([".env", "src/env.ts"]);
    const none = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/files/search`,
    });
    expect(none.json()).toEqual({ results: [], truncated: false });
    const long = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/files/search?q=${"a".repeat(201)}`,
    });
    expect(long.statusCode).toBe(400);
    expect(
      (await app.inject({ method: "GET", url: "/api/projects/999999/files/search?q=a" }))
        .statusCode,
    ).toBe(404);
    await app.close();
  });

  it("maps service errors to their http status", async () => {
    fs.writeFileSync(path.join(projectCwd, "bin"), Buffer.from([0, 1, 2]));
    const { app, projectId } = await createProject();
    const get = (p: string) =>
      app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/file?path=${encodeURIComponent(p)}`,
      });
    expect((await get("../etc/passwd")).statusCode).toBe(400);
    expect((await get("missing")).statusCode).toBe(404);
    const missing = await get("missing");
    expect(missing.json().code).toBe("not_found");
    expect((await get("bin")).statusCode).toBe(415);
    const noPath = await app.inject({ method: "GET", url: `/api/projects/${projectId}/file` });
    expect(noPath.statusCode).toBe(400);
    const big = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/file`,
      payload: { path: "big", content: "x".repeat(1024 * 1024 + 1), create: true },
    });
    expect(big.statusCode).toBe(413);
    await app.close();
  });

  it("serves allowlisted external files read-only and 403s the rest", async () => {
    const ext = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-project-files-ext-"));
    try {
      fs.mkdirSync(path.join(ext, "plans"));
      fs.writeFileSync(path.join(ext, "plans", "p.md"), "# plan");
      fs.writeFileSync(path.join(ext, "secret"), "s");
      const { app, projectId } = await createProject();
      const url = (p: string) =>
        `/api/projects/${projectId}/external-file?path=${encodeURIComponent(p)}`;

      // Default roots don't include the temp dir.
      const denied = await app.inject({ method: "GET", url: url(path.join(ext, "plans", "p.md")) });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().code).toBe("not_allowlisted");

      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: {
          externalReadRoots: [
            `${path.join(ext, "plans")}///`,
            "/",
            "relative",
            `x${"/".repeat(50)}y`,
          ],
        },
      });
      const ok = await app.inject({ method: "GET", url: url(path.join(ext, "plans", "p.md")) });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ path: "p.md", content: "# plan" });
      const other = await app.inject({ method: "GET", url: url(path.join(ext, "secret")) });
      expect(other.statusCode).toBe(403);
      // Invalid roots are dropped on save.
      const settings = await app.inject({ method: "GET", url: "/api/settings" });
      expect(settings.json().externalReadRoots).toEqual([path.join(ext, "plans")]);

      expect(
        (await app.inject({ method: "GET", url: "/api/projects/999999/external-file?path=/x" }))
          .statusCode,
      ).toBe(404);
      expect(
        (await app.inject({ method: "GET", url: "/api/projects/abc/external-file?path=/x" }))
          .statusCode,
      ).toBe(400);
      expect((await app.inject({ method: "GET", url: url("") })).statusCode).toBe(400);
      expect((await app.inject({ method: "GET", url: url("rel/p.md") })).statusCode).toBe(400);
      await app.close();
    } finally {
      fs.rmSync(ext, { recursive: true, force: true });
    }
  });

  describe("raw transfer", () => {
    const upload = (
      app: Awaited<ReturnType<typeof buildApp>>,
      projectId: number,
      rel: string,
      body: Buffer | string,
      extra = "",
    ) =>
      app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/files/upload?path=${encodeURIComponent(rel)}${extra}`,
        headers: { "content-type": "application/octet-stream" },
        payload: body,
      });

    it("uploads binary bytes, refuses an existing name, and downloads them back", async () => {
      const { app, projectId } = await createProject();
      const bytes = Buffer.from([0, 1, 2, 3, 250, 251, 0, 255]);
      const up = await upload(app, projectId, "pic.bin", bytes);
      expect(up.statusCode).toBe(200);
      expect(up.json()).toEqual({ path: "pic.bin", size: bytes.length });
      expect(fs.readFileSync(path.join(projectCwd, "pic.bin")).equals(bytes)).toBe(true);

      const again = await upload(app, projectId, "pic.bin", "other");
      expect(again.statusCode).toBe(409);
      expect(again.json().code).toBe("conflict");
      expect(fs.readFileSync(path.join(projectCwd, "pic.bin")).equals(bytes)).toBe(true);

      const down = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/files/download?path=pic.bin`,
      });
      expect(down.statusCode).toBe(200);
      expect(down.rawPayload.equals(bytes)).toBe(true);
      expect(down.headers["content-type"]).toBe("application/octet-stream");
      expect(down.headers["content-length"]).toBe(String(bytes.length));
      expect(down.headers["x-content-type-options"]).toBe("nosniff");
      expect(down.headers["content-disposition"]).toMatch(/^attachment; filename="pic\.bin"/);
      await app.close();
    });

    it("encodes awkward file names in Content-Disposition", async () => {
      fs.writeFileSync(path.join(projectCwd, 'a "b"é.txt'), "x");
      const { app, projectId } = await createProject();
      const down = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/files/download?path=${encodeURIComponent('a "b"é.txt')}`,
      });
      expect(down.statusCode).toBe(200);
      const cd = down.headers["content-disposition"] as string;
      expect(cd).toContain('filename="a _b__.txt"');
      expect(cd).toContain("filename*=UTF-8''a%20%22b%22%C3%A9.txt");
      await app.close();
    });

    it("mkdirs creates parent folders for a folder upload", async () => {
      const { app, projectId } = await createProject();
      const missing = await upload(app, projectId, "d/e/f.txt", "x");
      expect(missing.statusCode).toBe(404);
      const ok = await upload(app, projectId, "d/e/f.txt", "x", "&mkdirs=1");
      expect(ok.statusCode).toBe(200);
      expect(fs.readFileSync(path.join(projectCwd, "d", "e", "f.txt"), "utf8")).toBe("x");
      await app.close();
    });

    it("rejects traversal, a missing path and a non-stream body", async () => {
      const { app, projectId } = await createProject();
      expect((await upload(app, projectId, "../evil", "x")).statusCode).toBe(400);
      const noPath = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/files/upload`,
        headers: { "content-type": "application/octet-stream" },
        payload: "x",
      });
      expect(noPath.statusCode).toBe(400);
      // a JSON body is parsed by Fastify's default parser, so it is not a raw
      // stream: refused, never written
      const json = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/files/upload?path=j.txt`,
        payload: { a: 1 },
      });
      expect(json.statusCode).toBe(400);
      expect(fs.existsSync(path.join(projectCwd, "j.txt"))).toBe(false);
      await app.close();
    });

    it("413s a declared length over the cap and an actual body over it", async () => {
      const { app, projectId } = await createProject();
      const max = app.config.FILE_TRANSFER_MAX_BYTES;
      const declared = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/files/upload?path=big`,
        headers: { "content-type": "application/octet-stream", "content-length": String(max + 1) },
        payload: "tiny",
      });
      expect(declared.statusCode).toBe(413);
      expect(declared.json().code).toBe("too_large");

      (app.config as { FILE_TRANSFER_MAX_BYTES: number }).FILE_TRANSFER_MAX_BYTES = 4;
      const actual = await upload(app, projectId, "big", "0123456789");
      expect(actual.statusCode).toBe(413);
      expect(fs.existsSync(path.join(projectCwd, "big"))).toBe(false);
      expect(fs.readdirSync(projectCwd).filter((n) => n.startsWith(".mullion-part-"))).toEqual([]);

      fs.writeFileSync(path.join(projectCwd, "five"), "01234");
      const dl = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/files/download?path=five`,
      });
      expect(dl.statusCode).toBe(413);
      (app.config as { FILE_TRANSFER_MAX_BYTES: number }).FILE_TRANSFER_MAX_BYTES = max;
      await app.close();
    });

    it("answers an over-cap upload with 413 while the client is still sending", async () => {
      const { app, projectId } = await createProject();
      const max = app.config.FILE_TRANSFER_MAX_BYTES;
      const out = await postMidUpload(
        app,
        `/api/projects/${projectId}/files/upload?path=big.bin`,
        max + 1_000_000,
      );
      expect(out).toEqual({ status: 413 });
      await app.close();
    });

    it("answers a name clash with 409 while the client is still sending", async () => {
      fs.writeFileSync(path.join(projectCwd, "taken.bin"), "keep");
      const { app, projectId } = await createProject();
      const out = await postMidUpload(
        app,
        `/api/projects/${projectId}/files/upload?path=taken.bin`,
        4 * 1024 * 1024,
      );
      expect(out).toEqual({ status: 409 });
      expect(fs.readFileSync(path.join(projectCwd, "taken.bin"), "utf8")).toBe("keep");
      expect(fs.readdirSync(projectCwd).filter((n) => n.startsWith(".mullion-part-"))).toEqual([]);
      await app.close();
    });

    it("refuses to download a folder, a missing file and an escape", async () => {
      fs.mkdirSync(path.join(projectCwd, "dir"));
      const { app, projectId } = await createProject();
      const get = (rel: string) =>
        app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/files/download?path=${encodeURIComponent(rel)}`,
        });
      expect((await get("dir")).statusCode).toBe(400);
      expect((await get("nope")).statusCode).toBe(404);
      expect((await get("../x")).statusCode).toBe(400);
      expect(
        (await app.inject({ method: "GET", url: `/api/projects/${projectId}/files/download` }))
          .statusCode,
      ).toBe(400);
      await app.close();
    });

    it("404s for an unknown project", async () => {
      const app = await buildApp();
      expect((await upload(app, 999999, "a", "x")).statusCode).toBe(404);
      expect(
        (await app.inject({ method: "GET", url: "/api/projects/999999/files/download?path=a" }))
          .statusCode,
      ).toBe(404);
      await app.close();
    });
  });

  describe("remote host", () => {
    async function startAgent(token: string) {
      const prevEnv: Record<string, string | undefined> = {};
      const agentEnv = {
        MULLION_ROLE: "agent",
        MULLION_AGENT_TOKEN: token,
        PROJECTS_ROOTS: os.tmpdir(),
        SESSIONS_DIR: uniqueSessionsDir(),
      };
      for (const key of Object.keys(agentEnv)) {
        prevEnv[key] = process.env[key];
        process.env[key] = agentEnv[key as keyof typeof agentEnv];
      }
      const agentApp = await buildApp();
      for (const key of Object.keys(agentEnv)) {
        if (prevEnv[key] === undefined) delete process.env[key];
        else process.env[key] = prevEnv[key];
      }
      await agentApp.listen({ port: 0, host: "127.0.0.1" });
      const address = agentApp.server.address();
      if (address === null || typeof address === "string") {
        throw new Error("expected a real bound address");
      }
      return { agentApp, port: address.port };
    }

    async function remoteProject(port: number, token: string, cwd: string) {
      const primary = await buildApp();
      const host = await primary.inject({
        method: "POST",
        url: "/api/hosts",
        payload: {
          name: `pf-remote-${crypto.randomBytes(3).toString("hex")}`,
          baseUrl: `http://127.0.0.1:${port}`,
          token,
        },
      });
      const project = await primary.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "pf-remote", cwd, hostId: host.json().id },
      });
      return { primary, projectId: project.json().id as number };
    }

    it("501s the external-file route for a remote host", async () => {
      const { agentApp, port } = await startAgent("pf-token-ext");
      const { primary, projectId } = await remoteProject(port, "pf-token-ext", projectCwd);
      const res = await primary.inject({
        method: "GET",
        url: `/api/projects/${projectId}/external-file?path=${encodeURIComponent("/tmp/x.md")}`,
      });
      expect(res.statusCode).toBe(501);
      await primary.close();
      await agentApp.close();
    });

    it("round-trips list/read/write and forwards coded errors", async () => {
      fs.writeFileSync(path.join(projectCwd, ".env"), "R=1\n");
      const { agentApp, port } = await startAgent("pf-token");
      const { primary, projectId } = await remoteProject(port, "pf-token", projectCwd);

      const list = await primary.inject({ method: "GET", url: `/api/projects/${projectId}/files` });
      expect(list.statusCode).toBe(200);
      expect(list.json().entries.map((e: { name: string }) => e.name)).toContain(".env");

      const read = await primary.inject({
        method: "GET",
        url: `/api/projects/${projectId}/file?path=.env`,
      });
      expect(read.json().content).toBe("R=1\n");

      const put = await primary.inject({
        method: "PUT",
        url: `/api/projects/${projectId}/file`,
        payload: { path: ".env", content: "R=2\n", expectedMtimeMs: read.json().mtimeMs },
      });
      expect(put.statusCode).toBe(200);
      expect(fs.readFileSync(path.join(projectCwd, ".env"), "utf8")).toBe("R=2\n");

      // genuinely missing file: coded 404 is forwarded as 404, NOT 501
      const missing = await primary.inject({
        method: "GET",
        url: `/api/projects/${projectId}/file?path=nope`,
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json().code).toBe("not_found");

      const stale = await primary.inject({
        method: "PUT",
        url: `/api/projects/${projectId}/file`,
        payload: { path: ".env", content: "x", expectedMtimeMs: 1 },
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().code).toBe("conflict");

      await primary.close();
      await agentApp.close();
    });

    it("sends the session's cwd to the agent when sessionId is given", async () => {
      const sub = path.join(projectCwd, "packages", "app");
      fs.mkdirSync(sub, { recursive: true });
      fs.writeFileSync(path.join(sub, ".env"), "REMOTE_SUB=1\n");
      const { agentApp, port } = await startAgent("pf-token-sid");
      const { primary, projectId } = await remoteProject(port, "pf-token-sid", projectCwd);
      const sessionId = primary.db
        .insert(sessions)
        .values({ projectId, name: "s", command: "bash", cwd: sub })
        .returning({ id: sessions.id })
        .get().id;
      const res = await primary.inject({
        method: "GET",
        url: `/api/projects/${projectId}/file?path=.env&sessionId=${sessionId}`,
      });
      expect(res.json().content).toBe("REMOTE_SUB=1\n");

      // a remote host can't run `git worktree list` here, so a cwd outside
      // the project is refused rather than trusted
      const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-project-files-remote-out-"));
      const outsideSession = primary.db
        .insert(sessions)
        .values({ projectId, name: "s2", command: "bash", cwd: elsewhere })
        .returning({ id: sessions.id })
        .get().id;
      const refused = await primary.inject({
        method: "GET",
        url: `/api/projects/${projectId}/file?path=.env&sessionId=${outsideSession}`,
      });
      expect(refused.statusCode).toBe(400);
      fs.rmSync(elsewhere, { recursive: true, force: true });
      await primary.close();
      await agentApp.close();
    });

    it("round-trips mkdir/rename/delete through the agent", async () => {
      const { agentApp, port } = await startAgent("pf-token-ops");
      const { primary, projectId } = await remoteProject(port, "pf-token-ops", projectCwd);
      const base = `/api/projects/${projectId}`;
      expect(
        (
          await primary.inject({
            method: "POST",
            url: `${base}/files/mkdir`,
            payload: { path: "d" },
          })
        ).json(),
      ).toEqual({ path: "d" });
      fs.writeFileSync(path.join(projectCwd, "d", "f"), "");
      const mv = await primary.inject({
        method: "POST",
        url: `${base}/files/rename`,
        payload: { from: "d/f", to: "d/g" },
      });
      expect(mv.json()).toEqual({ path: "d/g" });
      const full = await primary.inject({ method: "DELETE", url: `${base}/file?path=d` });
      expect(full.statusCode).toBe(409);
      expect(full.json().code).toBe("not_empty");
      expect(
        (await primary.inject({ method: "DELETE", url: `${base}/file?path=d/g` })).statusCode,
      ).toBe(200);
      expect(fs.existsSync(path.join(projectCwd, "d", "g"))).toBe(false);
      await primary.close();
      await agentApp.close();
    });

    it("searches through the agent", async () => {
      fs.writeFileSync(path.join(projectCwd, ".env.local"), "");
      const { agentApp, port } = await startAgent("pf-token-search");
      const { primary, projectId } = await remoteProject(port, "pf-token-search", projectCwd);
      const res = await primary.inject({
        method: "GET",
        url: `/api/projects/${projectId}/files/search?q=envlocal`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().results).toEqual([{ path: ".env.local" }]);
      await primary.close();
      await agentApp.close();
    });

    it("400s when the project cwd is outside the agent's PROJECTS_ROOTS", async () => {
      const { agentApp, port } = await startAgent("pf-token-2");
      const { primary, projectId } = await remoteProject(port, "pf-token-2", "/");
      const res = await primary.inject({ method: "GET", url: `/api/projects/${projectId}/files` });
      expect(res.statusCode).toBe(400);
      await primary.close();
      await agentApp.close();
    });

    it("folds a wrong agent token into 503", async () => {
      const { agentApp, port } = await startAgent("the-real-token");
      const { primary, projectId } = await remoteProject(port, "wrong-token", projectCwd);
      const res = await primary.inject({ method: "GET", url: `/api/projects/${projectId}/files` });
      expect(res.statusCode).toBe(503);
      await primary.close();
      await agentApp.close();
    });

    it("replies 501 when the agent lacks the routes (bare 404)", async () => {
      const bare = (await import("fastify")).default();
      bare.setNotFoundHandler((_req, reply) => reply.code(404).send({ message: "Not Found" }));
      await bare.listen({ port: 0, host: "127.0.0.1" });
      const address = bare.server.address();
      if (address === null || typeof address === "string") throw new Error("no address");
      const { primary, projectId } = await remoteProject(address.port, "any", projectCwd);
      const res = await primary.inject({ method: "GET", url: `/api/projects/${projectId}/files` });
      expect(res.statusCode).toBe(501);
      expect(res.json().message).toMatch(/too old/);
      await primary.close();
      await bare.close();
    });

    it("streams an upload and a download through the agent", async () => {
      const { agentApp, port } = await startAgent("pf-token-xfer");
      const { primary, projectId } = await remoteProject(port, "pf-token-xfer", projectCwd);
      const bytes = Buffer.alloc(3 * 1024 * 1024);
      for (let i = 0; i < bytes.length; i += 4096) bytes[i] = i % 251;

      const up = await primary.inject({
        method: "POST",
        url: `/api/projects/${projectId}/files/upload?path=${encodeURIComponent("sub/blob.bin")}&mkdirs=1`,
        headers: { "content-type": "application/octet-stream" },
        payload: bytes,
      });
      expect(up.statusCode).toBe(200);
      expect(up.json()).toEqual({ path: "sub/blob.bin", size: bytes.length });
      expect(fs.readFileSync(path.join(projectCwd, "sub", "blob.bin")).equals(bytes)).toBe(true);

      const clash = await primary.inject({
        method: "POST",
        url: `/api/projects/${projectId}/files/upload?path=${encodeURIComponent("sub/blob.bin")}`,
        headers: { "content-type": "application/octet-stream" },
        payload: "x",
      });
      expect(clash.statusCode).toBe(409);
      expect(clash.json().code).toBe("conflict");

      const down = await primary.inject({
        method: "GET",
        url: `/api/projects/${projectId}/files/download?path=${encodeURIComponent("sub/blob.bin")}`,
      });
      expect(down.statusCode).toBe(200);
      expect(down.rawPayload.equals(bytes)).toBe(true);
      expect(down.headers["content-length"]).toBe(String(bytes.length));
      expect(down.headers["content-disposition"]).toMatch(/filename="blob\.bin"/);

      const missing = await primary.inject({
        method: "GET",
        url: `/api/projects/${projectId}/files/download?path=nope`,
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json().code).toBe("not_found");

      await primary.close();
      await agentApp.close();
    });

    it("serves a download whose agent omitted Content-Length without sending 0", async () => {
      const bare = (await import("fastify")).default();
      bare.post("/internal/project-files/download", (_req, reply) =>
        reply
          .header("content-type", "application/octet-stream")
          .send(Readable.from(["hello ", "world"])),
      );
      await bare.listen({ port: 0, host: "127.0.0.1" });
      const address = bare.server.address();
      if (address === null || typeof address === "string") throw new Error("no address");
      const { primary, projectId } = await remoteProject(address.port, "any", projectCwd);
      const down = await primary.inject({
        method: "GET",
        url: `/api/projects/${projectId}/files/download?path=greeting.txt`,
      });
      expect(down.statusCode).toBe(200);
      expect(down.body).toBe("hello world");
      expect(down.headers["content-length"]).not.toBe("0");
      await primary.close();
      await bare.close();
    });

    it("answers a remote name clash while the client is still sending", async () => {
      fs.writeFileSync(path.join(projectCwd, "taken.bin"), "keep");
      const { agentApp, port } = await startAgent("pf-token-early");
      const { primary, projectId } = await remoteProject(port, "pf-token-early", projectCwd);
      const out = await postMidUpload(
        primary,
        `/api/projects/${projectId}/files/upload?path=taken.bin`,
        4 * 1024 * 1024,
      );
      expect(out).toEqual({ status: 409 });
      await primary.close();
      await agentApp.close();
    });

    it("replies 501 to upload/download when the agent lacks the routes", async () => {
      const bare = (await import("fastify")).default();
      bare.setNotFoundHandler((_req, reply) => reply.code(404).send({ message: "Not Found" }));
      await bare.listen({ port: 0, host: "127.0.0.1" });
      const address = bare.server.address();
      if (address === null || typeof address === "string") throw new Error("no address");
      const { primary, projectId } = await remoteProject(address.port, "any", projectCwd);
      const up = await primary.inject({
        method: "POST",
        url: `/api/projects/${projectId}/files/upload?path=a.bin`,
        headers: { "content-type": "application/octet-stream" },
        payload: "x",
      });
      expect(up.statusCode).toBe(501);
      const down = await primary.inject({
        method: "GET",
        url: `/api/projects/${projectId}/files/download?path=a.bin`,
      });
      expect(down.statusCode).toBe(501);
      await primary.close();
      await bare.close();
    });

    it("503s when the host is unreachable", async () => {
      const { agentApp, port } = await startAgent("pf-token-3");
      const { primary, projectId } = await remoteProject(port, "pf-token-3", projectCwd);
      await agentApp.close();
      const res = await primary.inject({ method: "GET", url: `/api/projects/${projectId}/files` });
      expect(res.statusCode).toBe(503);
      await primary.close();
    });
  });
});
