import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { getHermesKey } from "./hermes-integration.js";
import { getPinnedDispatcher, assertAllowedUrl } from "./pinned-connect.js";
import { getStoredSettings } from "./settings.js";
import type { UrlGuardPolicy } from "./url-guard.js";

// Hermes sits on the operator's LAN, so private and loopback targets are
// legitimate here (same policy as a registered agent host). Link-local /
// cloud-metadata ranges stay blocked by url-guard regardless.
export const HERMES_URL_POLICY: UrlGuardPolicy = { allowLoopback: true, allowPrivate: true };

const HEALTH_TIMEOUT_MS = 5_000;
const PROMPT_TIMEOUT_MS = 5_000;
// POST /v1/runs answers 202 with a run id as soon as the run is admitted, so
// (unlike the old chat/completions call, which was held open until the agent
// finished) a timeout here is a real failure, not "accepted and running".
const DISPATCH_TIMEOUT_MS = 15_000;
const STATUS_TIMEOUT_MS = 10_000;
const MAX_RUN_OUTPUT_CHARS = 4_000;
const MAX_TRACKED_RUNS = 200;
const MAX_LISTED_RUNS = 20;
const PROMPT_CACHE_TTL_MS = 10 * 60_000;
const MAX_AGENT_TURNS = 30;

export class HermesNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HermesNotConfiguredError";
  }
}

export class HermesUnavailableError extends Error {
  // `message` is safe to return to a session (it travels back through the
  // control socket); `detail` may carry the configured URL / resolved
  // addresses / raw network errors, so it is only ever logged server-side —
  // except for the operator-only "Test connection" route.
  constructor(
    message: string,
    readonly detail?: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "HermesUnavailableError";
  }
}

export class HermesAuthError extends Error {
  constructor(status: number) {
    super(
      `Hermes API rejected the key (HTTP ${status}) — check the key in Settings → Integrations`,
    );
    this.name = "HermesAuthError";
  }
}

export class ReviewCooldownError extends Error {
  constructor(
    readonly retryAfterSeconds: number,
    /** The commit whose review is being throttled (issue #1703). */
    readonly headSha?: string,
    /** The target's kind — a triage request is throttled separately (issue #1629). */
    readonly kind: RelayTargetKind = "pull_request",
  ) {
    super(
      headSha
        ? `A review of this commit (${headSha.slice(0, 7)}) was requested recently — wait ${retryAfterSeconds}s before requesting another, or request a review of the new head commit right away`
        : kind === "issue"
          ? `A triage of this issue was requested recently — wait ${retryAfterSeconds}s before requesting another`
          : `A review of this PR was requested recently — wait ${retryAfterSeconds}s before requesting another`,
    );
    this.name = "ReviewCooldownError";
  }
}

/** Hermes already holds a run for this commit's idempotency key (409). */
export class ReviewConflictError extends Error {
  constructor() {
    super(
      "A review of this commit was already requested (possibly by the repository's own workflow) — wait for it instead of requesting again",
    );
    this.name = "ReviewConflictError";
  }
}

/** The run id is unknown to this Mullion (never dispatched here, or the server restarted). */
export class ReviewRunNotFoundError extends Error {
  constructor() {
    super("No such review run — it was not dispatched by this Mullion, or the server restarted");
    this.name = "ReviewRunNotFoundError";
  }
}

/** A session tried to stop a run another session dispatched. */
export class ReviewRunForbiddenError extends Error {
  constructor() {
    super("That review run was dispatched by a different session");
    this.name = "ReviewRunForbiddenError";
  }
}

/**
 * What a relay run acts on (issue #1629). The relay started as "review this
 * PR"; an issue triage is the same shape of job — one GitHub number in one
 * repository — so it is a *kind* of target rather than a second service.
 */
export type RelayTargetKind = "pull_request" | "issue";

export interface RelayTarget {
  kind: RelayTargetKind;
  owner: string;
  repo: string;
  /** The PR or issue number (GitHub shares one numbering namespace). */
  number: number;
  /** The PR's head commit — a pull_request target only. */
  headSha?: string;
  /** Dispatching Mullion session, when the request came from an agent. */
  sessionId?: number;
}

