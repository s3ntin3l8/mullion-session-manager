// #2491 — the user's task-level model choices (the top tier of the backend's
// resolution chain; null = follow the issue directive / defaults), kept apart
// from `model` / `smallModel`, the values RESOLVED at claim time. Merged into
// `Task` from here because api/types.ts is at its file-size ceiling.
declare module "./types.js" {
  interface Task {
    modelOverride?: string | null;
    smallModelOverride?: string | null;
    reviewerModel?: string | null;
  }
}
export {};
