import { describe, expect, it } from "vitest";
import { buildTestApp } from "../helpers/app.js";
import { projectUrls, projects, sessions } from "../../src/db/schema.js";
import {
  getProjectRow,
  getSessionRow,
  listFavoriteProjectUrls,
} from "../../src/services/browser-store.js";

describe("browser-store", () => {
  async function setup() {
    const app = await buildTestApp();
    await app.ready();
    const projectId = app.db
      .insert(projects)
      .values({ name: "bs-proj", cwd: "/tmp/bs-proj" })
      .returning({ id: projects.id })
      .get().id;
    const sessionId = app.db
      .insert(sessions)
      .values({ projectId, name: "s", command: "bash", cwd: "/tmp/bs-proj" })
      .returning({ id: sessions.id })
      .get().id;
    return { app, projectId, sessionId };
  }

  it("getSessionRow returns the row, or undefined for an unknown id", async () => {
    const { app, projectId, sessionId } = await setup();
    expect(getSessionRow(app, sessionId)?.projectId).toBe(projectId);
    expect(getSessionRow(app, 999_999)).toBeUndefined();
  });

  it("getProjectRow returns the row, or undefined for an unknown id", async () => {
    const { app, projectId } = await setup();
    expect(getProjectRow(app, projectId)?.name).toBe("bs-proj");
    expect(getProjectRow(app, 999_999)).toBeUndefined();
  });

  it("listFavoriteProjectUrls returns only favorites, ordered by order then id", async () => {
    const { app, projectId } = await setup();
    app.db
      .insert(projectUrls)
      .values([
        { projectId, label: "b", url: "http://b", favorite: true, order: 2 },
        { projectId, label: "not", url: "http://n", favorite: false, order: 0 },
        { projectId, label: "a", url: "http://a", favorite: true, order: 1 },
      ])
      .run();
    const labels = listFavoriteProjectUrls(app)
      .filter((u) => u.projectId === projectId)
      .map((u) => u.label);
    expect(labels).toEqual(["a", "b"]);
  });
});
