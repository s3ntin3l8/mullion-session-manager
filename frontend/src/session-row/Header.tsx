import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ConfirmButton } from "../ui/ConfirmButton.js";
import { KebabMenu } from "../ui/KebabMenu.js";
import {
  BellIcon,
  BellOffIcon,
  ChevronDownIcon,
  CloseIcon,
  GitBranchIcon,
  RenameIcon,
} from "../ui/icons.js";

// SessionRow's row 1 — the `.session-item-row` strip (status dot, agent
// logo/name, rename-in-place, status label, git-details toggle, kebab menu,
// end-session button). Extracted verbatim from SessionRow (PR 27 phase 2,
// Wave 5 of .claude/plans/can-we-do-a-warm-cocke.md).
//
// Rename state (`renaming`/`draftName`/the blur-suppression ref/the
// focus-on-mount effect) moved DOWN into local state here — unlike
// `gitLineExpanded`/`promoteOpen`/`endError`, which stayed at the top
// (SessionRow) level because something outside this row also reads them
// (the git-line's own visibility, the PromoteDialog sibling, the
// end-session error line) — nothing outside this component ever reads
// `renaming`/`draftName`. `onRename` is the one seam back out: it's the
// store's `renameSession` action, pre-bound to this session's id by
// SessionRow, so this component itself never touches the store directly
// (keeps it prop-driven and independently testable, matching
// GitLine/FileChanges/Chips' own shape).
//
// `dot`/`statusLabel` come in as already-built JSX (SessionRow computes both
// from `session.sessionStatus`/`sessionStatusSeverity`/hookEmits — see that
// component's own comments) rather than this component re-deriving them,
// same "shared/coordinating derivation stays where multiple regions need
// it" reasoning as gitLineExpanded above; SessionRow's own outer wrapper div
// needs `statusEstimated`/`statusClass` (derived from the same session
// fields) for its own className independent of this row.
export interface HeaderProps {
  title: string;
  showCommand: boolean;
  agentLogo: string | null;
  showAgentFallback: boolean;
  agentBinary: string;
  dot: ReactNode;
  statusLabel: ReactNode;
  // Sidebar declutter — the chevron now toggles ALL of SessionRow's history
  // sections (session-row/Details.tsx: git/files/agents/said), not just git
  // as the surrounding prop names' history suggests (`alwaysExpandGit`/
  // `gitLineExpanded` kept as-is rather than renamed detail-generic — see
  // SessionRow's own comment). `hasDetails` is "is there ANYTHING to show",
  // computed across every section (SessionRow's `detailsAvailable`), which
  // is what actually decides whether the toggle renders at all.
  hasDetails: boolean;
  alwaysExpandGit: boolean;
  gitLineExpanded: boolean;
  onToggleGitLineExpanded: () => void;
  isTerminal: boolean;
  onOpenAsFloat?: () => void;
  onPromote: () => void;
  onRename: (value: string) => void;
  childCount: number;
  confirmBeforeKill: boolean;
  // #719 — per-session mute. `isMuted` is the live derived state and
  // `onToggleMute` the store action, both supplied by SessionRow (which owns
  // the session + store wiring) so this component stays prop-driven.
  isMuted: boolean;
  onToggleMute: () => void;
  // Named onConfirmEnd (not onEnd) deliberately: SessionRow's own `onEnd`
  // prop is the caller's raw ender (`() => void | Promise<void>`, per that
  // prop's own doc comment) — this is SessionRow's already-wrapped
  // `handleEnd`, a same-file, different-contract value one hop away. Same
  // name for both would be exactly the kind of one-character-diff trap this
  // split is supposed to make easier to review, not harder.
  onConfirmEnd: () => void;
}

