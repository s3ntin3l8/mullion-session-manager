import type { RefObject } from "react";
import { ChevronDownIcon, CloseIcon, SearchIcon } from "../ui/icons.js";
import { formatMatchCount } from "../lib/terminalKeys.js";

// Terminal scrollback search (U1) find bar — opened via Ctrl+Shift+F (see
// TerminalPane.tsx's attachKeyConflictHandler for why that chord and not
// bare Ctrl+F). Extracted verbatim from TerminalPane.tsx (PR 35, Wave 6 of
// .claude/plans/can-we-do-a-warm-cocke.md); state/logic lives in the paired
// useTerminalSearch hook (frontend/src/hooks/useTerminalSearch.ts) — this
// component is pure render. Positioned top-left rather than sharing the
// attach-image button's top-right corner (`.terminal-attach-image-btn`,
// always visible) so the two never collide.
export interface TerminalFindBarProps {
  findQuery: string;
  onFindQueryChange: (query: string) => void;
  matchState: { index: number; count: number } | null;
  findInputRef: RefObject<HTMLInputElement | null>;
  onRunSearch: (direction: "next" | "previous") => void;
  onClose: () => void;
}

export function TerminalFindBar({
  findQuery,
  onFindQueryChange,
  matchState,
  findInputRef,
  onRunSearch,
  onClose,
}: TerminalFindBarProps) {
  return (
    <div className="terminal-find-bar" role="search">
      <SearchIcon size={13} className="terminal-find-icon" />
      <input
        ref={findInputRef}
        type="text"
        className="terminal-find-input"
        placeholder="Find in scrollback…"
        aria-label="Find in scrollback"
        value={findQuery}
        onChange={(event) => onFindQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            // Local close only — App.tsx's global Escape handler also
            // fires on this same keydown (it bubbles to `window`), but
            // that handler only ever closes the command palette/settings
            // modal, both no-ops here, so the two never fight.
            event.preventDefault();
            onClose();
          } else if (event.key === "Enter") {
            event.preventDefault();
            onRunSearch(event.shiftKey ? "previous" : "next");
          }
        }}
      />
      {
        // aria-live so screen-reader users hear result updates as they
        // type/navigate, not just sighted users watching the counter
        // (Hermes review, PR #578).
      }
      <span className="terminal-find-count" aria-live="polite">
        {formatMatchCount(matchState)}
      </span>
      <button
        className="pane-tab-btn terminal-find-btn"
        title="Previous match (Shift+Enter)"
        disabled={!findQuery}
        onClick={() => onRunSearch("previous")}
      >
        <ChevronDownIcon size={13} style={{ transform: "rotate(180deg)" }} />
      </button>
      <button
        className="pane-tab-btn terminal-find-btn"
        title="Next match (Enter)"
        disabled={!findQuery}
        onClick={() => onRunSearch("next")}
      >
        <ChevronDownIcon size={13} />
      </button>
      <button className="pane-tab-btn terminal-find-btn" title="Close (Esc)" onClick={onClose}>
        <CloseIcon size={13} />
      </button>
    </div>
  );
}