// Deliberately generic: nothing here names a particular host's scripts or
// profile layout, so it works for any Hermes review-bot setup. What matters
// is WHO posts the review — a GitHub App bot identity that can give an
// official verdict — so that is stated as a requirement.
/**
 * The dispatch message for a relay run (issue #1629). The target line names
 * the kind, so a triage run is never mistaken for a review of a pull request
 * that happens to share the number.
 */
export function buildRelayMessage(
  kind: RelayTargetKind,
  owner: string,
  repo: string,
  number: number,
  prompt: string,
): string {
  const target = kind === "issue" ? `issue #${number}` : `pr #${number}`;
  // A triage posts a comment, not a review — telling it to "post the review"
  // would ask for a verdict it has none to give.
  const post = kind === "issue" ? "comment" : "review";
  const header =
    `Target: ${target} in repo ${owner}/${repo}\n` +
    `Post the ${post} as your GitHub App bot identity (an installation token from your profile's ` +
    "App credentials) — never with a personal user token. If you have no App credentials, do not " +
    "post; reply with the reason instead. Do NOT ask the human for secrets.\n" +
    `\nHonor a maximum of ${MAX_AGENT_TURNS} agent turns.\n\n`;
  return header + prompt;
}

// Used when no prompt repo is configured. Same verdict rules as the shared
// hermes-review-prompt.md.
export const BUILTIN_REVIEW_PROMPT = `Review the pull request named above using your github-code-review skill.

Procedure:
1. Read the PR's title, description, head SHA and base branch (gh pr view).
2. Clone the repository, fetch the base and head, and read each changed file in full context plus its diff.
3. Review for correctness, security, code quality, tests and docs.

Constraints:
- Read-only: never git push, commit, modify files, merge or close the PR.
- Submitting a formal review with event APPROVE or REQUEST_CHANGES is expected.
- Post exactly one review (inline comments plus a summary); no duplicate top-level comment.
- Pin the review to the head SHA you reviewed (commit_id).
- Review body shape: "## Review", then "**Verdict:** ...", then the sections "### Critical", "### Warnings", "### Suggestions", "### Looks Good" (omit empty ones).
- Reply with a single line: "<N> issues, verdict=<...>".
- Cite only real file:line locations you can see in the diff. Never invent APIs or paths.

Verdict:
- APPROVE: clean, or only non-blocking nits.
- REQUEST_CHANGES: any critical or warning issue that must be fixed before merge.
- COMMENT: only for draft or already merged/closed PRs.
`;

/**
 * Used when no triage prompt repo is configured (issue #1629). The triage
 * run posts a comment on the issue — the same "post as the App bot" rule as
 * a review, but there is no verdict to submit: a triage is advice.
 *
 * Self-contained on purpose: it names no skill, because there is no
 * issue-triage skill to name (the review-bot profile has none, and a prompt
 * that opens by hunting a skill that does not exist sends every install
 * down a dead end). The procedure below is the whole instruction.
 */
/**
 * The heading the built-in triage prompt asks the bot to start its comment
 * with. It is what tells *our* comment apart from another bot's
 * (dependabot, a stale-bot) in the window after the dispatch — the triage
 * path has no commit to pin the comment to, the way the review path pins a
 * review to its head commit.
 *
 * Stated here, next to the prompt that asks for it: the route matches on
 * this constant, so the two cannot drift apart.
 */
export const TRIAGE_COMMENT_MARKER = "## Triage";

export const BUILTIN_TRIAGE_PROMPT = `Triage the issue named above.

Procedure:
1. Read the issue's title, description, labels and any linked PRs (gh issue view).
2. Look at the repository to judge what the issue is really about — the files it names, the code around them.
3. Decide what the reporter most likely needs: a fix, a decision, a reproduction, or more information.

Constraints:
- Read-only: never git push, commit, modify files, close the issue, or label it.
- Post exactly one comment on the issue — the triage itself, not a reply to another comment.
- Comment body shape: "${TRIAGE_COMMENT_MARKER}", then "**Summary:** ...", then "### Findings", "### Suggested next step" and "### Questions for the reporter" (omit empty ones).
- Be concrete: name the real files and functions involved, and say what you could not verify.
- If the issue is unclear or wrong, say so plainly instead of guessing.
- Reply with a single line: "<N> findings, action=<...>".
`;

