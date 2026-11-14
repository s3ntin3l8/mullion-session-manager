import { describe, expect, it } from "vitest";
import {
  EMPTY_FOLD_HALVES,
  canGoRight,
  halfOf,
  moveToHalf,
  noteOpen,
  noteShownLeft,
  noteUsed,
  paneForPhone,
  panesToReopen,
  parseFoldHalves,
  forgetPanes,
  showRight,
  splitByHalf,
  toggleRight,
} from "./foldHalves.js";
import type { FoldHalvesState } from "./foldHalves.js";

const open = ["session-1", "session-2", "git-4"];
const state = (over: Partial<FoldHalvesState> = {}): FoldHalvesState => ({
  ...EMPTY_FOLD_HALVES,
  ...over,
});

describe("foldHalves assignment", () => {
  it("puts every pane on the left until one is moved", () => {
    const s = state();
    expect(open.map((id) => halfOf(s, id))).toEqual(["left", "left", "left"]);
    expect(
      splitByHalf(
        s,
        open.map((id) => ({ id })),
      ),
    ).toEqual({
      left: open.map((id) => ({ id })),
      right: [],
    });
  });

  it("moves a session to the right half, shows it there and makes it the one used last", () => {
    const s = moveToHalf(state({ shownLeft: "session-2" }), "session-2", "right", open);
    expect(s.right).toEqual(["session-2"]);
    expect(s.shownRight).toBe("session-2");
    // The left half's shown pane moved away: another left pane takes over.
    expect(s.shownLeft).toBe("session-1");
    expect(s.lastUsed).toEqual({ kind: "pane", panelId: "session-2" });
    expect(
      splitByHalf(
        s,
        open.map((id) => ({ id })),
      ).right,
    ).toEqual([{ id: "session-2" }]);
  });

  it("refuses to empty the left half, and refuses a non-terminal pane", () => {
    const one = moveToHalf(state(), "session-1", "right", ["session-1"]);
    expect(one).toEqual(state());
    expect(moveToHalf(state(), "git-4", "right", open)).toEqual(state());
    expect(canGoRight("git-4")).toBe(false);
    expect(canGoRight("session-12")).toBe(true);
  });

  it("re-shows a session that is already on the right instead of adding it twice", () => {
    const s = state({ right: ["session-2"], shownRight: null });
    expect(moveToHalf(s, "session-2", "right", open)).toEqual({ ...s, shownRight: "session-2" });
  });

  it("moves a session back to the left, where it shows", () => {
    const s = moveToHalf(
      state({ right: ["session-2"], shownRight: "session-2" }),
      "session-2",
      "left",
      open,
    );
    expect(s.right).toEqual([]);
    expect(s.shownRight).toBeNull();
    expect(s.shownLeft).toBe("session-2");
    // A left move of a pane already on the left changes nothing.
    expect(moveToHalf(s, "session-1", "left", open)).toBe(s);
  });

  it("toggles a right-rail session like a view tab", () => {
    const s = state({ right: ["session-2"] });
    const shown = toggleRight(s, "session-2");
    expect(shown.shownRight).toBe("session-2");
    expect(toggleRight(shown, "session-2").shownRight).toBeNull();
    expect(toggleRight(s, "session-1")).toBe(s);
  });

  it("shows or closes the right half", () => {
    const s = state({ right: ["session-2"] });
    expect(showRight(s, "session-2").shownRight).toBe("session-2");
    expect(showRight(s, "session-1")).toBe(s);
    expect(showRight(showRight(s, "session-2"), null).shownRight).toBeNull();
  });

  it("records the left half's pane, used or only shown", () => {
    const s = noteShownLeft(state(), "session-1", false);
    expect(s.shownLeft).toBe("session-1");
    expect(s.lastUsed).toBeNull();
    const used = noteShownLeft(s, "session-1");
    expect(used.lastUsed).toEqual({ kind: "pane", panelId: "session-1" });
    expect(noteShownLeft(used, "session-1")).toBe(used);
    expect(noteShownLeft(state({ right: ["session-2"] }), "session-2")).toEqual(
      state({ right: ["session-2"] }),
    );
  });

  it("records what was used last, a pane or the view", () => {
    const view = noteUsed(state(), { kind: "view" });
    expect(view.lastUsed).toEqual({ kind: "view" });
    expect(noteUsed(view, { kind: "view" })).toBe(view);
    expect(paneForPhone(view)).toBeNull();
    const pane = noteUsed(view, { kind: "pane", panelId: "session-2" });
    expect(paneForPhone(pane)).toBe("session-2");
    expect(noteUsed(pane, { kind: "pane", panelId: "session-2" })).toBe(pane);
  });
});

describe("foldHalves upkeep", () => {
  it("forgets panes seen closing, and leaves a state with nothing to forget as it is", () => {
    const s = state({
      right: ["session-2", "session-9"],
      shownRight: "session-9",
      shownLeft: "session-8",
      lastUsed: { kind: "pane", panelId: "session-9" },
      open: ["session-1", "session-9"],
    });
    expect(forgetPanes(s, ["session-9", "session-8"])).toEqual({
      right: ["session-2"],
      shownRight: null,
      shownLeft: null,
      lastUsed: null,
      open: ["session-1"],
    });
    expect(forgetPanes(s, [])).toBe(s);
    expect(forgetPanes(s, ["session-77"])).toBe(s);
  });

  it("remembers the open sessions and names the ones a restore lost", () => {
    const s = noteOpen(state(), open);
    expect(s.open).toEqual(["session-1", "session-2"]);
    expect(noteOpen(s, open)).toBe(s);
    expect(panesToReopen(s, ["session-1"])).toEqual(["session-2"]);
    expect(panesToReopen(s, open)).toEqual([]);
  });

  it("reads a stored map defensively", () => {
    expect(parseFoldHalves(null)).toEqual({});
    expect(parseFoldHalves("x")).toEqual({});
    expect(
      parseFoldHalves({
        "3": {
          right: ["session-2", 7],
          shownRight: "session-2",
          shownLeft: 5,
          lastUsed: { kind: "view" },
          open: ["session-2"],
        },
        "4": { lastUsed: { kind: "pane", panelId: "session-1" } },
        "5": { lastUsed: { kind: "pane" } },
        nope: { right: [] },
        "6": null,
      }),
    ).toEqual({
      3: {
        right: ["session-2"],
        shownRight: "session-2",
        shownLeft: null,
        lastUsed: { kind: "view" },
        open: ["session-2"],
      },
      4: { ...EMPTY_FOLD_HALVES, lastUsed: { kind: "pane", panelId: "session-1" } },
      5: EMPTY_FOLD_HALVES,
    });
  });
});
