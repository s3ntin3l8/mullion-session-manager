# Rate-Limit Grace Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a configurable grace window so Task Master tasks don't fail immediately when an agent hits a subscription quota limit — instead waiting for recovery before failing.

**Architecture:** A new `rateLimitGraceMinutes` config (Settings + env default) controls how long the task-reconciler waits after a `rate_limit` stop_failure before failing. The grace check runs in the existing reconcile loop, before `checkReviewingGate` (worker) and in `processReviewingTasks` (review agent). No new task states — the grace is a reconciler-level behavior that skips the task on each tick until recovery or expiry.

**Tech Stack:** TypeScript, Drizzle ORM (SQLite), existing Task Master infrastructure.

---

### Task 1: Config — add `rateLimitGraceMinutes`

**Files:**

- Modify: `src/services/task-config.ts`
- Modify: `src/plugins/env.ts`
- Modify: `src/services/settings.ts`
- Modify: `docs/configuration.md`

- [ ] **Step 1: Add env default to `src/plugins/env.ts`**

In the `taskMaster` settings block (around line 387-466), add a `rateLimitGraceMinutes` field following the pattern of existing settings (e.g. `budgetMinutes`). The exact field name and `MULLION_TASK_RATE_LIMIT_GRACE_MINUTES` env var come from the spec — default 5, min 0, max 1440.

- [ ] **Step 2: Expose in `src/services/task-config.ts`**

In `resolveTaskMasterConfig`, add a `rateLimitGraceMinutes` field that resolves through the same default-with-override pattern as `budgetMinutes`.

- [ ] **Step 3: Add to Settings schema in `src/services/settings.ts`**

Add `rateLimitGraceMinutes: z.number().int().min(0).max(1440).optional()` to the `taskMaster` settings schema.

- [ ] **Step 4: Update `docs/configuration.md`**

Add a row to the env var table for `MULLION_TASK_RATE_LIMIT_GRACE_MINUTES`.

- [ ] **Step 5: Run typecheck and lint**

```bash
make typecheck && make lint
```

- [ ] **Step 6: Commit**

```bash
git add src/services/task-config.ts src/plugins/env.ts src/services/settings.ts docs/configuration.md
git commit -m "feat(tasks): add rateLimitGraceMinutes config for rate-limit grace window"
```

---

### Task 2: Grace check utility

**Files:**

- Create: `src/services/task-rate-limit-grace.ts`
- Test: `test/services/task-rate-limit-grace.test.ts`

- [ ] **Step 1: Write the failing test**

The test should cover the 7 cases documented in the spec:

