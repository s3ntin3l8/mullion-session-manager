import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { TaskStatus } from "../api/index.js";
import { prefersReducedMotion } from "../lib/motion.js";
import { ChevronDownIcon, ChevronRightIcon } from "../ui/icons.js";
import { TaskStatusStrip } from "./TaskStatusStrip.js";
import { initialOpenSections } from "./stackLayout.js";
import type { StackSection } from "./stackLayout.js";

// The board while it is narrow (#3011, design section 2 frame 2b): one
// section per status, active ones first, Backlog and Done collapsed. Each
// header carries the count and a dot when a task in it needs the owner; the
// strip on top jumps to a section and opens it. The cards themselves are the
// lanes' own (UnifiedBoard renders each section's body through TaskColumn), so
// a card behaves the same in both layouts.
export function StackedBoard({
  sections,
  selectedTaskId,
  selectedStatus,
  hideDone,
  renderBody,
}: {
  sections: readonly StackSection[];
  /** The selected task: picking another one re-opens its section if folded. */
  selectedTaskId: number | null;
  /** The section of the selected task, kept open so its card stays on screen. */
  selectedStatus: TaskStatus | null;
  /** The board's "Hide done": Done and Failed show as headers only, as the lanes do. */
  hideDone: boolean;
  renderBody: (section: StackSection) => ReactNode;
}) {
  const [open, setOpen] = useState(() => initialOpenSections(selectedStatus));
  // Selecting a task in a folded section (from the sidebar, a notification)
  // opens that section: adjusted while rendering, React's pattern for state
  // that follows a prop, so the card is there in the same commit.
  // Keyed on the task as well as its status, so picking another task in a
  // section the user folded opens it again.
  const selectedKey = `${selectedTaskId ?? ""}:${selectedStatus ?? ""}`;
  const [seenSelected, setSeenSelected] = useState(selectedKey);
  if (seenSelected !== selectedKey) {
    setSeenSelected(selectedKey);
    if (selectedStatus !== null && !open.has(selectedStatus)) {
      setOpen(new Set([...open, selectedStatus]));
    }
  }

  const sectionEls = useRef(new Map<TaskStatus, HTMLElement>());
  const [jump, setJump] = useState<{ id: TaskStatus; nonce: number } | null>(null);
  useEffect(() => {
    if (!jump) return;
    // Optional call: jsdom has no scrollIntoView.
    sectionEls.current.get(jump.id)?.scrollIntoView?.({
      block: "start",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  }, [jump]);

  const folds = (id: TaskStatus) => hideDone && (id === "done" || id === "failed");
  const toggle = (id: TaskStatus) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const onJump = (id: TaskStatus) => {
    if (!folds(id)) setOpen((prev) => (prev.has(id) ? prev : new Set([...prev, id])));
    setJump((prev) => ({ id, nonce: (prev?.nonce ?? 0) + 1 }));
  };

  return (
    <div className="stacked-board">
      <TaskStatusStrip
        statuses={sections.map((s) => ({
          id: s.id,
          title: s.title,
          count: s.tasks.length,
          needsYou: s.needsYou,
        }))}
        onJump={onJump}
      />
      {sections.map((section) => {
        const expanded = open.has(section.id) && !folds(section.id);
        const bodyId = `stacked-section-${section.id}`;
        return (
          <section
            key={section.id}
            className="stacked-section"
            data-status={section.id}
            aria-label={section.title}
            ref={(el) => {
              if (el) sectionEls.current.set(section.id, el);
              else sectionEls.current.delete(section.id);
            }}
          >
            <button
              type="button"
              className="stacked-section-header"
              aria-expanded={expanded}
              aria-controls={expanded ? bodyId : undefined}
              disabled={folds(section.id)}
              onClick={() => toggle(section.id)}
            >
              {expanded ? (
                <ChevronDownIcon size={12} aria-hidden="true" />
              ) : (
                <ChevronRightIcon size={12} aria-hidden="true" />
              )}
              <span className="stacked-section-title">{section.title}</span>
              <span className="kanban-column-count">{section.tasks.length}</span>
              {section.needsYou && (
                <span
                  className="stacked-section-dot"
                  role="img"
                  aria-label="A task here needs you"
                />
              )}
            </button>
            {expanded && (
              <div className="stacked-section-body" id={bodyId}>
                {renderBody(section)}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
