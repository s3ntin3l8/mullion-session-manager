// Shared fetch plumbing for every domain module under frontend/src/api/ —
// split out of the former flat frontend/src/api.ts (PR 22 of the refactoring
// roadmap). `request<T>` already centralizes credentials, content-type,
// ApiError, and 204->undefined; this is a MECHANICAL split, not a rewrite —
// every domain module below imports `request` from here rather than
// reimplementing any of this.

// Carries the HTTP status code alongside the backend's message so a caller
// can branch on the actual response (e.g. Settings -> Hosts' cascade-delete
// prompt checking `statusCode === 409`) instead of substring-matching
// error text, which silently breaks the moment the backend's wording changes.
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    // Machine-readable discriminator (e.g. "PROJECT_DIR_MISSING") — present
    // on the hand-built 4xx bodies that need one, undefined for plain
    // @fastify/sensible errors and successful-request paths. Lets a caller
    // branch on the actual failure instead of substring-matching `message`.
    public readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    // Same-origin only (never sent cross-origin) — required for the
    // optional in-process auth session cookie (issue #19,
    // src/plugins/auth.ts) to ride along; a no-op when MULLION_AUTH_TOKEN is
    // unset, since there's no cookie to send either way.
    credentials: "same-origin",
    // Only set this when there's actually a body — sending it on bodyless
    // requests (GET, DELETE) is invalid and some fetch layers reject it outright.
    headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.message || `${path} failed with ${res.status}`, res.status, body.code);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
