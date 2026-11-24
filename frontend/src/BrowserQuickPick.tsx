import { useEffect, useRef, useState } from "react";
import { api } from "./api/index.js";
import { browserApi } from "./api/browser.js";
import type { BrowserDestination } from "./api/index.js";
import { BottomSheet } from "./ui/BottomSheet.js";
import { ChevronDownIcon } from "./ui/icons.js";
import { useCoarsePointer } from "./lib/layoutTier.js";
import { describeError } from "./lib/describeError.js";
import { readBrowserRecents } from "./lib/browserRecents.js";
import type { BrowserMode } from "./lib/browserTitles.js";

// #3003 — the Browser pane's quick pick: the "▾" beside the address, in both
// modes (docs/design/one-browser-pane/note.md). It lists where the pane's
// project can be opened, in the order the owner decided: running now (Dock
// commands with a detected port, Compose services with a published port),
// saved for the project (its dev server, named targets, branch previews),
// then this browser's recent addresses. What a pick opens is the shell's
// business (BrowserShell.tsx): this component only lists, explains and
// reports the pick. A popover under a fine pointer, a sheet with 48px rows
// under a coarse one.

export type QuickPickEntry =
  { source: "destination"; destination: BrowserDestination } | { source: "recent"; url: string };

/** What the list knows that decides how an entry opens. */
export interface QuickPickContext {
  /** PREVIEW_BASE_HOST is set: previews go through the proxy. */
  previewsEnabled: boolean;
}

type Loaded =
  | { status: "idle" | "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; destinations: BrowserDestination[]; runningNote: string | null };

interface Row {
  key: string;
  entry: QuickPickEntry;
  label: string;
  detail: string | null;
}

interface Group {
  title: string;
  rows: Row[];
  note?: string | null;
}

function destinationRows(list: BrowserDestination[], group: "running" | "saved"): Row[] {
  return list
    .filter((d) => d.group === group)
    .map((d) => ({
      key: d.key,
      entry: { source: "destination", destination: d },
      label: d.label,
      detail: d.detail,
    }));
}

export function BrowserQuickPick({
  projectId,
  mode,
  refusal,
  onPick,
}: {
  /** The project whose destinations to list; null lists recent addresses only. */
  projectId: number | null;
  mode: BrowserMode;
  /** Why an entry cannot open in this mode, or null when it can. */
  refusal: (entry: QuickPickEntry, context: QuickPickContext) => string | null;
  onPick: (entry: QuickPickEntry, context: QuickPickContext) => void;
}) {
  const coarse = useCoarsePointer();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<Loaded>({ status: "idle" });
  const [recents, setRecents] = useState<string[]>([]);
  // Null until the server says whether previews go through the proxy, since
  // that decides what an entry opens (the proxied address, decision 2).
  const [context, setContext] = useState<QuickPickContext | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Read fresh on every open: a running service comes and goes. The open
  // handler resets what the list shows; this effect only fetches.
  const openList = () => {
    setRecents(readBrowserRecents(mode));
    setContext(null);
    setLoaded(
      projectId == null
        ? { status: "ready", destinations: [], runningNote: null }
        : { status: "loading" },
    );
    setOpen(true);
  };
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api
      .getServerInfo()
      .then((info) => {
        if (!cancelled) setContext({ previewsEnabled: Boolean(info.previewsEnabled) });
      })
      .catch(() => {
        // Unknown counts as no proxy: an entry then opens its own address.
        if (!cancelled) setContext({ previewsEnabled: false });
      });
    if (projectId != null) {
      browserApi
        .getBrowserDestinations(projectId)
        .then((result) => {
          if (!cancelled) setLoaded({ status: "ready", ...result });
        })
        .catch((err) => {
          if (!cancelled) {
            setLoaded({
              status: "error",
              message: describeError(err, "Could not load this project's services"),
            });
          }
        });
    }
    return () => {
      cancelled = true;
    };
  }, [open, projectId]);

  // The popover closes on a click outside it or Escape; the sheet has its own.
  useEffect(() => {
    if (!open || coarse) return;
    const onDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, coarse]);

  const destinations = loaded.status === "ready" ? loaded.destinations : [];
  const groups: Group[] = [];
  if (projectId != null) {
    groups.push({
      title: "Running now",
      rows: destinationRows(destinations, "running"),
      note: loaded.status === "ready" ? loaded.runningNote : null,
    });
    groups.push({ title: "Saved", rows: destinationRows(destinations, "saved") });
  }
  groups.push({
    title: "Recent",
    rows: recents.map((url) => ({
      key: `recent:${url}`,
      entry: { source: "recent", url },
      label: url,
      detail: null,
    })),
  });

  const pick = (row: Row) => {
    if (context == null || refusal(row.entry, context) != null) return;
    setOpen(false);
    onPick(row.entry, context);
  };

  const body = (
    <div className="browser-quick-pick-list" role="menu" aria-label="Open in this browser">
      {loaded.status === "loading" && <div className="browser-quick-pick-status">Loading…</div>}
      {loaded.status === "error" && (
        <div className="browser-quick-pick-status" role="alert">
          {loaded.message}
        </div>
      )}
      {groups.map((group) => (
        <div
          key={group.title}
          className="browser-quick-pick-group"
          role="group"
          aria-label={group.title}
        >
          <div className="browser-quick-pick-heading">{group.title}</div>
          {group.rows.length === 0 && (
            <div className="browser-quick-pick-empty">
              {group.note ??
                (loaded.status === "loading" && group.title !== "Recent" ? "…" : "None")}
            </div>
          )}
          {group.rows.length > 0 && group.note && (
            <div className="browser-quick-pick-empty">{group.note}</div>
          )}
          {group.rows.map((row) => {
            const reason = context == null ? "Loading…" : refusal(row.entry, context);
            return (
              <button
                key={row.key}
                type="button"
                role="menuitem"
                className="browser-quick-pick-item"
                aria-disabled={reason != null || undefined}
                title={reason ?? row.detail ?? row.label}
                onClick={() => pick(row)}
              >
                <span className="browser-quick-pick-label">{row.label}</span>
                {(reason ?? row.detail) && (
                  <span className="browser-quick-pick-detail">{reason ?? row.detail}</span>
                )}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );

  return (
    <div className="browser-quick-pick" ref={containerRef}>
      <button
        type="button"
        className="browser-panel-reload browser-quick-pick-btn"
        aria-label="Quick pick: running services, saved and recent pages"
        title="Running services, saved and recent pages"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openList())}
      >
        <ChevronDownIcon size={11} />
      </button>
      {open && !coarse && <div className="browser-quick-pick-menu">{body}</div>}
      {coarse && (
        <BottomSheet
          open={open}
          onClose={() => setOpen(false)}
          label="Open in this browser"
          closeLabel="Close quick pick"
          title="Open in this browser"
          sheetClassName="browser-quick-pick-sheet"
          backStack
        >
          {body}
        </BottomSheet>
      )}
    </div>
  );
}
