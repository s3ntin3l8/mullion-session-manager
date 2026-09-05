import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { DEFAULT_SETTINGS } from "../../src/services/settings.js";

const tmpDb = path.join(os.tmpdir(), `settings-test-${process.pid}.db`);

describe("settings route", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  it("returns DEFAULT_SETTINGS before any row exists", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/settings" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.json()).toEqual(DEFAULT_SETTINGS);
    await app.close();
  });

  it("deep-merges a partial nested PATCH onto defaults, leaving siblings untouched", async () => {
    const app = await buildApp();

    const patched = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { terminal: { fontSize: 18 } },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.headers["content-type"]).toMatch(/^application\/json/);
    const body = patched.json();
    expect(body.terminal.fontSize).toBe(18);
    // Siblings of fontSize inside terminal must survive untouched.
    expect(body.terminal.cursorStyle).toBe(DEFAULT_SETTINGS.terminal.cursorStyle);
    expect(body.terminal.fontFamily).toBe(DEFAULT_SETTINGS.terminal.fontFamily);
    // Top-level siblings of `terminal` must survive untouched too.
    expect(body.theme).toBe(DEFAULT_SETTINGS.theme);

    const fetched = await app.inject({ method: "GET", url: "/api/settings" });
    expect(fetched.json().terminal.fontSize).toBe(18);

    await app.close();
  });

  it("replaces arrays outright rather than merging element-wise", async () => {
    const app = await buildApp();

    await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { projectRoots: ["~/work", "~/fun"] },
    });
    const cleared = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { projectRoots: [] },
    });
    expect(cleared.json().projectRoots).toEqual([]);

    await app.close();
  });

  // Regression (issue #957/#958): opencode.implementerModel's default is
  // `null` — this schema's first field with a null default. The bug this
  // pins is specific to the SECOND patch: by then `previous` (the settings
  // read at the top of the PATCH handler) has already drifted away from
  // DEFAULT_SETTINGS, so deepMerge can no longer infer the field's
  // nullability from `previous` alone — only from the explicit
  // DEFAULT_SETTINGS argument the route now passes. Before that fix, the
  // first PATCH (null -> string) already failed too, but this two-step
  // shape is what a real user does in Settings -> Models: pick a model,
  // then clear it back to "None".
  it("sets then clears an opencode.implementerModel patch (null -> string -> null)", async () => {
    const app = await buildApp();

    const set = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { opencode: { implementerModel: "anthropic/claude-sonnet-4-5" } },
    });
    expect(set.json().opencode.implementerModel).toBe("anthropic/claude-sonnet-4-5");

    const cleared = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { opencode: { implementerModel: null } },
    });
    expect(cleared.json().opencode.implementerModel).toBeNull();
    // Siblings untouched by either patch.
    expect(cleared.json().opencode.reviewerModel).toBeNull();

    await app.close();
  });

  // Code review on the null-transition fix above caught that its first
  // version over-widened: it accepted ANY scalar (string/number/boolean)
  // for a null-defaulted field, not just that field's actual `string | null`
  // type. A number here must still be dropped, exactly like a type-mismatch
  // patch on any other field.
  it("rejects a numeric opencode.implementerModel patch, leaving the field null", async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { opencode: { implementerModel: 42 } },
    });
    expect(res.json().opencode.implementerModel).toBeNull();

    await app.close();
  });

  it("accumulates across independent PATCHes to different nested fields", async () => {
    const app = await buildApp();

    await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { theme: "light" },
    });
    const second = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { sessions: { hideEndedSessions: true } },
    });

    expect(second.json()).toMatchObject({
      theme: "light",
      sessions: expect.objectContaining({ hideEndedSessions: true }),
    });

    await app.close();
  });

  // PR3 of the docker-integration plan (issue #73 follow-up) — the new
  // dock.autoAttachDockerLogs field round-trips through the real PATCH/GET
  // route, not just the frontend's typed stub (patchSettingsSchema has
  // additionalProperties: true and deepMerge is generic, but this is the
  // only check that actually exercises that boundary rather than assuming
  // it — see TASK_ROW_COLUMNS' own silent-drop history for why that
  // assumption previously bit two other PRs).
  it("persists dock.autoAttachDockerLogs through PATCH and reads it back via GET", async () => {
    const app = await buildApp();

    const patched = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { dock: { autoAttachDockerLogs: true } },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().dock.autoAttachDockerLogs).toBe(true);
    // Siblings of autoAttachDockerLogs inside dock must survive untouched.
    expect(patched.json().dock.dockerServices).toBe(DEFAULT_SETTINGS.dock.dockerServices);

    const fetched = await app.inject({ method: "GET", url: "/api/settings" });
    expect(fetched.json().dock.autoAttachDockerLogs).toBe(true);

    await app.close();
  });

  it("rejects a non-object PATCH body", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: JSON.stringify(["not", "an", "object"]),
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("falls back to the default reconcile interval instead of persisting a busy-loop value", async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { sessions: { reconcileIntervalSeconds: 0 } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sessions.reconcileIntervalSeconds).toBe(
      DEFAULT_SETTINGS.sessions.reconcileIntervalSeconds,
    );

    const fetched = await app.inject({ method: "GET", url: "/api/settings" });
    expect(fetched.json().sessions.reconcileIntervalSeconds).toBe(
      DEFAULT_SETTINGS.sessions.reconcileIntervalSeconds,
    );

    await app.close();
  });

  it("falls back to the default idle threshold when patched with a non-number", async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { notifications: { idleThresholdSeconds: "soon" } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().notifications.idleThresholdSeconds).toBe(
      DEFAULT_SETTINGS.notifications.idleThresholdSeconds,
    );

    await app.close();
  });

  // Issue #937 — get/set round trip for the new global text setting.
  // Defaults to "" (an install with no configured convention text yet).
  it("defaults sessions.workflowConventionsText to an empty string", async () => {
    const app = await buildApp();

    const res = await app.inject({ method: "GET", url: "/api/settings" });
    expect(res.json().sessions.workflowConventionsText).toBe("");
    expect(DEFAULT_SETTINGS.sessions.workflowConventionsText).toBe("");

    await app.close();
  });

  it("round-trips sessions.workflowConventionsText through PATCH and a subsequent GET", async () => {
    const app = await buildApp();

    const patched = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { sessions: { workflowConventionsText: "Always branch, never commit to main." } },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().sessions.workflowConventionsText).toBe(
      "Always branch, never commit to main.",
    );

    const fetched = await app.inject({ method: "GET", url: "/api/settings" });
    expect(fetched.json().sessions.workflowConventionsText).toBe(
      "Always branch, never commit to main.",
    );

    await app.close();
  });

  it("clearing sessions.workflowConventionsText back to an empty string round-trips too", async () => {
    const app = await buildApp();

    await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { sessions: { workflowConventionsText: "some text" } },
    });
    const cleared = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { sessions: { workflowConventionsText: "" } },
    });
    expect(cleared.json().sessions.workflowConventionsText).toBe("");

    await app.close();
  });
});
