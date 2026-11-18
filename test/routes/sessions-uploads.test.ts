// Must come before any import below that could itself trigger loading
// "node-pty"/"node:child_process" (e.g. the `node:child_process` import a
// few lines down) — see mock-pty.ts's header comment for the
// empirically confirmed hoisting/ordering failure mode.
import { createNodePtyMock } from "../helpers/mock-pty.js";
import {
  PNG_BYTES,
  createProject,
  mockSpawnModule,
  opencodeTransferMock,
  setupSessionsRouteLifecycle,
} from "../helpers/sessions-routes.js";
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// Session creation spawns real OS processes (systemd-run, dtach) via
// PtyManager — faked here the same way as test/helpers/pty-manager-harness.ts,
// so these files exercise the route/DB layer without depending on a real
// systemd --user session existing in CI. See that file for why.
//
// Each spawned fake PTY's onData listener array is captured here (not just
// created and discarded) so a scrollback-identity test can push real,
// distinguishable output through a specific session's PTY after the fact —
// see the "returns the base64-encoded scrollback buffer" test in test/routes/sessions-read.test.ts.
// `ptyMock.spawnedPtys[n].emitData(...)` (mock-pty.ts's listener-capturing
// variant) replaces the pre-split file's hand-rolled `fakePtyListeners` array.
const ptyMock = createNodePtyMock();
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));

// Issue #1733 — the agent's own argv reaches the dtach MASTER's spawn (the
// child_process one), not the attach client's node-pty spawn, so the mock's
// calls have to be reachable from the test.
vi.mock("node:child_process", async (importOriginal) => mockSpawnModule(await importOriginal()));

// Issue #271 follow-up — the opencode session transfer's own subprocess
// calls would otherwise hang; see mockSpawnModule's and opencodeTransferMock's
// doc comments in test/helpers/sessions-routes.ts.
vi.mock("../../src/services/opencode-session-transfer.js", () => opencodeTransferMock());

const { buildApp } = await import("../../src/app.js");

// This suite's own database, reset between tests — no test in this file can
// see another's rows, and no mock state leaks from one test into the next
// (see test/helpers/sessions-routes.ts).
setupSessionsRouteLifecycle("uploads");

