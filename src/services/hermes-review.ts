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
// The API holds the POST open until the agent finishes (minutes), so this cap
// trips on every real review. A timeout after the health check passed is the
// NORMAL "accepted and running" outcome, not an error — the same reasoning as
// the `curl -m 20` relay in s3ntin3l8/.github's hermes-review.yml.
const DISPATCH_TIMEOUT_MS = 15_000;
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
  constructor(readonly retryAfterSeconds: number) {
    super(
      `A review of this PR was requested recently — wait ${retryAfterSeconds}s before requesting another`,
    );
    this.name = "ReviewCooldownError";
  }
}

// Deliberately generic: nothing here names a particular host's scripts or
// profile layout, so it works for any Hermes review-bot setup. What matters
// is WHO posts the review — a GitHub App bot identity that can give an
// official verdict — so that is stated as a requirement.
export function buildReviewMessage(
  owner: string,
  repo: string,
  prNumber: number,
  prompt: string,
): string {
  const header =
    `Target: pr #${prNumber} in repo ${owner}/${repo}\n` +
    "Post the review as your GitHub App bot identity (an installation token from your profile's " +
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

// In-memory only: a server restart clears it, which is acceptable — the
// cooldown exists to stop an agent looping on re-reviews, not to be a durable
// rate limit.
const lastRequested = new Map<string, number>();
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

/** Test hook — clears the cooldown and prompt caches. */
export function resetHermesReviewState(): void {
  lastRequested.clear();
  promptCache.clear();
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

function isTimeout(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
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
 * Asks hermes-01 to review a PR. Resolves once the request is accepted (the
 * agent runs asynchronously and posts the review to GitHub itself); never
 * waits for the review to finish.
 */
export async function requestHermesReview(
  app: FastifyInstance,
  { owner, repo, prNumber }: HermesReviewRequest,
): Promise<void> {
  const { apiUrl, model, promptRepo, promptPath, cooldownMinutes } = getStoredSettings(
    app.db,
  ).reviewRelay;
  const key = assertReviewerConfigured(app);
  if (promptRepo && !isValidPromptLocation(promptRepo, promptPath)) {
    throw new HermesNotConfiguredError(
      "The prompt repository/path in Settings is invalid — use owner/repo and a plain relative path",
    );
  }
  const root = baseUrl(apiUrl);

  const cooldownKey = `${owner}/${repo}#${prNumber}`.toLowerCase();
  const last = lastRequested.get(cooldownKey);
  if (last !== undefined) {
    const remainingMs = cooldownMinutes * 60_000 - (Date.now() - last);
    if (remainingMs > 0) throw new ReviewCooldownError(Math.ceil(remainingMs / 1000));
  }
  // Reserve the slot BEFORE the awaits below: the check above and a later
  // set would otherwise let two concurrent requests for one PR both pass and
  // double-dispatch. A failed dispatch gives the slot back.
  lastRequested.set(cooldownKey, Date.now());
  try {
    await dispatchReview(root, key, { model, owner, repo, prNumber, promptRepo, promptPath });
  } catch (err) {
    if (last === undefined) lastRequested.delete(cooldownKey);
    else lastRequested.set(cooldownKey, last);
    if (err instanceof HermesUnavailableError && err.detail) {
      app.log.warn({ detail: err.detail }, "Hermes review relay failed");
    }
    throw err;
  }
}

async function dispatchReview(
  root: string,
  key: string,
  r: {
    model: string;
    owner: string;
    repo: string;
    prNumber: number;
    promptRepo: string;
    promptPath: string;
  },
): Promise<void> {
  const prompt = r.promptRepo
    ? await loadReviewPrompt(r.promptRepo, r.promptPath)
    : BUILTIN_REVIEW_PROMPT;
  await checkHealth(root);

  const body = JSON.stringify({
    model: r.model,
    messages: [{ role: "user", content: buildReviewMessage(r.owner, r.repo, r.prNumber, prompt) }],
    stream: false,
  });
  let res: Response | null = null;
  try {
    res = await fetch(`${root}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
      // Never follow a redirect with the bearer attached (see
      // remote-host-client.ts's rawFetch for the same reasoning).
      redirect: "manual",
      dispatcher: getPinnedDispatcher(HERMES_URL_POLICY),
    } as RequestInit);
  } catch (err) {
    // Timed out after the health check passed: accepted and running.
    if (!isTimeout(err)) {
      throw new HermesUnavailableError(
        "Could not reach the Hermes API to dispatch the review",
        (err as Error).message,
      );
    }
  }
  if (res) {
    if (res.status === 401 || res.status === 403) {
      void res.body?.cancel().catch(() => undefined);
      throw new HermesAuthError(res.status);
    }
    if (!res.ok) {
      // The API's own error text usually names the problem (e.g. a wrong
      // `model`); keep a bounded snippet as server-side detail only.
      const snippet = (await readBounded(res, 2_000).catch(() => null)) ?? "(body too large)";
      throw new HermesUnavailableError(
        `Hermes API returned HTTP ${res.status} — review not dispatched`,
        `HTTP ${res.status}: ${snippet.slice(0, 500)}`,
      );
    }
    void res.body?.cancel().catch(() => undefined);
  }
}
