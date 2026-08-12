import type { Session } from "../api.js";
import type { Theme } from "../store.js";
import {
  STATUS_PRESENTATION,
  formatStatusLabel,
  rowClassNameForSeverity,
} from "../sessionStatus.js";
import { resolveAgentLogo } from "../cliLogos.js";
import { BotIcon, TerminalPromptIcon } from "../icons.js";

// Split out of UnifiedBoard.tsx (Wave 5 / PR 28 of
// .claude/plans/can-we-do-a-warm-cocke.md) — a compact, non-SessionRow strip
// nested on a task card (unlike the ad-hoc lane's own LaneCard.tsx, which
// reuses SessionRow verbatim — SessionRow's git/kill/rename/promote/subagent
// surface is far too heavy for a ~250px task column). `session` is
// `undefined` only once the linked id is fully reaped off the backend's own
// session list (GET /api/sessions returns killed rows too — see
// unifiedBoard.ts's adhocSessionsByColumn's own `status === "killed"` filter,
// which would be dead code otherwise — so a killed-but-not-yet-reaped session
// still resolves here and renders the live path below with an "exited"
// presentation, tinted via .status-exited, not this "ended" chip). Since
// Task.sessionId/reviewSessionId are never cleared server-side, the chip is
// still the common eventual state for any completed task — just not the
// immediate one.
export function TaskSessionSlot({
  session,
  role,
  theme,
  onOpenSession,
}: {
  session: Session | undefined;
  role: "worker" | "review";
  theme: Theme;
  onOpenSession: (session: Session) => void;
}) {
  if (!session) {
    return (
      <span className="task-card-session-strip is-gone">
        <TerminalPromptIcon size={11} />
        {role} · ended
      </span>
    );
  }

  const presentation = STATUS_PRESENTATION[session.sessionStatus];
  const logo = resolveAgentLogo(session.command, theme);
  const label = formatStatusLabel(presentation, session.sessionStatusDetail);
  const tint = rowClassNameForSeverity(session.sessionStatusSeverity);

  const open = () => onOpenSession(session);

  // Deliberately NOT draggable, and deliberately not its own tab stop.
  //
  // Hermes review caught a real bug in an earlier version of this component:
  // it WAS draggable with this same MIME, on the (wrong) assumption that
  // dropping it anywhere had no reachable target while the board is open.
  // The ad-hoc lane's own LaneCard.tsx, elsewhere in this same board, accepts
  // exactly this MIME for its own reorder — dragging this strip onto a lane
  // card highlighted it as a valid target, silently no-op'd the reorder
  // (task-linked ids are excluded from every lane column), and a completed
  // drag on some browsers still fires a plain click on the source element,
  // which then opened the session and kicked the user out of the board —
  // a misleading affordance actively doing the wrong thing, not a harmlessly
  // dead one. Simplest correct fix: don't make it draggable at all.
  //
  // Not a tabIndex={0}/role="button" element either — this strip already
  // sits inside the task card's own role="button"/tabIndex={0}, and nesting
  // two independently-focusable interactive elements with unrelated actions
  // is bad for keyboard/screen-reader users. Click (mouse only) still opens
  // the session directly; keyboard users reach the same session via the
  // card's own Enter/Space (which opens the drawer) and its Claim/Retry/
  // "Open session" actions.
  return (
    <span
      className={`task-card-session-strip${tint ? ` ${tint}` : ""}`}
      title={`${role}: ${label}`}
      aria-label={`${role} session: ${label}`}
      onClick={(e) => {
        e.stopPropagation();
        open();
      }}
    >
      <span className="session-dot-wrap">
        <span className={`session-dot-${presentation.tone}`} />
      </span>
      {logo ? (
        <img src={logo} alt="" className="task-card-session-strip-logo" />
      ) : (
        <BotIcon size={10} />
      )}
      {/* Hermes review — role lived only in title/aria-label, which a
          non-focusable span with no role doesn't reliably expose to screen
          readers. Putting it in the visible text too matches the "ended"
          chip above, which already reads "worker · ended". */}
      <span className="task-card-session-strip-label">
        {role} · {label}
      </span>
    </span>
  );
}