// In-memory only: a server restart clears it, which is acceptable — the
// cooldown exists to stop an agent looping on re-reviews, not to be a durable
// rate limit.
const lastRequested = new Map<string, number>();

// The cooldown's key space is every commit ever reviewed (issue #1703), so a
// long-lived process would grow this map without bound. Entries older than
// the cooldown window can no longer throttle anything, so they are swept —
// but only once the map is big enough for the sweep to be worth its O(n) pass,
// and at most once per window so a busy process does not pay the pass on
// every request.
const MAX_COOLDOWN_ENTRIES = 1_000;
let lastCooldownSweep = 0;

function sweepCooldown(now: number, windowMs: number): void {
  if (lastRequested.size <= MAX_COOLDOWN_ENTRIES) return;
  if (now - lastCooldownSweep < windowMs) return;
  lastCooldownSweep = now;
  for (const [key, at] of lastRequested) {
    if (now - at >= windowMs) lastRequested.delete(key);
  }
}

/** Test hook — how many cooldown entries are currently held. */
export function cooldownEntryCount(): number {
  return lastRequested.size;
}

export interface ReviewRunRecord {
  runId: string;
  /** What the run acts on (issue #1629). */
  kind: RelayTargetKind;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  /** Dispatching Mullion session, when the request came from an agent. */
  sessionId?: number;
  dispatchedAt: number;
}

// Run index, also in-memory: Hermes keeps run status for 24h (durable, keyed by
// the Idempotency-Key), so a restart only loses this convenience lookup.
// Insertion-ordered, so the oldest entries are evicted first.
const runsById = new Map<string, ReviewRunRecord>();
const latestRunByPr = new Map<string, string>();

function prKey(owner: string, repo: string, prNumber: number): string {
  return `${owner}/${repo}#${prNumber}`.toLowerCase();
}

/**
 * The run index's key (issue #1629): the kind is part of it, so a triage of
 * issue #5 never displaces the review of PR #5 — they share a numbering
 * namespace on GitHub but are different jobs.
 */
function targetKey(kind: RelayTargetKind, owner: string, repo: string, number: number): string {
  return `${kind}:${prKey(owner, repo, number)}`;
}

/**
 * The cooldown's key (issue #1703): the thing being throttled is a *commit*,
 * not a PR. The idempotency key the run is dispatched under is already
 * SHA-scoped (`mullion-review:owner/repo#pr@headSha:bucket`), so keying the
 * cooldown by the PR alone made the two disagree — a re-review of a NEW head
 * commit was refused for up to `cooldownMinutes`, even though it is a
 * different review of a different commit. Keying both by the commit keeps
 * "the same commit is throttled" and "a new commit is reviewed right away"
 * in sync. An issue has no commit, so its key is the target's own.
 */
function cooldownKeyFor(target: RelayTarget): string {
  const base = targetKey(target.kind, target.owner, target.repo, target.number);
  if (target.kind === "issue") return base;
  // A pull request's key MUST include its commit: an empty sha would make
  // every commit of the PR collapse into one key, silently restoring the
  // PR-wide cooldown this change removes. Fail loudly instead.
  if (!target.headSha) {
    throw new HermesNotConfiguredError("A review target needs its head commit");
  }
  return `${base}@${target.headSha.toLowerCase()}`;
}

