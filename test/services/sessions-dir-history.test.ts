import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  readSessionsDirHistory,
  recordSessionsDir,
  SESSIONS_DIR_HISTORY_FILE,
  SESSIONS_DIR_HISTORY_LIMIT,
  sessionsDirHistoryPath,
} from "../../src/services/sessions-dir-history.js";

// Issue #1771 — the trail of dirs this install has resolved. The file lives
// in the install root (MULLION_HOME), which is where a versioned-release
// install keeps its state (see deploy/install.sh's layout).

const homes: string[] = [];

/** A fresh, empty install root. */
function makeHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "mullion-home-"));
  homes.push(home);
  return home;
}

/** The trail file's path inside an install root. */
function trailFile(home: string): string {
  return path.join(home, SESSIONS_DIR_HISTORY_FILE);
}

afterEach(() => {
  while (homes.length > 0) {
    rmSync(homes.pop() as string, { recursive: true, force: true });
  }
});

describe("readSessionsDirHistory", () => {
  it("has no history at all without an install root (a dev checkout)", () => {
    const history = readSessionsDirHistory("");
    expect(history.dirs).toEqual([]);
    expect(history.warning).toBeUndefined();
  });

  it("treats a missing file as the normal case, not a problem", () => {
    const history = readSessionsDirHistory(makeHome());
    expect(history.dirs).toEqual([]);
    expect(history.warning).toBeUndefined();
  });

  it("reads the dirs in the order the file lists them", () => {
    const home = makeHome();
    const first = path.join(home, "sessions-a");
    const second = path.join(home, "sessions-b");
    writeFileSync(trailFile(home), JSON.stringify({ dirs: [first, second] }));
    const history = readSessionsDirHistory(home);
    expect(history.dirs).toEqual([first, second]);
    expect(history.warning).toBeUndefined();
  });

  it("reports a corrupt file and ignores it, rather than throwing", () => {
    // A half-written or hand-mangled file must never stop the boot: the
    // resolver proceeds with the dirs it can derive on its own.
    const home = makeHome();
    writeFileSync(trailFile(home), "{not json");
    const history = readSessionsDirHistory(home);
    expect(history.dirs).toEqual([]);
    expect(history.warning).toMatch(/not readable JSON/);
  });

  it("ignores entries that are not absolute paths", () => {
    // A relative path would resolve against whatever cwd happened to be, so
    // it is not a dir this install can own — it is not trusted.
    const home = makeHome();
    const absolute = path.join(home, "sessions");
    writeFileSync(
      trailFile(home),
      JSON.stringify({ dirs: ["relative/sessions", absolute, 42, null] }),
    );
    const history = readSessionsDirHistory(home);
    expect(history.dirs).toEqual([absolute]);
  });

  it("reports a file that is not a history at all", () => {
    // Valid JSON, but not the shape a history has — that is a problem
    // worth saying out loud, not an empty trail.
    const home = makeHome();
    writeFileSync(trailFile(home), JSON.stringify({ sessions: ["/tmp/x"] }));
    const history = readSessionsDirHistory(home);
    expect(history.dirs).toEqual([]);
    expect(history.warning).toMatch(/does not have the expected shape/);
  });

  it("applies the bound on READ too, so an over-long file cannot widen the set", () => {
    // The bound is not only a write-time rule: a file with more entries
    // than the limit (hand-edited, or written by a build with a different
    // limit) must not put more dirs into the owned set than the limit
    // allows.
    const home = makeHome();
    const many = Array.from({ length: SESSIONS_DIR_HISTORY_LIMIT + 4 }, (_, i) =>
      path.join(home, `sessions-${i}`),
    );
    writeFileSync(trailFile(home), JSON.stringify({ dirs: many }));
    const history = readSessionsDirHistory(home);
    expect(history.dirs).toHaveLength(SESSIONS_DIR_HISTORY_LIMIT);
    expect(history.dirs).toEqual(many.slice(-SESSIONS_DIR_HISTORY_LIMIT));
  });
});