1. Grace active: `errorState === "api_error"` + `errorType === "rate_limit"` + within window
2. Grace expired: past window
3. Grace not active: `errorType !== "rate_limit"` (e.g. `"overloaded"`)
4. Grace not active: `errorState !== "api_error"`
5. Grace not active: `hasCommitsPastBase === true` (task made progress, don't delay)
6. Grace not active: `graceMinutes === 0` (opt-out)
7. Grace active: `errorType === null` (broadest safe behavior)

- [ ] **Step 2: Run test to verify it fails**

```bash
make test-backend
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation in `src/services/task-rate-limit-grace.ts`**

```typescript
/**
 * Decides whether a task should wait (grace window) rather than fail
 * immediately after a rate_limit stop_failure. The reconciler calls this
 * before checkReviewingGate (worker) and in processReviewingTasks (review).
 *
 * Returns true when ALL of:
 * - errorState is "api_error" (a stop_failure or tool_failure fired)
 * - errorType is "rate_limit" or absent/null (broadest safe behavior)
 * - within the configured grace window (now - errorAt < graceMinutes * 60_000)
 * - no commits past baseSha (the task hasn't made progress to protect)
 *
 * Returns false otherwise — the caller should proceed with the normal
 * path (checkReviewingGate, fail, etc.).
 */
export function isRateLimitGraceActive(
  info: {
    errorState: string | null;
    errorAt: number | null;
    errorType: string | null | undefined;
  },
  opts: {
    graceMinutes: number;
    hasCommitsPastBase: boolean;
  },
): boolean {
  if (info.errorState !== "api_error") return false;
  if (opts.graceMinutes <= 0) return false;
  if (opts.hasCommitsPastBase) return false;
  if (info.errorAt === null) return false;

  const errorType = info.errorType ?? null;
  if (errorType !== null && errorType !== "rate_limit") return false;

  const graceMs = opts.graceMinutes * 60_000;
  return Date.now() - info.errorAt < graceMs;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
make test-backend
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/task-rate-limit-grace.ts test/services/task-rate-limit-grace.test.ts
git commit -m "feat(tasks): add isRateLimitGraceActive utility for rate-limit grace window"
```

---

### Task 3: Worker path — grace check before `checkReviewingGate`

**Files:**

- Modify: `src/services/task-reconciler.ts` (lines ~3325-3345)
- Test: `test/services/task-reconciler.test.ts`

- [ ] **Step 1: Write the failing test**

Add tests in `task-reconciler.test.ts` that verify:

- An `in_progress` task with `errorState === "api_error"` + `errorType === "rate_limit"` + no commits stays `in_progress` during the grace window
- Same task after grace expiry transitions to `failed`
- Failure reason is enriched with `rate_limit:` prefix

- [ ] **Step 2: Run test to verify it fails**

```bash
make test-backend
```

Expected: FAIL — grace check not implemented yet.

- [ ] **Step 3: Implement the grace check in the reconcile loop**

In `task-reconciler.ts`, in the `if (task.status === "in_progress" && derived.status === "finished" && ...)` block (around line 3325), add before `checkReviewingGate`:

```typescript
if (
  task.status === "in_progress" &&
  derived.status === "finished" &&
  resolvedTaskMaster.enabled &&
  turnFinishedSinceClaim(info, task)
) {
  // NEW: rate-limit grace window — skip if the agent might recover
  const hasCommits = task.baseSha
    ? await backend.hasCommitsPastBase(task.worktreePath, task.baseSha).catch(() => false)
    : false;
  if (
    isRateLimitGraceActive(
      { errorState: info.errorState, errorAt: info.errorAt, errorType: info.errorType },
      { graceMinutes: resolvedTaskMaster.rateLimitGraceMinutes, hasCommitsPastBase: hasCommits },
    )
  ) {
    continue; // Grace active — skip this tick
  }

  // ... existing checkReviewingGate logic ...
}
```

If `backend.hasCommitsPastBase` doesn't exist yet, use a simpler check (read git status via the existing `resolveHostGitStatus`/`gitStatus` pattern that `checkReviewingGate` uses, or extract the commit-check into a shared helper).

- [ ] **Step 4: Enrich failure reason on grace expiry**

In `checkReviewingGate`, when the gate fails and `errorState === "api_error"` + `errorType === "rate_limit"`, prepend a `rate_limit: subscription quota exhausted — ` context to the failure reason.

- [ ] **Step 5: Run test to verify it passes**

```bash
make test-backend
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/task-reconciler.ts test/services/task-reconciler.test.ts
git commit -m "feat(tasks): add rate-limit grace window to worker reconcile path"
```

---

### Task 4: Review agent path — grace check in `processReviewingTasks`

**Files:**

- Modify: `src/services/task-reconciler.ts` (lines ~2896-2902)
- Test: `test/services/task-reconciler.test.ts`

- [ ] **Step 1: Write the failing test**

Add a test that verifies:

- A `reviewing` task with review session `errorState === "api_error"` + `errorType === "rate_limit"` + no findings stays in `reviewing` during the grace window
- Same task after grace expiry posts the existing inconclusive comment

- [ ] **Step 2: Run test to verify it fails**

```bash
make test-backend
```

Expected: FAIL.

- [ ] **Step 3: Implement the grace check in `processReviewingTasks`**

In `task-reconciler.ts`, in the `processPendingReviewSpawns` or `processReviewingTasks` loop where `isUsableSignal` is computed for a review session with no findings file, add a grace check that returns `continue` when `api_error + rate_limit + within window`.

- [ ] **Step 4: Run test to verify it passes**

```bash
make test-backend
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/task-reconciler.ts test/services/task-reconciler.test.ts
git commit -m "feat(tasks): add rate-limit grace window to review agent path"
```

---

### Task 5: Docs — `docs/tasks.md` safety envelope table

**Files:**

- Modify: `docs/tasks.md` (the safety envelope table around line 1011-1020)

- [ ] **Step 1: Add new row to the safety envelope table**

Add a new row for `Rate-limit grace window` with the setting, env default, and behavior description (referencing the grace window spec).

- [ ] **Step 2: Commit**

```bash
git add docs/tasks.md
git commit -m "docs(tasks): document rateLimitGraceMinutes in safety envelope"
```

---

### Task 6: Full gate — lint, typecheck, test, format-check

- [ ] **Step 1: Run the full gate**

```bash
make lint && make typecheck && make test && make format-check
```

Expected: All pass.

- [ ] **Step 2: Fix any issues**

- [ ] **Step 3: Final commit if needed**

```bash
git commit --amend --no-edit
```

---

### Spec coverage check

| Spec requirement                                    | Task   |
| --------------------------------------------------- | ------ |
| Config (`rateLimitGraceMinutes`)                    | Task 1 |
| `isRateLimitGraceActive` utility                    | Task 2 |
| Worker grace check before `checkReviewingGate`      | Task 3 |
| Failure reason enrichment                           | Task 3 |
| Review agent grace check in `processReviewingTasks` | Task 4 |
| Documentation                                       | Task 5 |
| Full gate verification                              | Task 6 |

No gaps. All spec requirements map to tasks.
