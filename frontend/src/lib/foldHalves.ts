// The two halves between 800 and 1099px (#3010, design section 2): which of a
// workspace's panes show on the left half and which on the right. Per device,
// per workspace, kept in localStorage; never written into the workspace's
// saved layout, which desktop shares. Pure: the store keeps one of these per
// workspace and App presents it.
//
// Ids are dockview panel ids (`session-<id>` for a terminal). Only a terminal
// can go to the right half: the right half renders the session's terminal on
// its own, outside the grid, and the left half is always a session or other
// grid pane shown by maximizing its group.

export type Half = "left" | "right";

/** What was used last, for the phone layout after folding (design 9.2): a
 * pane, or the right sidebar's open view. */
export type LastUsed = { kind: "pane"; panelId: string } | { kind: "view" } | null;

export interface FoldHalvesState {
  /** Panes assigned to the right half, in the order they were moved there. */
  right: string[];
  /** The right-half pane on show; null when the right half is closed. */
  shownRight: string | null;
  /** The pane last shown on the left half, restored on unfolding. */
  shownLeft: string | null;
  lastUsed: LastUsed;
  /** The terminal panes open while the halves were last on screen. The
   *  halves never save the workspace's layout, so a session opened here is
   *  remembered on this device instead, and reopened after a reload. */
  open: string[];
}

export const EMPTY_FOLD_HALVES: FoldHalvesState = {
  right: [],
  shownRight: null,
  shownLeft: null,
  lastUsed: null,
  open: [],
};

/** Records the terminal panes open now (only while the halves show). */
export function noteOpen(state: FoldHalvesState, openIds: readonly string[]): FoldHalvesState {
  const open = openIds.filter(canGoRight);
  if (open.length === state.open.length && open.every((id, i) => id === state.open[i])) {
    return state;
  }
  return { ...state, open };
}

/** Sessions remembered as open here but missing from the restored layout. */
export function panesToReopen(state: FoldHalvesState, openIds: readonly string[]): string[] {
  const present = new Set(openIds);
  return state.open.filter((id) => !present.has(id));
}

export function halfOf(state: FoldHalvesState, panelId: string): Half {
  return state.right.includes(panelId) ? "right" : "left";
}

/** Only a terminal pane can be shown on the right half. */
export function canGoRight(panelId: string): boolean {
  return /^session-\d+$/.test(panelId);
}

/** Splits open panes by half, keeping the order they come in. */
export function splitByHalf<T extends { id: string }>(
  state: FoldHalvesState,
  panes: readonly T[],
): { left: T[]; right: T[] } {
  const left: T[] = [];
  const right: T[] = [];
  for (const pane of panes) (halfOf(state, pane.id) === "right" ? right : left).push(pane);
  return { left, right };
}

/**
 * Moves a pane to a half. A move to the right shows it there; a move that
 * would leave the left half with nothing to show is refused (the left half is
 * never empty while panes are open), as is moving a non-terminal pane right.
 * `openIds` are the tiled panes open in the workspace now: the left half
 * shows a tiled pane by maximizing its group, so a float cannot keep it
 * from being empty, and callers leave floats out.
 */
export function moveToHalf(
  state: FoldHalvesState,
  panelId: string,
  half: Half,
  openIds: readonly string[],
): FoldHalvesState {
  if (half === "right") {
    if (!canGoRight(panelId) || state.right.includes(panelId)) {
      return state.right.includes(panelId) ? { ...state, shownRight: panelId } : state;
    }
    const leftAfter = openIds.filter((id) => id !== panelId && !state.right.includes(id));
    if (leftAfter.length === 0) return state;
    return {
      ...state,
      right: [...state.right, panelId],
      shownRight: panelId,
      shownLeft: state.shownLeft === panelId ? leftAfter[0]! : state.shownLeft,
      lastUsed: { kind: "pane", panelId },
    };
  }
  if (!state.right.includes(panelId)) return state;
  return {
    ...state,
    right: state.right.filter((id) => id !== panelId),
    shownRight: state.shownRight === panelId ? null : state.shownRight,
    shownLeft: panelId,
    lastUsed: { kind: "pane", panelId },
  };
}

/** A right-rail session as a view tab: tap shows it, tap again hides it. */
export function toggleRight(state: FoldHalvesState, panelId: string): FoldHalvesState {
  if (!state.right.includes(panelId)) return state;
  if (state.shownRight === panelId) return { ...state, shownRight: null };
  return { ...state, shownRight: panelId, lastUsed: { kind: "pane", panelId } };
}

