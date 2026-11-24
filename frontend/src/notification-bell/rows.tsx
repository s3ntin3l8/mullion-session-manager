// The bell's rows (NotificationBell.tsx): a session's header and decision
// rows, the grouped informative lines, task rows and the section switch.
import { useState } from "react";
import type { ReactNode } from "react";
import { notifyLabel } from "../eventDescriptions.js";
import { api } from "../api/index.js";
import type { Session } from "../api/index.js";
import {
  BlockedIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CloseIcon,
  WarningTriangleIcon,
} from "../ui/icons.js";
import { formatRelativeAge } from "../relativeTime.js";
import { truncateHead } from "../lib/truncatePath.js";
import { formatStatusLabel, STATUS_PRESENTATION } from "../sessionStatus.js";
import { TextInput } from "../ui/primitives.js";
import type { TaskNeedsYouKind } from "../github/taskMasterSummary.js";
import { NOTIF_ROW_TEXT_MAX, TASK_KIND_LABEL } from "./feed.js";
import type {
  FeedEventItem,
  FeedGroupedLineItem,
  FeedGroupedToggleItem,
  FeedHeaderItem,
} from "./feed.js";

// The row's icon and colour: a decision is "blocked" (waiting on you), a
// failure "error"; a review verdict reads as what it says (changes requested
// is red, an approval green).
function kindTreatment(item: FeedEventItem): { icon: ReactNode; className: string } {
  const severity =
    item.cls === "decision"
      ? "blocked"
      : item.cls === "failed" || item.event.payload.decision === "CHANGES_REQUESTED"
        ? "error"
        : "done";
  switch (severity) {
    case "blocked":
      return { icon: <BlockedIcon size={13} />, className: "notif-sev-blocked" };
    case "error":
      return { icon: <WarningTriangleIcon size={13} />, className: "notif-sev-error" };
    case "done":
      return { icon: <CheckIcon size={13} />, className: "notif-sev-done" };
  }
}

// The Sessions | Tasks switch (#3459), each segment with its needs-you count.
export function SectionSwitch({
  section,
  sessionsCount,
  tasksCount,
  onSelect,
}: {
  section: "sessions" | "tasks";
  sessionsCount: number;
  tasksCount: number;
  onSelect: (section: "sessions" | "tasks") => void;
}) {
  const segment = (value: "sessions" | "tasks", label: string, count: number) => (
    <button
      type="button"
      className={`notif-section-btn${section === value ? " active" : ""}`}
      aria-pressed={section === value}
      onClick={() => onSelect(value)}
    >
      {label}
      {count > 0 && <span className="notif-section-count">{count}</span>}
    </button>
  );
  return (
    <div className="notif-sections" role="group" aria-label="Section">
      {segment("sessions", "Sessions", sessionsCount)}
      {segment("tasks", "Tasks", tasksCount)}
    </div>
  );
}

// One task that needs you: its title, why (needsYouReason), its project. No
// read or dismiss state: it stays until the task's state clears.
export function TaskRow({
  title,
  project,
  reason,
  kind,
  onOpen,
}: {
  title: string;
  project: string;
  reason: string;
  kind: TaskNeedsYouKind;
  onOpen: () => void;
}) {
  const label = TASK_KIND_LABEL[kind];
  const treatment =
    kind === "failed"
      ? { icon: <WarningTriangleIcon size={13} />, className: "notif-sev-error" }
      : kind === "review"
        ? { icon: <CheckIcon size={13} />, className: "notif-sev-done" }
        : { icon: <BlockedIcon size={13} />, className: "notif-sev-blocked" };
  return (
    <div className="notif-event-row notif-task-row" onClick={onOpen}>
      {/* Same structure as EventRow (#3106): one open button for the keyboard. */}
      <button
        type="button"
        className="visually-hidden row-open-btn notif-event-open"
        aria-label={`${label}: ${title} — ${reason} — ${project}`}
      />
      <span className={`notif-event-icon ${treatment.className}`}>{treatment.icon}</span>
      <span className="notif-event-body">
        <span className="notif-event-kind-pill">{label}</span>
        <span className="notif-event-text" title={title}>
          {title}
        </span>
        <span className="notif-task-reason" title={reason}>
          {reason}
        </span>
        <span className="notif-event-time">{project}</span>
      </span>
    </div>
  );
}

