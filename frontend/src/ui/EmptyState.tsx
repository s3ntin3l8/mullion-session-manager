import type { ReactNode } from "react";

// PR 25 (frontend refactor plan) — two previously-separate class families
// consolidated under one `ui-empty-state*` prefix in styles.css:
//  - Sidebar's `.empty-state` (icon badge / title / body / actions card,
//    "Welcome to Mullion" / "No sessions match" / "No repositories found")
//    → the default export below, composed from the named sub-parts.
//  - `.github-panel-empty` (a plain muted text block — "Loading…", error
//    text, "No tasks yet.") borrowed as-is by six panels that aren't
//    GitHubPanel (GitPanel, UnifiedBoard, DockConfigPanel, AgentRulesPanel,
//    SkillsPanel, TaskDetail) → `EmptyStateNote` below.
// The two are visually distinct rule sets (flex/centered card vs. a plain
// padded block) and were kept as two selectors rather than composed, so
// neither can accidentally pick up the other's layout — see styles.css's
// own comment at `.ui-empty-state-note`.

function cx(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export interface EmptyStateProps {
  className?: string;
  children?: ReactNode;
}

/** The rich icon/title/body/actions card — was Sidebar's `.empty-state`.
 * Compose with `EmptyStateIcon`/`EmptyStateTitle`/`EmptyStateBody`/
 * `EmptyStateActions`, or pass arbitrary children for one-off content
 * (e.g. the host picker between body and actions in Sidebar's discover
 * panel). */
export function EmptyState({ className, children }: EmptyStateProps) {
  return <div className={cx("ui-empty-state", className)}>{children}</div>;
}

export function EmptyStateIcon({
  variant,
  className,
  children,
}: {
  variant?: "accent" | "neutral" | "warn";
  className?: string;
  children: ReactNode;
}) {
  return <span className={cx("ui-empty-state-icon", variant, className)}>{children}</span>;
}

export function EmptyStateTitle({ children }: { children: ReactNode }) {
  return <div className="ui-empty-state-title">{children}</div>;
}

export function EmptyStateBody({ children }: { children: ReactNode }) {
  return <div className="ui-empty-state-body">{children}</div>;
}

export function EmptyStateActions({ children }: { children: ReactNode }) {
  return <div className="ui-empty-state-actions">{children}</div>;
}

/** The plain muted text/JSX block — was `.github-panel-empty`. Used for
 * loading states, error text, and short empty-list messages across panels
 * that don't need the full card treatment. Deliberately not a variant of
 * `EmptyState` above (see the header comment) — a separate component keeps
 * the two non-composable at the type level, not just by convention. */
export function EmptyStateNote({ className, children }: EmptyStateProps) {
  return <div className={cx("ui-empty-state-note", className)}>{children}</div>;
}
