import { describe, it, expect, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";
import { getDb, ensureDb, closeDb } from "../../src/db/client.js";

// Perf audit finding A2: getDb() must open the SQLite connection in WAL mode
// (not the rollback-journal default) with synchronous=NORMAL and a
// busy_timeout, so concurrent readers aren't blocked behind this
// long-lived server's several concurrent writers. Pinned directly against
// the opened connection's own PRAGMA output rather than just trusting the
// pragma() calls in client.ts stayed correct.
describe("getDb() journal mode (finding A2)", () => {
  const tmpDb = path.join(os.tmpdir(), `db-client-a2-test-${process.pid}.db`);

  afterEach(() => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      fs.rmSync(`${tmpDb}${suffix}`, { force: true });
    }
  });

  it("opens the database in WAL mode with synchronous=NORMAL and a busy_timeout", () => {
    const db = getDb(`file:${tmpDb}`);
    expect(db).toBeDefined();

    // The -wal sidecar is only materialized on disk once a write transaction
    // actually happens (setting the pragma alone doesn't create it) — do a
    // trivial write so the sidecar-file assertions below are meaningful.
    db.$client.exec("CREATE TABLE IF NOT EXISTS a2_test (id INTEGER PRIMARY KEY)");

    // Read the pragmas back from a second, independent connection to the
    // same file — WAL mode is a property of the database file itself (not
    // just the connection that set it), so this also proves it was
    // persisted, not merely requested on a connection that immediately
    // reverted it.
    const verify = new Database(tmpDb);
    try {
      const journalMode = verify.pragma("journal_mode", { simple: true });
      expect(journalMode).toBe("wal");

      const synchronous = verify.pragma("synchronous", { simple: true });
      // SQLite reports synchronous as an integer: 0=OFF, 1=NORMAL, 2=FULL.
      expect(synchronous).toBe(1);
    } finally {
      verify.close();
    }

    // busy_timeout is per-connection, not persisted to the file, so check
    // it on the getDb()-opened connection itself.
    const busyTimeout = db.$client.pragma("busy_timeout", { simple: true });
    expect(busyTimeout).toBe(5000);

    // WAL mode creates -wal/-shm sidecar files alongside the main DB file.
    expect(fs.existsSync(`${tmpDb}-wal`)).toBe(true);
    expect(fs.existsSync(`${tmpDb}-shm`)).toBe(true);
  });
});

// Perf audit finding A3 — `sessions.project_id` is an unindexed FK column
// hit by every project-scoped session query. Before the
// `sessions_project_id_idx` index (schema.ts), this was a full
// `SCAN sessions`. Pinned against the query planner's own output, applied
// through a real migration run (ensureDb), not just asserted from the
// schema declaration.
describe("sessions.project_id index (finding A3)", () => {
  const tmpDb = path.join(os.tmpdir(), `db-client-a3-test-${process.pid}.db`);

  afterEach(() => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      fs.rmSync(`${tmpDb}${suffix}`, { force: true });
    }
  });

  it("uses the project_id index, not a full table scan, for a project-scoped session query", () => {
    const db = ensureDb(`file:${tmpDb}`);
    const plan = db.$client
      .prepare("EXPLAIN QUERY PLAN SELECT * FROM sessions WHERE project_id = ?")
      .all(1) as Array<{ detail: string }>;

    expect(
      plan.some((row) => /SEARCH sessions USING INDEX sessions_project_id_idx/.test(row.detail)),
    ).toBe(true);
    expect(plan.some((row) => /SCAN sessions/.test(row.detail))).toBe(false);
  });
});