describe("sessions route: uploading files to a session", () => {
  describe("POST /api/sessions/:id/uploads (issue #68)", () => {
    async function createProjectWithCwd(app: Awaited<ReturnType<typeof buildApp>>, cwd: string) {
      const res = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { allowDuplicate: true, createDir: true, name: "upload-p", cwd },
      });
      return res.json().id as number;
    }

    it("writes the image under the session's cwd and returns its absolute path", async () => {
      const app = await buildApp();
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sessions-upload-"));
      const projectId = await createProjectWithCwd(app, cwd);
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = created.json().id;
      const buffer = PNG_BYTES;

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/uploads`,
        headers: { "content-type": "image/png" },
        payload: buffer,
      });

      expect(res.statusCode).toBe(200);
      const { path: uploadPath } = res.json();
      expect(uploadPath.startsWith(path.join(cwd, ".mullion-uploads"))).toBe(true);
      expect(fs.readFileSync(uploadPath)).toEqual(buffer);

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("returns 409 (not 502) when .mullion-uploads is a symlink", async () => {
      const app = await buildApp();
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sessions-upload-symlink-"));
      const target = fs.mkdtempSync(path.join(os.tmpdir(), "sessions-upload-target-"));
      fs.symlinkSync(target, path.join(cwd, ".mullion-uploads"));
      const projectId = await createProjectWithCwd(app, cwd);
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${created.json().id}/uploads`,
        headers: { "content-type": "image/png" },
        payload: PNG_BYTES,
      });
      expect(res.statusCode).toBe(409);
      expect(fs.readdirSync(target)).toEqual([]);

      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(target, { recursive: true, force: true });
      await app.close();
    });

    it("accepts a Content-Type with a charset parameter (Hermes review, PR #106)", async () => {
      const app = await buildApp();
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sessions-upload-charset-"));
      const projectId = await createProjectWithCwd(app, cwd);
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = created.json().id;

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/uploads`,
        headers: { "content-type": "image/png; charset=binary" },
        payload: PNG_BYTES,
      });

      expect(res.statusCode).toBe(200);
      const { path: uploadPath } = res.json();
      expect(uploadPath.endsWith(".png")).toBe(true);

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("404s for an unknown session id", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/999999/uploads",
        headers: { "content-type": "image/png" },
        payload: Buffer.from("x"),
      });
      expect(res.statusCode).toBe(404);
      await app.close();
    });

    it("rejects an image type outside the allow-list (matched by the content-type parser but not extensionForMime)", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = created.json().id;

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/uploads`,
        headers: { "content-type": "image/svg+xml" },
        payload: Buffer.from("<svg/>"),
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("rejects a body whose bytes don't match the declared mime, even with an allow-listed Content-Type", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = created.json().id;

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/uploads`,
        headers: { "content-type": "image/png" },
        payload: Buffer.from("<html><script>alert(1)</script></html>"),
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("saves a generic file (octet-stream + X-Upload-Filename) under the sanitized original name", async () => {
      const app = await buildApp();
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sessions-upload-file-"));
      const projectId = await createProjectWithCwd(app, cwd);
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const body = Buffer.from("%PDF-1.4 not really");

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${created.json().id}/uploads`,
        headers: {
          "content-type": "application/octet-stream",
          "x-upload-filename": encodeURIComponent("../Q3 report (final).pdf"),
        },
        payload: body,
      });

      expect(res.statusCode).toBe(200);
      const { path: uploadPath } = res.json();
      expect(uploadPath.startsWith(path.join(cwd, ".mullion-uploads") + path.sep)).toBe(true);
      expect(path.basename(uploadPath)).toBe("Q3_report__final_.pdf");
      expect(fs.readFileSync(uploadPath)).toEqual(body);

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("falls back to `file` when a generic upload has no X-Upload-Filename header", async () => {
      const app = await buildApp();
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sessions-upload-file-"));
      const projectId = await createProjectWithCwd(app, cwd);
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${created.json().id}/uploads`,
        headers: { "content-type": "application/octet-stream" },
        payload: Buffer.from("data"),
      });

      expect(res.statusCode).toBe(200);
      expect(path.basename(res.json().path)).toBe("file");

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("treats a present-but-empty X-Upload-Filename like an absent one", async () => {
      const app = await buildApp();
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sessions-upload-file-"));
      const projectId = await createProjectWithCwd(app, cwd);
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${created.json().id}/uploads`,
        headers: { "content-type": "application/octet-stream", "x-upload-filename": "" },
        payload: Buffer.from("data"),
      });

      expect(res.statusCode).toBe(200);
      expect(path.basename(res.json().path)).toBe("file");

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("400s a generic upload with a malformed percent-encoded X-Upload-Filename", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${created.json().id}/uploads`,
        headers: { "content-type": "application/octet-stream", "x-upload-filename": "%E0%A4%A" },
        payload: Buffer.from("data"),
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it.each([
      {
        kind: "generic file",
        headers: { "content-type": "application/octet-stream", "x-upload-filename": "a.txt" },
        payload: Buffer.from("data"),
      },
      { kind: "image", headers: { "content-type": "image/png" }, payload: PNG_BYTES },
    ])(
      "prunes stale uploads in the session's cwd when a $kind lands (primary retention wiring, issue #1637)",
      async ({ headers, payload }) => {
        const app = await buildApp();
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sessions-upload-prune-"));
        const projectId = await createProjectWithCwd(app, cwd);
        const created = await app.inject({
          method: "POST",
          url: "/api/sessions",
          payload: { projectId, command: "bash" },
        });
        const stale = path.join(cwd, ".mullion-uploads", "stale-uuid");
        fs.mkdirSync(stale, { recursive: true });
        const old = new Date(Date.now() - 30 * 86_400_000);
        fs.utimesSync(stale, old, old);

        const res = await app.inject({
          method: "POST",
          url: `/api/sessions/${created.json().id}/uploads`,
          headers,
          payload,
        });

        expect(res.statusCode).toBe(200);
        expect(fs.existsSync(stale)).toBe(false);
        fs.rmSync(cwd, { recursive: true, force: true });
        await app.close();
      },
    );

    it("400s a mismatched image with the UPLOAD_IMAGE_MISMATCH code (issue #1637)", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${created.json().id}/uploads`,
        headers: { "content-type": "image/png" },
        payload: Buffer.from("definitely not a png"),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: "UPLOAD_IMAGE_MISMATCH" });
      await app.close();
    });

    it("502s a generic upload with UPLOAD_AGENT_OUTDATED when the agent answers 415 (issue #1637)", async () => {
      const app = await buildApp();
      const sessionBackendModule = await import("../../src/services/session-backend.js");
      const { HostRequestError } = await import("../../src/services/remote-host-client.js");
      const projectId = await createProject(app);
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = created.json().id;
      const spy = vi.spyOn(sessionBackendModule, "resolveBackend");
      const fake = (status: number) =>
        ({
          uploadFile: vi.fn().mockRejectedValue(new HostRequestError("remote", status, "nope")),
          uploadImage: vi.fn().mockRejectedValue(new HostRequestError("remote", status, "nope")),
        }) as unknown as ReturnType<typeof sessionBackendModule.resolveBackend>;

      const generic = () =>
        app.inject({
          method: "POST",
          url: `/api/sessions/${sessionId}/uploads`,
          headers: { "content-type": "application/octet-stream", "x-upload-filename": "a.pdf" },
          payload: Buffer.from("data"),
        });
      spy.mockReturnValue(fake(415));
      const outdated = await generic();
      expect(outdated.statusCode).toBe(502);
      expect(outdated.json()).toMatchObject({ code: "UPLOAD_AGENT_OUTDATED" });

      // A 404 is ambiguous (not necessarily an old agent) — plain 502.
      spy.mockReturnValue(fake(404));
      const notFound = await generic();
      expect(notFound.statusCode).toBe(502);
      expect(notFound.json().code).toBeUndefined();

      // An image upload hitting the same agent error stays a plain 502.
      spy.mockReturnValue(fake(415));
      const image = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/uploads`,
        headers: { "content-type": "image/png" },
        payload: PNG_BYTES,
      });
      expect(image.statusCode).toBe(502);
      expect(image.json().code).toBeUndefined();

      spy.mockRestore();
      await app.close();
    });

    it("rate-limits uploads to 120 per minute per IP, returning 429 beyond that (issue #1637)", async () => {
      const app = await buildApp();
      const statuses: number[] = [];
      for (let i = 0; i < 121; i++) {
        const res = await app.inject({
          method: "POST",
          url: "/api/sessions/999999/uploads",
          headers: { "content-type": "image/png" },
          payload: PNG_BYTES,
        });
        statuses.push(res.statusCode);
      }
      expect(statuses.slice(0, 120).every((c) => c === 404)).toBe(true);
      expect(statuses[120]).toBe(429);
      // The bucket is route-scoped: uploads must not drain the shared /api
      // budget the rest of the dashboard draws on.
      const sibling = await app.inject({ method: "GET", url: "/api/projects" });
      expect(sibling.statusCode).toBe(200);
      expect(sibling.headers["x-ratelimit-limit"]).toBe(String(app.config.RATE_LIMIT_MAX));
      expect(Number(sibling.headers["x-ratelimit-remaining"])).toBeGreaterThan(
        app.config.RATE_LIMIT_MAX - 10,
      );
      await app.close();
    });

    it("415s a non-image content type (no matching content-type parser)", async () => {
      const app = await buildApp();
      const projectId = await createProject(app);
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId, command: "bash" },
      });
      const sessionId = created.json().id;

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/uploads`,
        headers: { "content-type": "application/pdf" },
        payload: Buffer.from("x"),
      });
      expect(res.statusCode).toBe(415);
      await app.close();
    });
  });
});
