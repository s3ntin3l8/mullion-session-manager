/**
 * Turn an unknown thrown value into a message worth showing a user.
 *
 * The app had no single answer to this: some call sites did
 * `err instanceof Error ? err.message : String(err)`, some logged the raw
 * error and showed nothing, and one showed a `title` tooltip nobody
 * sees. This is the one place the question is answered, so a failure
 * reads the same wherever it surfaces.
 *
 * `fallback` is what to say when the error carries no usable text of its
 * own — an empty string, a non-Error throw, or a bare `undefined`.
 */
export function describeError(err: unknown, fallback = "Something went wrong."): string {
  if (err instanceof Error && err.message.trim()) return err.message;
  if (typeof err === "string" && err.trim()) return err;
  return fallback;
}