// "Earlier, no decision needed" (#3460): the header of the informative lines,
// and the button that shows or hides them. Styled as a group header, so it
// pins the same way while its lines scroll.
export function GroupedToggle({
  item,
  expanded,
  onToggle,
}: {
  item: FeedGroupedToggleItem;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="notif-group-header notif-grouped-header">
      <button
        type="button"
        className="notif-grouped-toggle"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        {expanded ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
        <span className="notif-group-header-title">Earlier, no decision needed</span>
        <span className="notif-grouped-count">{item.count}</span>
      </button>
    </div>
  );
}

// One informative line per session: "finished", "exited", or both, with the
// newest one's age. Opens the session; Dismiss drops every grouped event the
// line stands for.
export function GroupedLine({
  item,
  session,
  onOpen,
  onDismiss,
}: {
  item: FeedGroupedLineItem;
  session: Session | undefined;
  onOpen: (session: Session) => void;
  onDismiss: () => void;
}) {
  const what = [item.summary.finished && "finished", item.summary.exited && "exited"]
    .filter(Boolean)
    .join(", ");
  const age = formatRelativeAge(item.summary.newestTs);
  const open = () => {
    if (session) onOpen(session);
  };
  return (
    <div className={`notif-event-row notif-grouped-line${item.read ? " read" : ""}`} onClick={open}>
      {/* Same structure as EventRow (#3106): the row is a plain container,
          the keyboard gets this one open button. */}
      <button
        type="button"
        className="visually-hidden row-open-btn notif-event-open"
        aria-label={`${item.title} ${what} — ${item.subtitle}, ${age}${item.read ? "" : ", new"}`}
      />
      <span className="notif-event-icon notif-sev-done">
        <CheckIcon size={13} />
      </span>
      <span className="notif-event-body">
        <span className="notif-event-text" title={`${item.title} ${what}`}>
          <span className="notif-grouped-title">{item.title}</span> {what}
        </span>
        <span className="notif-event-time">{age}</span>
      </span>
      <span className="notif-event-actions">
        <button
          className="notif-event-action-btn"
          title="Dismiss"
          aria-label="Dismiss"
          onClick={(e) => {
            e.stopPropagation();
            onDismiss();
          }}
        >
          <CloseIcon size={11} />
        </button>
      </span>
    </div>
  );
}

// Issue #1229 — live status alongside the group header's title/subtitle,
// answering "is this still stuck?" without leaving the panel. `session` is
// looked up at render time by the caller (same `sessions.find(...)` idiom
// EventRow already uses below), NOT snapshotted onto FeedHeaderItem — that
// keeps buildFeedItems' memoized output identity untouched and lets the
// status track the same 4s live-poll tick the rest of the panel already
// rides on `sessions` for.
export function FeedHeader({
  item,
  session,
}: {
  item: FeedHeaderItem;
  session: Session | undefined;
}) {
  const presentation = session ? STATUS_PRESENTATION[session.sessionStatus] : null;
  return (
    <div className="notif-group-header">
      <div className="notif-group-header-top">
        <span className="notif-group-header-title">{item.title}</span>
        {presentation && (
          <span className="notif-group-header-status">
            {/* Hermes review, PR #1284 — no `.session-dot-exited` class
                exists (styles/sidebar.css only defines attention/error/
                finished/idle/permission/plan/working), so an exited
                session's dot would otherwise render as an unstyled
                zero-width span. Mirrors Sidebar.tsx's own special-case:
                CloseIcon instead of a colored dot for "exited". */}
            {session?.sessionStatus === "exited" ? (
              <CloseIcon size={10} style={{ color: "var(--dim)" }} />
            ) : (
              <span className={`session-dot-${presentation.tone}`} />
            )}
            <span className={`session-status-label ${presentation.tone}`}>
              {/* Issue #1227 — "compact" explicit, not relying on
                  showDetail being false for every awaiting_* status: once
                  #1227 flips showDetail to true for four of them (with up to
                  a 200-char gatePrompt/promoteSummary), this 380x380px
                  popover has no room for the verbose form. */}
              {formatStatusLabel(presentation, session?.sessionStatusDetail ?? null, "compact")}
            </span>
          </span>
        )}
      </div>
      <span className="notif-group-header-subtitle">{item.subtitle}</span>
    </div>
  );
}

export function EventRow({
  item,
  session,
  onOpen,
  onOpenPr,
  onTimeline,
  onOpenBrowser,
  onDismiss,
}: {
  item: FeedEventItem;
  session: Session | undefined;
  onOpen: (session: Session) => void;
  // Desktop only (the phone has no right sidebar): a pr_* event's row opens
  // its PR in the sidebar instead of the session's terminal, which stays one
  // click away on the row's "Session" button.
  onOpenPr?: (session: Session, number: number) => void;
  // The row's tap opens the terminal, so the timeline (this panel's
  // per-session complement) is its own action.
  onTimeline?: (session: Session) => void;
  onOpenBrowser: (projectId: number) => void;
  onDismiss: () => void;
}) {
  const { icon, className } = kindTreatment(item);
  const age = formatRelativeAge(item.event.ts);
  // Issue #903 — buildFeedItems already decided this row's actual text
  // (describeEvent's own text, or a sessionContextMap substitute for a
  // generic row — see FeedEventItem.text's own comment); re-deriving via
  // describeEvent(item.event) here would only recompute the PRE-
  // substitution text and, for a folded row, disagree with whatever text
  // the fold decision above was actually keyed on.
  const fullText = item.text;
  // Making notifications relevant/scannable — head-truncated (see
  // truncatePath.ts's own comment for why: a permission summary's ONLY
  // distinguishing part is usually its tail, and CSS ellipsis cuts the
  // wrong end). The untruncated text stays in the row's aria-label/title so
  // nothing is actually lost, just not shown inline.
  const text = truncateHead(fullText, NOTIF_ROW_TEXT_MAX);
  const label = notifyLabel(item.event);
  const repeatCount = item.foldedSeqs.length;

  const prNumber =
    item.event.kind.startsWith("pr_") && typeof item.event.payload.number === "number"
      ? item.event.payload.number
      : null;
  const open = () => {
    if (!session) return;
    if (onOpenPr && prNumber !== null) onOpenPr(session, prNumber);
    else onOpen(session);
  };

  // Minimal review gate (issue #178) — gated on the SESSION's own live
  // `gates` list, not just this event's own payload.state === "waiting":
  // once resolved, the gate disappears from that list but the original
  // "waiting" event row stays in the feed unchanged (each NotificationEvent
  // is an immutable point-in-time record — resolution appends a NEW
  // review_gate event rather than mutating this one). Keying off live state
  // means Approve/Deny disappears from this row the instant the gate is
  // actually resolved (by this click or a timeout elsewhere), rather than
  // staying clickable against an already-answered gate.
  //
  // Issue: correlate concurrent permission gates — matched by `gateId`, NOT
  // just `session?.gateState === "waiting"`: a session can now have more
  // than one gate waiting at once, and gateState alone would make EVERY
  // waiting-gate event row show Approve/Deny as long as ANY gate on the
  // session is pending, including one that isn't THIS row's. An event
  // predating this change (or a `gateId` that somehow doesn't match a
  // still-live gate) never matches `.some()` over an empty/mismatched
  // `gates` array, so it fails safe to "not pending" rather than showing a
  // dead pair of buttons.
  const isWaitingGateEvent =
    item.event.kind === "review_gate" && item.event.payload.state === "waiting";
  const eventGateId =
    isWaitingGateEvent && typeof item.event.payload.gateId === "string"
      ? item.event.payload.gateId
      : null;
  // A row with no gateId at all is a legacy/malformed event (an older
  // forwarder build predating gate correlation) — falls back to the OLDEST
  // still-waiting gate, the same fallback semantics
  // `POST /api/sessions/:id/review-gate`'s own `gateId`-omitted contract
  // uses server-side (routes/sessions.ts's reviewGateSchema), rather than
  // simply never matching and leaving a genuinely-still-pending gate with
  // no way to answer it from this row.
  const matchingGate = isWaitingGateEvent
    ? eventGateId !== null
      ? session?.gates.find((g) => g.gateId === eventGateId)
      : session?.gates[0]
    : undefined;
  const isPendingGate = matchingGate !== undefined;

  // Issue #404 — same "key off the session's own live state, not this
  // immutable event's payload" reasoning as isPendingGate above: accepting
  // or dismissing appends a NEW dev_server_detected event rather than
  // mutating this one, so Use/Dismiss must disappear the instant the
  // session's own pendingDevServerPort moves past this exact port (by this
  // click, or a decision made from another tab).
  const eventPort = typeof item.event.payload.port === "string" ? item.event.payload.port : null;
  const isPendingDevServer =
    item.event.kind === "dev_server_detected" &&
    item.event.payload.state === undefined &&
    eventPort !== null &&
    session?.pendingDevServerPort === eventPort;

  return (
    <div
      // A decision row has no read state: it stays until its decision is
      // answered or dismissed (#3460).
      className="notif-event-row"
      // #3106 — a plain container, not a role="button": the row holds its own
      // buttons (Approve/Deny, Session, Timeline, Dismiss), and a
      // control inside a control is axe's nested-interactive. A pointer still
      // opens by clicking anywhere on it (each nested control stops its own
      // click); the keyboard gets the one real button below, first in tab
      // order, and the row's other controls are their own tab stops after it.
      onClick={open}
    >
      {/* No onClick of its own: Enter/Space fire a click that bubbles to the
          row's onClick, so it opens exactly once. The name carries the full
          text the row truncates; the button shows nothing itself, so there is
          no visible text for the name to mismatch. */}
      <button
        type="button"
        className="visually-hidden row-open-btn notif-event-open"
        aria-label={
          repeatCount > 1
            ? `${label}: ${fullText} — ${age}, repeated ${repeatCount} times`
            : `${label}: ${fullText} — ${age}`
        }
      />
      <span className={`notif-event-icon ${className}`}>{icon}</span>
      <span className="notif-event-body">
        {/* Suppressed when the pill would just repeat the row's own text
            verbatim (e.g. a plain bell: SIGNAL_LABELS.bell === "Bell" and
            describeEvent's own text for it is also "Bell") — showing the
            same word twice is noise, not information. */}
        {label !== fullText && <span className="notif-event-kind-pill">{label}</span>}
        <span className="notif-event-text" title={fullText}>
          {text}
        </span>
        {repeatCount > 1 && <span className="notif-event-repeat">×{repeatCount}</span>}
        <span className="notif-event-time">{age}</span>
        {isPendingGate && matchingGate && (
          <GateActions sessionId={item.sessionId} gateId={matchingGate.gateId} />
        )}
        {onOpenPr && prNumber !== null && session && (
          <button
            className="notif-timeline-btn"
            onClick={(e) => {
              e.stopPropagation();
              onOpen(session);
            }}
          >
            Session
          </button>
        )}
        {onTimeline && session && (
          <button
            className="notif-timeline-btn"
            onClick={(e) => {
              e.stopPropagation();
              onTimeline(session);
            }}
          >
            Timeline
          </button>
        )}
        {isPendingDevServer && eventPort && (
          <DevServerActions
            sessionId={item.sessionId}
            port={eventPort}
            onAccepted={() => {
              if (session) onOpenBrowser(session.projectId);
            }}
          />
        )}
      </span>
      <span className="notif-event-actions">
        <button
          className="notif-event-action-btn"
          title="Dismiss"
          aria-label="Dismiss"
          onClick={(e) => {
            e.stopPropagation();
            onDismiss();
          }}
        >
          <CloseIcon size={11} />
        </button>
      </span>
    </div>
  );
}

// Minimal review gate (issue #178) — Approve is a single click; Deny opens
// an inline optional-reason field rather than firing immediately, since a
// denial is the more consequential of the two and the reason is worth a
// beat to type. Both call POST /api/sessions/:id/review-gate directly; no
// optimistic local state is needed because the row's own visibility already
// reacts live once the store's next poll/event picks up the session's
// updated gateState (see EventRow's isPendingGate).
function GateActions({ sessionId, gateId }: { sessionId: number; gateId: string }) {
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const approve = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setSubmitting(true);
    try {
      await api.resolveReviewGate(sessionId, gateId, "approved");
    } catch (err) {
      // Best-effort: a failed request (network hiccup, or the gate already
      // resolved/timed out elsewhere — most commonly, since issue #844, a
      // stale "waiting" row surviving a backend restart, whose 409 this
      // console.debug is what makes visible at all, since the row itself
      // just silently stays put) just leaves the row as-is — the next store
      // refresh reflects whatever the real gateState actually is.
      console.debug("[NotificationBell] resolveReviewGate(approved) failed", err);
    } finally {
      setSubmitting(false);
    }
  };

  const deny = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setSubmitting(true);
    try {
      await api.resolveReviewGate(sessionId, gateId, "denied", reason.trim() || undefined);
    } catch (err) {
      // See approve()'s catch above.
      console.debug("[NotificationBell] resolveReviewGate(denied) failed", err);
    } finally {
      setSubmitting(false);
      setDenying(false);
    }
  };

  if (denying) {
    return (
      <span
        className="notif-gate-deny-form"
        onClick={(e) => e.stopPropagation()}
        // Keeps the reason field's keystrokes to itself. The row this renders
        // in used to open on Space/Enter anywhere inside it, which closed the
        // panel mid-keystroke; since #3106 only its own open button does, but
        // the panel above still reads keydowns (Escape closes it).
        onKeyDown={(e) => e.stopPropagation()}
      >
        <TextInput
          small
          className="notif-gate-deny-reason"
          placeholder="Reason (optional)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          autoFocus
        />
        <button
          className="notif-gate-btn notif-gate-deny-confirm"
          disabled={submitting}
          onClick={deny}
        >
          Deny
        </button>
        <button
          className="notif-gate-btn"
          disabled={submitting}
          onClick={(e) => {
            e.stopPropagation();
            setDenying(false);
          }}
        >
          Cancel
        </button>
      </span>
    );
  }

  return (
    <span
      className="notif-gate-actions"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <button className="notif-gate-btn notif-gate-approve" disabled={submitting} onClick={approve}>
        Approve
      </button>
      <button
        className="notif-gate-btn notif-gate-deny"
        disabled={submitting}
        onClick={(e) => {
          e.stopPropagation();
          setDenying(true);
        }}
      >
        Deny
      </button>
    </span>
  );
}