describe("recordSessionsDir", () => {
  it("writes the dir into the trail, as the newest entry", () => {
    const home = makeHome();
    const dir = path.join(home, "sessions");
    const history = recordSessionsDir(home, dir);
    expect(history.dirs).toEqual([dir]);
    expect(history.warning).toBeUndefined();
    const written = JSON.parse(readFileSync(trailFile(home), "utf8")) as { dirs: string[] };
    expect(written.dirs).toEqual([dir]);
  });

  it("keeps the file private to its owner (0600)", () => {
    const home = makeHome();
    recordSessionsDir(home, path.join(home, "sessions"));
    expect(statSync(trailFile(home)).mode & 0o777).toBe(0o600);
  });

  it("moves a dir that is already in the trail to the newest position", () => {
    // The bound drops the OLDEST entries, so the dir in use has to be the
    // newest one — otherwise it could be dropped while still in use.
    const home = makeHome();
    const first = path.join(home, "sessions-a");
    const second = path.join(home, "sessions-b");
    recordSessionsDir(home, first);
    recordSessionsDir(home, second);
    const history = recordSessionsDir(home, first);
    expect(history.dirs).toEqual([second, first]);
  });

  it("is bounded — the oldest entry is dropped once the limit is reached", () => {
    const home = makeHome();
    for (let i = 0; i < SESSIONS_DIR_HISTORY_LIMIT + 3; i++) {
      recordSessionsDir(home, path.join(home, `sessions-${i}`));
    }
    const history = readSessionsDirHistory(home);
    expect(history.dirs).toHaveLength(SESSIONS_DIR_HISTORY_LIMIT);
    expect(history.dirs[history.dirs.length - 1]).toBe(
      path.join(home, `sessions-${SESSIONS_DIR_HISTORY_LIMIT + 2}`),
    );
    expect(history.dirs).not.toContain(path.join(home, "sessions-0"));
  });

  it("leaves no trail at all without an install root", () => {
    const history = recordSessionsDir("", path.join(tmpdir(), "sessions"));
    expect(history.dirs).toEqual([]);
    expect(history.warning).toBeUndefined();
  });

  it("leaves the file alone when the dir is already its newest entry", () => {
    // The early-return path: the file is exactly what would be written, so
    // it is not rewritten.
    const home = makeHome();
    const dir = path.join(home, "sessions");
    recordSessionsDir(home, dir);
    const before = readFileSync(trailFile(home), "utf8");
    const history = recordSessionsDir(home, dir);
    expect(history.dirs).toEqual([dir]);
    expect(readFileSync(trailFile(home), "utf8")).toBe(before);
  });

  it("trims an over-long file on the next record", () => {
    // The write path heals a file that is over the bound, even when the
    // dir it would record is already the newest entry.
    const home = makeHome();
    const many = Array.from({ length: SESSIONS_DIR_HISTORY_LIMIT + 4 }, (_, i) =>
      path.join(home, `sessions-${i}`),
    );
    const newest = many[many.length - 1];
    writeFileSync(trailFile(home), JSON.stringify({ dirs: many }));
    const history = recordSessionsDir(home, newest);
    expect(history.dirs).toHaveLength(SESSIONS_DIR_HISTORY_LIMIT);
    const onDisk = JSON.parse(readFileSync(trailFile(home), "utf8")) as { dirs: string[] };
    expect(onDisk.dirs).toHaveLength(SESSIONS_DIR_HISTORY_LIMIT);
    expect(onDisk.dirs[onDisk.dirs.length - 1]).toBe(newest);
  });

  it("reports an unwritable install root and keeps the dirs it already had", () => {
    // Never fatal: the trail is an aid, and the boot continues with the
    // dirs the resolver can derive.
    const home = makeHome();
    const dir = path.join(home, "sessions");
    recordSessionsDir(home, dir);
    const missing = path.join(home, "not-there", "deeper");
    const history = recordSessionsDir(missing, path.join(missing, "sessions"));
    expect(history.warning).toMatch(/could not be written/);
    expect(history.dirs).toEqual([]);
  });
});

describe("sessionsDirHistoryPath", () => {
  it("is the trail file inside the install root", () => {
    const home = makeHome();
    expect(sessionsDirHistoryPath(home)).toBe(trailFile(home));
  });

  it("is empty without an install root", () => {
    expect(sessionsDirHistoryPath("   ")).toBe("");
  });
});
