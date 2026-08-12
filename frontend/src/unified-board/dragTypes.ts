// Shared drag MIME type for the Kanban task board — used by UnifiedBoard.tsx
// (drop targets), TaskColumn.tsx (column-level drop acceptance), and
// TaskCard.tsx (the draggable card itself). Split into its own module
// (rather than defined in, and re-exported from, one of those) so none of
// the three has to import it from a sibling that isn't otherwise related to
// it — this constant has no other home.
export const TASK_DRAG_MIME = "application/x-mullion-task";