// #2252 — the approval-push migration backfills `approval_notified_verdict_at`
// for tasks already waiting, so a deploy does not announce them.
describe("approval_notified_verdict_at backfill migration (#2252)", () => {
  const tmpDb = path.join(os.tmpdir(), `db-client-2252-test-${process.pid}.db`);
  const drizzleDir = path.resolve(__dirname, "../../drizzle");

  afterEach(() => {
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${tmpDb}${suffix}`, { force: true });
  });

  it("marks existing reviewing tasks as already announced and leaves others alone", () => {
    const files = fs
      .readdirSync(drizzleDir)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort();
    const target = files.find((f) =>
      fs.readFileSync(path.join(drizzleDir, f), "utf8").includes("approval_notified_verdict_at"),
    )!;
    const apply = (db: Database.Database, file: string) => {
      const sqlText = fs.readFileSync(path.join(drizzleDir, file), "utf8");
      for (const stmt of sqlText.split("--> statement-breakpoint")) db.exec(stmt);
    };
    const db = new Database(tmpDb);
    for (const f of files.slice(0, files.indexOf(target))) apply(db, f);

    db.exec(
      "INSERT INTO projects (id, name, cwd, created_at) VALUES (1, 'p', '/tmp', 1);" +
        "INSERT INTO tasks (id, project_id, title, status, last_review_verdict_at, created_at, updated_at) VALUES " +
        "(1, 1, 'waiting', 'reviewing', 1700000000, 1, 1), (2, 1, 'done', 'done', 1700000000, 1, 1);",
    );
    apply(db, target);

    const rows = db
      .prepare("SELECT id, approval_notified_verdict_at AS a FROM tasks ORDER BY id")
      .all();
    expect(rows).toEqual([
      { id: 1, a: 1700000000 },
      { id: 2, a: null },
    ]);
    db.close();
  });
});

// #2292 — the superseded-copy migration: it adds `tasks.superseded_at`, marks
// the copies an EARLIER project merge already superseded, and normalizes the
// superseded-but-still-queued copies that #2291 left behind.
//
// The rows below are the shapes that matter, each one a real state the merge
// or a human archive can leave behind:
//
//   1-4  a merge-superseded copy (archived + issue number cleared + GitHub-linked)
//   5    a normal queued task (not archived) — must not move
//   6    a MANUALLY archived LOCAL task — must not be marked superseded
//   7    a MANUALLY archived GitHub task — must not be marked superseded
//   8    a pre-`html_url` superseded copy, recognized by the merge's own wording
//   9    a superseded copy a human UNARCHIVED — claimable, so it must move
//   10   an archived queued copy that predates `html_url` and kept an
//        unrelated failure reason — only a merge archives a queued task
//   11   an ordinary LOCAL queued task — must stay claimable
//   12   a superseded copy that was claimed, failed, and was then UNARCHIVED:
//        nothing but the marker keeps its Retry refused
describe("superseded_at backfill + archived-queued normalization migration (#2292)", () => {
  const tmpDb = path.join(os.tmpdir(), `db-client-2292-test-${process.pid}.db`);
  const drizzleDir = path.resolve(__dirname, "../../drizzle");

  afterEach(() => {
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${tmpDb}${suffix}`, { force: true });
  });

  it("marks the superseded copies, normalizes the queued ones, and leaves the rest alone", () => {
    const files = fs
      .readdirSync(drizzleDir)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort();
    const target = files.find((f) =>
      fs.readFileSync(path.join(drizzleDir, f), "utf8").includes("superseded_at"),
    )!;
    const apply = (db: Database.Database, file: string) => {
      const sqlText = fs.readFileSync(path.join(drizzleDir, file), "utf8");
      for (const stmt of sqlText.split("--> statement-breakpoint")) db.exec(stmt);
    };
    const db = new Database(tmpDb);
    for (const f of files.slice(0, files.indexOf(target))) apply(db, f);

    const ARCHIVED = 1700000000;
    // archived_at, issue_number, html_url, failure_reason
    db.exec(
      "INSERT INTO projects (id, name, cwd, created_at) VALUES (1, 'p', '/tmp', 1);" +
        "INSERT INTO tasks (id, project_id, title, status, issue_number, html_url, archived_at, failure_reason, created_at, updated_at) VALUES " +
        // 1 — superseded copy, still queued, with a failure reason of its own
        `(1, 1, 'copy ready', 'ready', NULL, 'https://github.com/o/r/issues/1', ${ARCHIVED}, 'session died', 1, 1),` +
        // 2 — superseded copy, queued, with no failure reason at all
        `(2, 1, 'copy backlog', 'backlog', NULL, 'https://github.com/o/r/issues/2', ${ARCHIVED}, NULL, 1, 1),` +
        // 3 — superseded copy that was claimed once and then failed
        `(3, 1, 'copy failed', 'failed', NULL, 'https://github.com/o/r/issues/3', ${ARCHIVED}, 'boom', 1, 1),` +
        // 4 — superseded copy that was already done
        `(4, 1, 'copy done', 'done', NULL, 'https://github.com/o/r/issues/4', ${ARCHIVED}, NULL, 1, 1),` +
        // 5 — an ordinary queued task, never archived
        `(5, 1, 'ordinary', 'ready', 5, 'https://github.com/o/r/issues/5', NULL, NULL, 1, 1),` +
        // 6 — a MANUALLY archived LOCAL task (no issue, no URL)
        `(6, 1, 'local archived', 'failed', NULL, NULL, ${ARCHIVED}, 'boom', 1, 1),` +
        // 7 — a MANUALLY archived GitHub task (its issue number is still set)
        `(7, 1, 'github archived', 'failed', 7, 'https://github.com/o/r/issues/7', ${ARCHIVED}, 'boom', 1, 1),` +
        // 8 — a superseded copy old enough to predate html_url
        `(8, 1, 'old copy', 'ready', NULL, NULL, ${ARCHIVED}, 'Merged from project #7: superseded.', 1, 1),` +
        // 9 — a superseded copy that a human UNARCHIVED: still queued, so it
        //     is claimable (the claim guards are archived-only) — the row the
        //     merge signature has to catch even without `archived_at`
        `(9, 1, 'unarchived copy', 'ready', NULL, 'https://github.com/o/r/issues/9', NULL, NULL, 1, 1),` +
        // 10 — an archived queued copy old enough to predate html_url, whose
        //      failure reason the merge did not overwrite: only a merge
        //      archives a queued task, so it is superseded all the same
        `(10, 1, 'old archived copy', 'backlog', NULL, NULL, ${ARCHIVED}, 'session died', 1, 1),` +
        // 11 — an ordinary LOCAL queued task (no issue, no URL, not archived):
        //      it must stay claimable
        `(11, 1, 'local ready', 'ready', NULL, NULL, NULL, NULL, 1, 1),` +
        // 12 — a superseded copy that was claimed, failed, and was then
        //      UNARCHIVED: nothing but the marker keeps its Retry refused
        `(12, 1, 'unarchived failed copy', 'failed', NULL, 'https://github.com/o/r/issues/12', NULL, 'boom', 1, 1);`,
    );
    apply(db, target);

    const rows = db
      .prepare(
        "SELECT id, status, failure_reason AS reason, superseded_at AS s FROM tasks ORDER BY id",
      )
      .all() as Array<{ id: number; status: string; reason: string | null; s: number | null }>;

    const byId = new Map(rows.map((r) => [r.id, r]));
    const marked = (id: number) => expect(byId.get(id)?.s).not.toBeNull();

    // 1 — the queued copy leaves the queue, keeping its own failure reason.
    expect(byId.get(1)).toMatchObject({ status: "failed", reason: "session died" });
    marked(1);
    // 2 — no reason of its own, so it gets the generic one.
    expect(byId.get(2)?.status).toBe("failed");
    expect(byId.get(2)?.reason).toContain("Superseded by a project merge");
    marked(2);
    // 3 — a failed copy keeps its status and its reason; it is still marked.
    expect(byId.get(3)).toMatchObject({ status: "failed", reason: "boom" });
    marked(3);
    // 4 — a done copy stays done (and is marked, though it is not retryable).
    expect(byId.get(4)?.status).toBe("done");
    marked(4);
    // 5 — an ordinary queued task is untouched.
    expect(byId.get(5)).toMatchObject({ status: "ready", reason: null, s: null });
    // 6 — a manually archived LOCAL task is NOT superseded: nothing may take
    // its Retry away (that is #1015's deliberate escape hatch).
    expect(byId.get(6)).toMatchObject({ status: "failed", reason: "boom", s: null });
    // 7 — a manually archived GitHub task is not superseded either.
    expect(byId.get(7)).toMatchObject({ status: "failed", reason: "boom", s: null });
    // 8 — recognized by the merge's own wording.
    expect(byId.get(8)).toMatchObject({
      status: "failed",
      reason: "Merged from project #7: superseded.",
    });
    marked(8);
    // 9 — the UNARCHIVED superseded copy: it leaves the queue too, and it is
    // marked. This is the row that would otherwise stay `ready` and be
    // claimed by the sweep — a duplicate worker for an issue another task
    // already owns.
    expect(byId.get(9)).toMatchObject({ status: "failed" });
    expect(byId.get(9)?.reason).toContain("Superseded by a project merge");
    marked(9);
    // 10 — an archived queued copy that predates html_url and kept an
    //      unrelated failure reason: only a merge archives a queued task, so
    //      it is superseded all the same.
    expect(byId.get(10)).toMatchObject({ status: "failed", reason: "session died" });
    marked(10);
    // 11 — an ordinary LOCAL queued task keeps its place in the queue.
    expect(byId.get(11)).toMatchObject({ status: "ready", reason: null, s: null });
    // 12 — an unarchived failed copy: the marker is what keeps its Retry
    //      refused, and it does not depend on the row being archived.
    expect(byId.get(12)).toMatchObject({ status: "failed", reason: "boom" });
    marked(12);

    db.close();
  });
});
