// Types for review-protocol.mjs, which stays plain ESM (src/cli is copied
// into dist/ verbatim, see package.json's "build"). Declared here so the
// TypeScript side — services/workflow-conventions.ts — can import the one
// canonical wording instead of restating it.
export const REVIEW_REQUEST_TIMEOUT_MS: number;
export const REVIEW_PROTOCOL_NOTE: string;
export const REVIEW_REPO_NOTE: string;