function trackRun(incoming: ReviewRunRecord): void {
  // Hermes returns the same run id when it replays an identical request, so
  // the id can already be tracked: keep its original owner (or a second
  // session's replay would take over, and could stop, the first one's run) and
  // its original dispatch time (or the landed-review check would ignore a
  // review that posted before the replay).
  const existing = runsById.get(incoming.runId);
  const record = existing
    ? { ...incoming, sessionId: existing.sessionId, dispatchedAt: existing.dispatchedAt }
    : incoming;
  runsById.delete(record.runId);
  runsById.set(record.runId, record);
  latestRunByPr.set(
    targetKey(record.kind, record.owner, record.repo, record.prNumber),
    record.runId,
  );
  while (runsById.size > MAX_TRACKED_RUNS) {
    const oldest = runsById.keys().next().value as string;
    const gone = runsById.get(oldest);
    runsById.delete(oldest);
    if (gone) {
      const k = targetKey(gone.kind, gone.owner, gone.repo, gone.prNumber);
      if (latestRunByPr.get(k) === oldest) latestRunByPr.delete(k);
    }
  }
}
const MAX_PROMPT_BYTES = 200_000;
const PROMPT_SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;

// promptRepo/promptPath are interpolated into a raw.githubusercontent.com URL,
// so keep them to plain owner/repo and path-segment characters: no `..`,
// query, fragment or scheme tricks that could steer the fetch elsewhere.
export function isValidPromptLocation(promptRepo: string, promptPath: string): boolean {
  const repoParts = promptRepo.split("/");
  if (repoParts.length !== 2 || !repoParts.every((p) => PROMPT_SEGMENT_RE.test(p) && p !== "..")) {
    return false;
  }
  return promptPath.split("/").every((seg) => PROMPT_SEGMENT_RE.test(seg) && seg !== "..");
}

const promptCache = new Map<string, { text: string; fetchedAt: number }>();

/** Test hook — clears the cooldown, prompt and run-index caches. */
export function resetHermesReviewState(): void {
  lastRequested.clear();
  lastCooldownSweep = 0;
  promptCache.clear();
  runsById.clear();
  latestRunByPr.clear();
}

// Reads at most `maxBytes` of a response body, so the cap bounds the memory
// spent reading it (not just what's forwarded). Returns null when exceeded.
async function readBounded(res: Response, maxBytes: number): Promise<string | null> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      void reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function loadReviewPrompt(promptRepo: string, promptPath: string): Promise<string> {
  const key = `${promptRepo}:${promptPath}`;
  const cached = promptCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < PROMPT_CACHE_TTL_MS) return cached.text;
  // Unauthenticated on purpose: the prompt repo is public and the GitHub
  // workflow checks it out without a token. A GitHub App installation token
  // would 404 here whenever the App isn't installed on that repo.
  const url = `https://raw.githubusercontent.com/${promptRepo}/HEAD/${promptPath}`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(PROMPT_TIMEOUT_MS), redirect: "error" });
  } catch (err) {
    throw new HermesUnavailableError(
      "Could not fetch the review prompt",
      `${url}: ${(err as Error).message}`,
    );
  }
  if (!res.ok) {
    throw new HermesUnavailableError(`Could not fetch the review prompt (HTTP ${res.status})`, url);
  }
  const text = await readBounded(res, MAX_PROMPT_BYTES);
  if (text === null) throw new HermesUnavailableError("The review prompt is too large", url);
  promptCache.set(key, { text, fetchedAt: Date.now() });
  return text;
}

function baseUrl(apiUrl: string): string {
  try {
    assertAllowedUrl(apiUrl, HERMES_URL_POLICY);
  } catch {
    throw new HermesNotConfiguredError("The Hermes API URL in Settings is not a valid http(s) URL");
  }
  return apiUrl.replace(/\/+$/, "");
}