export function showRight(state: FoldHalvesState, panelId: string | null): FoldHalvesState {
  if (panelId !== null && !state.right.includes(panelId)) return state;
  if (state.shownRight === panelId) return state;
  return {
    ...state,
    shownRight: panelId,
    lastUsed: panelId === null ? state.lastUsed : { kind: "pane", panelId },
  };
}

/** Records the left half's pane; `used` also makes it the one used last (a
 * tap or a focus, not a pane put back on show by the layout itself). */
export function noteShownLeft(
  state: FoldHalvesState,
  panelId: string,
  used = true,
): FoldHalvesState {
  if (state.right.includes(panelId)) return state;
  const wasUsed = state.lastUsed?.kind === "pane" && state.lastUsed.panelId === panelId;
  if (state.shownLeft === panelId && (wasUsed || !used)) return state;
  return {
    ...state,
    shownLeft: panelId,
    lastUsed: used ? { kind: "pane", panelId } : state.lastUsed,
  };
}

export function noteUsed(state: FoldHalvesState, used: LastUsed): FoldHalvesState {
  if (
    used === state.lastUsed ||
    (used?.kind === "view" && state.lastUsed?.kind === "view") ||
    (used?.kind === "pane" &&
      state.lastUsed?.kind === "pane" &&
      used.panelId === state.lastUsed.panelId)
  ) {
    return state;
  }
  return { ...state, lastUsed: used };
}

/**
 * Forgets panes that were closed. Only a pane seen closing is forgotten, not
 * one merely missing after a restore: the halves (and the phone) never save
 * the layout, so after a reload the server's layout lacks the sessions opened
 * here, and they are reopened rather than forgotten (panesToReopen).
 */
export function forgetPanes(state: FoldHalvesState, closedIds: readonly string[]): FoldHalvesState {
  if (closedIds.length === 0) return state;
  const closed = new Set(closedIds);
  const keep = (id: string | null) => (id !== null && closed.has(id) ? null : id);
  const right = state.right.filter((id) => !closed.has(id));
  const open = state.open.filter((id) => !closed.has(id));
  const shownRight = keep(state.shownRight);
  const shownLeft = keep(state.shownLeft);
  const lastUsed =
    state.lastUsed?.kind === "pane" && closed.has(state.lastUsed.panelId) ? null : state.lastUsed;
  if (
    right.length === state.right.length &&
    open.length === state.open.length &&
    shownRight === state.shownRight &&
    shownLeft === state.shownLeft &&
    lastUsed === state.lastUsed
  ) {
    return state;
  }
  return { right, shownRight, shownLeft, lastUsed, open };
}

/**
 * The pane the phone layout shows after folding (design 9.2): the one used
 * last, typed in or tapped, whichever half it was on. Null when the right
 * sidebar's view was used last (the phone shows that view) or nothing is
 * known (the phone keeps its own choice).
 */
export function paneForPhone(state: FoldHalvesState): string | null {
  return state.lastUsed?.kind === "pane" ? state.lastUsed.panelId : null;
}

/** Reads a stored map defensively: anything malformed becomes empty. */
export function parseFoldHalves(raw: unknown): Record<number, FoldHalvesState> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<number, FoldHalvesState> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const id = Number(key);
    if (!Number.isSafeInteger(id) || !value || typeof value !== "object") continue;
    const v = value as Partial<FoldHalvesState>;
    const str = (x: unknown) => (typeof x === "string" ? x : null);
    const last = v.lastUsed as LastUsed | undefined;
    // A hand-edited or stale entry must not put a non-terminal on the right
    // half, or show a pane there that is not assigned to it.
    const right = Array.isArray(v.right)
      ? v.right.filter((x): x is string => typeof x === "string" && canGoRight(x))
      : [];
    const shownRight = str(v.shownRight);
    out[id] = {
      right,
      shownRight: shownRight !== null && right.includes(shownRight) ? shownRight : null,
      shownLeft: str(v.shownLeft),
      lastUsed:
        last && last.kind === "view"
          ? { kind: "view" }
          : last && last.kind === "pane" && typeof last.panelId === "string"
            ? { kind: "pane", panelId: last.panelId }
            : null,
      open: Array.isArray(v.open) ? v.open.filter((x): x is string => typeof x === "string") : [],
    };
  }
  return out;
}
