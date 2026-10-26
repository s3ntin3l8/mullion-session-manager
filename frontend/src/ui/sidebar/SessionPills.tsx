import type { SessionLink } from "../../hooks/useMullionLinks.js";
import { STATUS_PRESENTATION } from "../../sessionStatus.js";
import { useDashboardStore } from "../../store/index.js";
import { severityTone } from "./linkDecisions.js";

export interface SessionPillsProps {
  links: readonly SessionLink[];
  /** Override for tests / hosts that own session opening. */
  onOpenSession?: (sessionId: number) => void;
}

/**
 * Status-coloured dot + name per session; a click opens it. Child sessions
 * nest under their parent. An attention flag (`!`) marks a session that is
 * waiting on a human — never colour alone.
 */
export function SessionPills({ links, onOpenSession }: SessionPillsProps) {
  const requestOpenSession = useDashboardStore((s) => s.requestOpenSession);
  const open = onOpenSession ?? requestOpenSession;
  if (links.length === 0) return null;
  return (
    <ul className="sb-pills" aria-label="Sessions">
      {links.map((l) => (
        <li key={l.session.id} className="sb-pill-item">
          <button
            type="button"
            className={`sb-pill sb-pill--${severityTone(l.severity)}`}
            onClick={() => open(l.session.id)}
            title={`${STATUS_PRESENTATION[l.session.sessionStatus].label} — open session`}
          >
            <span className="sb-pill-dot" aria-hidden="true" />
            <span className="sb-pill-name">{l.session.name ?? `Session ${l.session.id}`}</span>
            {l.attention && (
              <span className="sb-pill-attn" role="img" aria-label="needs attention">
                !
              </span>
            )}
          </button>
          {l.children.length > 0 && (
            <div className="sb-pill-children">
              <SessionPills links={l.children} onOpenSession={onOpenSession} />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