// `verbose` is for the operator-only Test connection route; everything a
// session can see gets the generic message, with the detail logged instead.
async function checkHealth(root: string, verbose = false): Promise<void> {
  try {
    const res = await fetch(`${root}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      redirect: "manual",
      dispatcher: getPinnedDispatcher(HERMES_URL_POLICY),
    } as RequestInit);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    const detail = `Hermes API unreachable at ${root}/health (${(err as Error).message})`;
    throw new HermesUnavailableError(
      verbose ? detail : "The Hermes API is unreachable — review not dispatched",
      detail,
    );
  }
}

/** Settings → Integrations "Test connection": health check only, no key needed. */
export async function testHermesConnection(app: FastifyInstance): Promise<void> {
  const { apiUrl } = getStoredSettings(app.db).reviewRelay;
  if (!apiUrl) throw new HermesNotConfiguredError("Set the Hermes API URL first");
  await checkHealth(baseUrl(apiUrl), true);
}

export interface HermesReviewRequest {
  owner: string;
  repo: string;
  prNumber: number;
  /** PR head commit; part of the Idempotency-Key, so a push is always a fresh review. */
  headSha: string;
  /** Dispatching Mullion session, so only it can stop the run. */
  sessionId?: number;
}

/**
 * Cheap configuration gate (settings + key lookups only): the route calls it
 * before any GitHub work so an unconfigured install reports "No reviewer is
 * configured" rather than an unrelated remote/credentials error. Returns the
 * key for the dispatch.
 */
export function assertReviewerConfigured(app: FastifyInstance): string {
  const { provider, apiUrl } = getStoredSettings(app.db).reviewRelay;
  if (provider !== "hermes") {
    throw new HermesNotConfiguredError(
      "No reviewer is configured for this Mullion — use the repository's own review process",
    );
  }
  const key = getHermesKey(app);
  if (!apiUrl || !key) {
    throw new HermesNotConfiguredError(
      "The Hermes review relay is not configured — choose Hermes and set the API URL and key in Settings → Integrations",
    );
  }
  return key;
}

/**
 * Asks hermes-01 to review a PR. Resolves once Hermes admits the run (202 + run
 * id); the agent then runs asynchronously and posts the review to GitHub
 * itself. Never waits for the review to finish — poll with
 * `getHermesReviewStatus`.
 */
export async function requestHermesReview(
  app: FastifyInstance,
  { owner, repo, prNumber, headSha, sessionId }: HermesReviewRequest,
): Promise<{ runId: string; status: string; replayed: boolean }> {
  return requestRelay(app, {
    kind: "pull_request",
    owner,
    repo,
    number: prNumber,
    headSha,
    sessionId,
  });
}

/**
 * Dispatches a relay run for any target kind (issue #1629). A pull request
 * review and an issue triage are the same job with a different target and a
 * different prompt, so they share one dispatch path, one cooldown, one run
 * index and one status surface.
 */
export async function requestRelay(
  app: FastifyInstance,
  target: RelayTarget,
): Promise<{ runId: string; status: string; replayed: boolean }> {
  const { owner, repo, number } = target;
  const settings = getStoredSettings(app.db).reviewRelay;
  const { apiUrl, model, cooldownMinutes } = settings;
  const key = assertReviewerConfigured(app);
  const promptRepo = target.kind === "issue" ? settings.triagePromptRepo : settings.promptRepo;
  const promptPath = target.kind === "issue" ? settings.triagePromptPath : settings.promptPath;
  if (promptRepo && !isValidPromptLocation(promptRepo, promptPath)) {
    throw new HermesNotConfiguredError(
      "The prompt repository/path in Settings is invalid — use owner/repo and a plain relative path",
    );
  }
  const root = baseUrl(apiUrl);

  const cooldownKey = cooldownKeyFor(target);
  sweepCooldown(Date.now(), cooldownMinutes * 60_000);
  const last = lastRequested.get(cooldownKey);
  if (last !== undefined) {
    const remainingMs = cooldownMinutes * 60_000 - (Date.now() - last);
    if (remainingMs > 0) {
      throw new ReviewCooldownError(
        Math.ceil(remainingMs / 1000),
        target.kind === "pull_request" ? target.headSha : undefined,
        target.kind,
      );
    }
  }
  // Reserve the slot BEFORE the awaits below: the check above and a later
  // set would otherwise let two concurrent requests for one commit both pass
  // and double-dispatch. A failed dispatch gives the slot back.
  lastRequested.set(cooldownKey, Date.now());
  try {
    // Hermes replays an identical request that reuses a key (same run id, even
    // once finished) for 24h, so a key per commit alone would make a deliberate
    // re-request — after a failed or stopped run — silently dispatch nothing.
    // Bucketing by the cooldown window keeps a retry of one request (a failure
    // frees the cooldown slot) idempotent while a later request gets a new key.
    // With the cooldown disabled (0) there is no window: every request is fresh.
    // The bucket window and the cooldown window are the same length on
    // purpose (issue #1703): the cooldown is keyed by the commit, so "the
    // cooldown has expired" and "the idempotency bucket has rolled over" stay
    // in step — a same-commit request is refused by the cooldown until the
    // bucket rolls, and dispatched fresh after it does.
    const bucket =
      cooldownMinutes > 0 ? Math.floor(Date.now() / (cooldownMinutes * 60_000)) : randomUUID();
    // The key names the kind, so a triage of issue #5 and a review of PR #5
    // are never the same request as far as Hermes' replay window is
    // concerned.
    const scope =
      target.kind === "issue"
        ? `mullion-triage:${owner}/${repo}#${number}`
        : `mullion-review:${owner}/${repo}#${number}@${target.headSha}`;
    const idempotencyKey = `${scope}:${bucket}`;
    const run = await dispatchReview(root, key, {
      idempotencyKey,
      model,
      kind: target.kind,
      owner,
      repo,
      number,
      promptRepo,
      promptPath,
    });
    trackRun({
      ...run,
      kind: target.kind,
      owner,
      repo,
      prNumber: number,
      headSha: target.headSha ?? "",
      sessionId: target.sessionId,
      dispatchedAt: Date.now(),
    });
    return { runId: run.runId, status: run.status, replayed: run.replayed };
  } catch (err) {
    if (last === undefined) lastRequested.delete(cooldownKey);
    else lastRequested.set(cooldownKey, last);
    if (err instanceof HermesUnavailableError && err.detail) {
      app.log.warn({ detail: err.detail }, "Hermes review relay failed");
    }
    throw err;
  }
}

// One authenticated call against the Hermes API. Never follows a redirect with
// the bearer attached (see remote-host-client.ts's rawFetch for the same
// reasoning); a 401/403 is always HermesAuthError.
async function hermesFetch(
  root: string,
  key: string,
  path: string,
  init: { method: string; body?: string; headers?: Record<string, string>; timeoutMs: number },
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${root}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
      body: init.body,
      signal: AbortSignal.timeout(init.timeoutMs),
      redirect: "manual",
      dispatcher: getPinnedDispatcher(HERMES_URL_POLICY),
    } as RequestInit);
  } catch (err) {
    throw new HermesUnavailableError(
      "Could not reach the Hermes API",
      `${init.method} ${path}: ${(err as Error).message}`,
    );
  }
  if (res.status === 401 || res.status === 403) {
    void res.body?.cancel().catch(() => undefined);
    throw new HermesAuthError(res.status);
  }
  return res;
}

