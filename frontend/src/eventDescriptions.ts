import type { NotificationEvent } from "./api.js";

// Shared kind/payload interpretation for Phase 1's notification event model
// (issue #166) — the one place that turns a raw `NotificationEvent` into
// human text, an unread-worthiness classification, or both. Originally lived
// split across Sidebar.tsx (describeEvent/describeLatestEvent, issue #167)
// and PaneTab.tsx (notifyKind, issue #168); pulled out here for #169 so the
// notification panel can reuse the exact same rules instead of a third,
// possibly-drifting copy. Mirrors pty-manager.ts's emitEvent() call sites
// 1:1 (payload shapes there are the source of truth) — update this
// alongside any new kind/payload field.

// Single-event description: human text plus whether it should get the
// "attention" color treatment. Returns null when this specific event's
// kind/shape isn't one this has been taught about yet (a future payload
// change, or a kind this hasn't been taught).
export function describeEvent(
  event: NotificationEvent,
): { text: string; attention: boolean } | null {
  switch (event.kind) {
    case "attention": {
      if (event.payload.attention !== true) {
        // The state machine's own "clear" emit (attention-detect.ts) — no
        // longer needs attention, but still worth surfacing as the latest
        // event rather than reverting to "nothing to show".
        return { text: "No longer needs attention", attention: false };
      }
      switch (event.payload.signal) {
        case "bell":
          return { text: "Bell", attention: true };
        case "titleIdle":
          return { text: "Finished — needs input", attention: true };
        case "altScreenExit":
          return { text: "Exited full-screen — needs input", attention: true };
        case "silence":
          return { text: "Gone quiet — needs input", attention: true };
        case "notification":
          return { text: "Sent a notification", attention: true };
        default:
          // A future signal kind this hasn't been taught yet.
          return { text: "Needs input", attention: true };
      }
    }
    case "status_change": {
      if (event.payload.reason === "exited") return { text: "Exited", attention: false };
      if (event.payload.screen === "alt") {
        return { text: "Entered full-screen mode", attention: false };
      }
      if (event.payload.screen === "primary") {
        return { text: "Exited full-screen mode", attention: false };
      }
      return null;
    }
    case "title_change":
      return typeof event.payload.title === "string"
        ? { text: event.payload.title, attention: false }
        : null;
    default:
      return null;
  }
}

// Issue #167's per-session status line — turns the most recent describable
// NotificationEvent for a session into a short, human-readable string plus
// whether it should get the "attention" color treatment. Walks backward
// from the newest event rather than only looking at the very last one: a
// top event whose kind/shape describeEvent doesn't recognize (a future
// payload change, or a kind this hasn't been taught about) shouldn't blank
// the line when an earlier, still-relevant event (e.g. the last title
// change) can still describe it — last-known-good is more useful than
// nothing. Returns null only when NO buffered event describes (including
// the empty/undefined case), so SessionRow can render no line at all.
export function describeLatestEvent(
  events: NotificationEvent[] | undefined,
): { text: string; attention: boolean } | null {
  if (!events) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const described = describeEvent(events[i]);
    if (described) return described;
  }
  return null;
}

// Which of a session's buffered NotificationEvents count as an actual
// "notification" rather than routine chatter, and which icon that gets.
// Deliberately narrower than "every event with a describeEvent result": the
// events stream also carries title_change (fires on every OSC title
// update) and alt-screen status_change (fires on every TUI open/close) —
// both routine, high-frequency, and not what a user means by "notification".
// Only two kinds count: an attention signal actually ringing (not its own
// "cleared" counterpart), and a program exiting. Used by PaneTab.tsx's
// unread tab badge (issue #168) and NotificationBell.tsx's event feed +
// unread bell count (issue #169) — both must agree on this set, or the
// panel and the tab badges it's meant to summarize could disagree.
export function notifyKind(event: NotificationEvent): "attention" | "exited" | null {
  if (event.kind === "attention" && event.payload.attention === true) return "attention";
  if (event.kind === "status_change" && event.payload.reason === "exited") return "exited";
  return null;
}
