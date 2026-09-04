## Context

`updateEmail()` (`src/services/user-profile.ts`) accepts any string and
writes it straight to the `users.email` column:

    export function updateEmail(db: Database, userId: string, email: string) {
      db.update(users).set({ email }).where(eq(users.id, userId));
    }

There's no format check anywhere on this path — `POST /api/users/:id/email`
(`src/routes/users.ts:88`) calls `updateEmail` directly with the raw request
body. A malformed address is stored as-is and only surfaces later, when the
outbound mailer silently drops it.

## Scope

- [ ] `updateEmail()` rejects a malformed address instead of writing it, using the existing `isValidEmail()` helper in `src/services/validate.ts`.
- [ ] `POST /api/users/:id/email` returns 400 with a clear message when `updateEmail()` rejects.
- [ ] Test coverage: one rejected malformed address, one accepted valid address, both via `app.inject()` against the route.
- [ ] Update `docs/api.md`'s `/api/users/:id/email` entry to document the new 400 case.

## Out of scope

- Validating email format anywhere else it's set (signup, admin import) — file a follow-up if those need the same check.
- Sending a verification email — this issue is only about rejecting garbage input, not confirming ownership.

Agent: codex
ReviewAgent: claude