export function Header({
  title,
  showCommand,
  agentLogo,
  showAgentFallback,
  agentBinary,
  dot,
  statusLabel,
  hasDetails,
  alwaysExpandGit,
  gitLineExpanded,
  onToggleGitLineExpanded,
  isTerminal,
  onOpenAsFloat,
  onPromote,
  onRename,
  childCount,
  confirmBeforeKill,
  isMuted,
  onToggleMute,
  onConfirmEnd,
}: HeaderProps) {
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState("");
  const suppressBlurRef = useRef(false);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renaming]);

  const commitRename = () => {
    const value = draftName.trim();
    suppressBlurRef.current = true;
    setRenaming(false);
    if (!value) return;
    onRename(value);
  };

  return (
    <div className="session-item-row">
      {dot}
      {agentLogo && (
        <img src={agentLogo} alt="" width={14} height={14} className="session-agent-logo" />
      )}
      {showAgentFallback && <span className="session-agent-text">{agentBinary}</span>}
      {renaming ? (
        <input
          ref={renameInputRef}
          className="session-rename-input"
          value={draftName}
          // P10 — matches WorkspaceSwitcher.tsx's own rename inputs
          // (`.workspace-rename-input`): without this, clicking into the
          // field to place the cursor also bubbles up as a click on the
          // row and fires `onOpen`, same class of bug the row's `onKeyDown`
          // guard exists to prevent for the keyboard case.
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setDraftName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            else if (e.key === "Escape") {
              suppressBlurRef.current = true;
              setRenaming(false);
            }
          }}
          onBlur={() => {
            if (!suppressBlurRef.current) commitRename();
            suppressBlurRef.current = false;
          }}
        />
      ) : (
        <span
          className={`session-name${showCommand ? " mono" : ""}`}
          title={title}
          onDoubleClick={(e) => {
            e.stopPropagation();
            suppressBlurRef.current = false;
            setDraftName(title);
            setRenaming(true);
          }}
        >
          {title}
        </span>
      )}
      {statusLabel}
      {/* Sidebar declutter — was row 3's git-only toggle (issue #202); now
        gates every history section session-row/Details.tsx renders (git,
        files, agents, the agent's last message), not just git. `hasDetails`
        (SessionRow's own `detailsAvailable`) is "is there ANYTHING to show",
        computed across all those sections — "nothing to show" means no
        toggle at all, not one that expands to an empty row. Suppressed
        entirely when `alwaysExpandGit` is set (a caller with room to always
        show details) — there's nothing to toggle then. */}
      {hasDetails && !alwaysExpandGit && (
        <span onClick={(e) => e.stopPropagation()}>
          <button
            className="session-git-toggle"
            title={gitLineExpanded ? "Hide details" : "Show details"}
            aria-expanded={gitLineExpanded}
            onClick={onToggleGitLineExpanded}
          >
            <ChevronDownIcon
              size={11}
              className={gitLineExpanded ? "ws-group-chevron" : "ws-group-chevron collapsed"}
            />
          </button>
        </span>
      )}
      {!isTerminal && (
        <span onClick={(e) => e.stopPropagation()}>
          <KebabMenu
            title="More…"
            items={[
              ...(onOpenAsFloat
                ? [
                    {
                      key: "open-as-float",
                      label: "Open as new window",
                      onClick: onOpenAsFloat,
                    } as const,
                  ]
                : []),
              {
                key: "rename",
                label: "Rename",
                icon: <RenameIcon size={14} style={{ color: "var(--muted)" }} />,
                onClick: () => {
                  suppressBlurRef.current = false;
                  setDraftName(title);
                  setRenaming(true);
                },
              } as const,
              {
                key: "promote",
                label: "Promote to worktree…",
                icon: <GitBranchIcon size={14} style={{ color: "var(--muted)" }} />,
                onClick: onPromote,
              } as const,
              {
                key: "mute",
                label: isMuted ? "Unmute notifications" : "Mute notifications",
                icon: isMuted ? (
                  <BellOffIcon size={14} style={{ color: "var(--muted)" }} />
                ) : (
                  <BellIcon size={14} style={{ color: "var(--muted)" }} />
                ),
                onClick: onToggleMute,
              } as const,
            ]}
          />
        </span>
      )}
      {!isTerminal && (
        <span onClick={(e) => e.stopPropagation()}>
          <ConfirmButton
            title={
              childCount > 0
                ? `End this session — ${childCount} running child session${childCount === 1 ? "" : "s"} will keep running independently`
                : "End this session (the program will be terminated)"
            }
            onConfirm={onConfirmEnd}
            // Phase 5 (Track B, issue #196 5.6) — always require the
            // arm-then-confirm step when this session has live children,
            // regardless of the global "confirm before kill" setting.
            // Ending it always defaults to detach (see killSession), never
            // a silent cascade-kill, but a user with that setting off
            // should still see the child count before it fires — that's
            // the one thing skipConfirm would otherwise skip entirely.
            skipConfirm={!confirmBeforeKill && childCount === 0}
          >
            <CloseIcon size={11} />
          </ConfirmButton>
        </span>
      )}
    </div>
  );
}