// The API's own error text usually names the problem (e.g. a wrong `model`);
// keep a bounded snippet as server-side detail only.
async function unavailableFromResponse(
  res: Response,
  what: string,
): Promise<HermesUnavailableError> {
  const snippet = (await readBounded(res, 2_000).catch(() => null)) ?? "(body too large)";
  const retryAfter = Number(res.headers.get("retry-after"));
  return new HermesUnavailableError(
    `Hermes API returned HTTP ${res.status} — ${what}`,
    `HTTP ${res.status}: ${snippet.slice(0, 500)}`,
    Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter) : undefined,
  );
}

async function dispatchReview(
  root: string,
  key: string,
  r: {
    idempotencyKey: string;
    model: string;
    kind: RelayTargetKind;
    owner: string;
    repo: string;
    number: number;
    promptRepo: string;
    promptPath: string;
  },
): Promise<{ runId: string; status: string; replayed: boolean }> {
  const prompt = r.promptRepo
    ? await loadReviewPrompt(r.promptRepo, r.promptPath)
    : r.kind === "issue"
      ? BUILTIN_TRIAGE_PROMPT
      : BUILTIN_REVIEW_PROMPT;
  await checkHealth(root);

  const body = JSON.stringify({
    model: r.model,
    input: buildRelayMessage(r.kind, r.owner, r.repo, r.number, prompt),
  });
  const res = await hermesFetch(root, key, "/v1/runs", {
    method: "POST",
    body,
    // Hermes reserves this durably for 24h: a retry of this request replays it.
    headers: { "Idempotency-Key": r.idempotencyKey },
    timeoutMs: DISPATCH_TIMEOUT_MS,
  });
  if (res.status === 409) {
    // 409 also covers ownership / generation / identity refusals, which are not
    // "a review is already coming": only the idempotency conflict means that.
    const refusal = await readJson<{ error?: { code?: unknown }; code?: unknown }>(res);
    const code = refusal?.error?.code ?? refusal?.code;
    if (code === "idempotency_key_conflict") throw new ReviewConflictError();
    throw new HermesUnavailableError(
      "Hermes refused the review request (HTTP 409) — review not dispatched",
      `HTTP 409: ${JSON.stringify(refusal)?.slice(0, 300)}`,
    );
  }
  if (!res.ok) throw await unavailableFromResponse(res, "review not dispatched");
  const parsed = await readJson<{ run_id?: unknown; status?: unknown }>(res);
  if (typeof parsed?.run_id !== "string" || parsed.run_id === "") {
    throw new HermesUnavailableError(
      "Hermes accepted the request but returned no run id",
      `unexpected /v1/runs body: ${JSON.stringify(parsed)?.slice(0, 200)}`,
    );
  }
  return {
    runId: parsed.run_id,
    status: typeof parsed.status === "string" ? parsed.status : "queued",
    // Hermes answers a repeat of an earlier request with the ORIGINAL run
    // (possibly already finished) and this header, instead of starting one.
    replayed: res.headers.get("idempotency-replayed") === "true",
  };
}

