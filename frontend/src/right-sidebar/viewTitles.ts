// The name each right-sidebar view shows in its header strip. The rail uses the
// shorter registry `label` ("Git"); the strip has room for the full name. Views
// take their strip name from here so it is not retyped per call site, and
// views.test.ts ties these ids to the registry's.
export const VIEW_TITLES = {
  git: "Source Control",
  history: "History",
  github: "GitHub",
  files: "Files",
  project: "Project",
} as const;