// Issue #404 — accept/dismiss for a plain session's detected dev-server
// offer, following GateActions' own pattern above: no optimistic local
// state, since the row's visibility already reacts live once the store's
// next poll/event picks up the session's updated pendingDevServerPort (see
// EventRow's isPendingDevServer). "Use this port" patches the project's
// devServerUrl and creates/reuses its preview server-side (POST
// /api/sessions/:id/dev-server/accept) — the ALREADY-RUNNING dev server in
// this session is what gets wired up, not a new one spawned — then opens
// the preview pane via onAccepted so the user lands on it immediately.
function DevServerActions({
  sessionId,
  port,
  onAccepted,
}: {
  sessionId: number;
  port: string;
  onAccepted: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);

  const accept = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setSubmitting(true);
    try {
      await api.acceptDevServerPort(sessionId, port);
      onAccepted();
    } catch {
      // Best-effort — see GateActions' approve/deny catch above for why.
    } finally {
      setSubmitting(false);
    }
  };

  const dismiss = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setSubmitting(true);
    try {
      await api.dismissDevServerPort(sessionId, port);
    } catch {
      // Best-effort.
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <span
      className="notif-gate-actions"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <button className="notif-gate-btn notif-gate-approve" disabled={submitting} onClick={accept}>
        Use this port
      </button>
      {/* Labeled "Ignore port", not "Dismiss" — the row's own generic
          "Dismiss" icon-button (remove this event from the feed entirely)
          sits right next to this one with the SAME accessible name
          ("Dismiss"), which would otherwise make the two indistinguishable
          both to a screen reader and to a test's getByRole lookup. */}
      <button className="notif-gate-btn notif-gate-deny" disabled={submitting} onClick={dismiss}>
        Ignore port
      </button>
    </span>
  );
}