async function readJson<T>(res: Response): Promise<T | null> {
  const text = await readBounded(res, 256_000).catch(() => null);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export interface ReviewRunStatus {
  provider: "hermes";
  runId: string;
  /** What the run acts on (issue #1629). */
  kind: RelayTargetKind;
  /** Hermes' own status, or "not_found" when no run is known / it has expired. */
  status: string;
  output?: string;
  error?: string;
  shuttingDown: boolean;
  repo: string;
  /**
   * The PR or issue number the run acts on. `prNumber` below is the same
   * number under its review-era name — kept for the review path's existing
   * consumers, but "prNumber" for an issue reads wrong (issue #1629).
   */
  number: number;
  prNumber: number;
  headSha: string;
  dispatchedAt: string;
}

function toStatus(record: ReviewRunRecord, run: Record<string, unknown> | null): ReviewRunStatus {
  const text = (v: unknown): string | undefined =>
    typeof v === "string" && v !== "" ? v.slice(0, MAX_RUN_OUTPUT_CHARS) : undefined;
  return {
    provider: "hermes",
    runId: record.runId,
    kind: record.kind,
    status: run ? (typeof run.status === "string" ? run.status : "unknown") : "not_found",
    output: text(run?.output),
    error: text(run?.error),
    shuttingDown: run?.shutdown_requested_at != null,
    repo: `${record.owner}/${record.repo}`,
    number: record.prNumber,
    prNumber: record.prNumber,
    headSha: record.headSha,
    dispatchedAt: new Date(record.dispatchedAt).toISOString(),
  };
}

async function fetchRun(
  root: string,
  key: string,
  record: ReviewRunRecord,
): Promise<ReviewRunStatus> {
  const res = await hermesFetch(root, key, `/v1/runs/${encodeURIComponent(record.runId)}`, {
    method: "GET",
    timeoutMs: STATUS_TIMEOUT_MS,
  });
  if (res.status === 404) {
    void res.body?.cancel().catch(() => undefined);
    return toStatus(record, null);
  }
  if (!res.ok) throw await unavailableFromResponse(res, "could not read the run status");
  const run = await readJson<Record<string, unknown>>(res);
  // An empty / non-JSON / oversized 200 (e.g. a proxy page) is not "the run
  // does not exist"; keep that to a real 404.
  return run ? toStatus(record, run) : { ...toStatus(record, null), status: "unknown" };
}

/**
 * Latest run this Mullion dispatched for a target, or null (restart, or never
 * requested). The kind is part of the key (issue #1629), so a triage run
 * never answers for a PR of the same number.
 */
export function getRunForTarget(
  kind: RelayTargetKind,
  owner: string,
  repo: string,
  number: number,
): ReviewRunRecord | null {
  const id = latestRunByPr.get(targetKey(kind, owner, repo, number));
  return (id && runsById.get(id)) || null;
}

/** Latest run this Mullion dispatched for a PR, or null (restart, or never requested). */
export function getReviewRunForPr(
  owner: string,
  repo: string,
  prNumber: number,
): ReviewRunRecord | null {
  return getRunForTarget("pull_request", owner, repo, prNumber);
}

/** Status of the latest review run for a PR; `status: "not_found"` when none is known. */
export async function getHermesReviewStatus(
  app: FastifyInstance,
  { owner, repo, prNumber }: { owner: string; repo: string; prNumber: number },
): Promise<
  ReviewRunStatus | { provider: "hermes"; status: "not_found"; repo: string; prNumber: number }
> {
  return getRelayStatus(app, {
    kind: "pull_request",
    owner,
    repo,
    number: prNumber,
  });
}

/**
 * Status of the latest relay run for a target; `status: "not_found"` when
 * none is known (issue #1629 — the same surface serves a review and a
 * triage).
 */
export async function getRelayStatus(
  app: FastifyInstance,
  target: { kind: RelayTargetKind; owner: string; repo: string; number: number },
): Promise<
  | ReviewRunStatus
  | {
      provider: "hermes";
      status: "not_found";
      repo: string;
      number: number;
      prNumber: number;
      kind: RelayTargetKind;
    }
> {
  const key = assertReviewerConfigured(app);
  const root = baseUrl(getStoredSettings(app.db).reviewRelay.apiUrl);
  const record = getRunForTarget(target.kind, target.owner, target.repo, target.number);
  if (!record) {
    // Nothing tracked here (restart, or the workflow started the review).
    // Hermes still holds the run under the idempotency key but offers no
    // lookup by key, so say so plainly.
    return {
      provider: "hermes",
      status: "not_found",
      repo: `${target.owner}/${target.repo}`,
      number: target.number,
      prNumber: target.number,
      kind: target.kind,
    };
  }
  return fetchRun(root, key, record);
}

/** Recent runs with their live Hermes status — the Settings "Recent reviews" list. */
export async function listHermesReviews(app: FastifyInstance): Promise<ReviewRunStatus[]> {
  const key = assertReviewerConfigured(app);
  const root = baseUrl(getStoredSettings(app.db).reviewRelay.apiUrl);
  const recent = [...runsById.values()].reverse().slice(0, MAX_LISTED_RUNS);
  return Promise.all(
    recent.map((record) =>
      fetchRun(root, key, record).catch((): ReviewRunStatus => ({
        ...toStatus(record, null),
        status: "unknown",
      })),
    ),
  );
}

/**
 * Stops a running review. `callerSessionId` is set for agent callers, who may
 * only stop runs their own session dispatched; the operator UI passes none.
 */
export async function stopHermesReview(
  app: FastifyInstance,
  runId: string,
  callerSessionId?: number,
): Promise<{ runId: string; status: string }> {
  const key = assertReviewerConfigured(app);
  const root = baseUrl(getStoredSettings(app.db).reviewRelay.apiUrl);
  const record = runsById.get(runId);
  if (!record) throw new ReviewRunNotFoundError();
  if (callerSessionId !== undefined && record.sessionId !== callerSessionId) {
    throw new ReviewRunForbiddenError();
  }
  const res = await hermesFetch(root, key, `/v1/runs/${encodeURIComponent(runId)}/stop`, {
    method: "POST",
    timeoutMs: STATUS_TIMEOUT_MS,
  });
  if (res.status === 404) {
    void res.body?.cancel().catch(() => undefined);
    throw new ReviewRunNotFoundError();
  }
  if (!res.ok) throw await unavailableFromResponse(res, "could not stop the run");
  const parsed = await readJson<{ status?: unknown }>(res);
  return { runId, status: typeof parsed?.status === "string" ? parsed.status : "stopping" };
}
