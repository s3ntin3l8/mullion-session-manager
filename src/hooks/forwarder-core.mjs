import path from "node:path";

// Pure, testable mapping functions for the shared hook forwarder (issue
// #174). Deliberately plain JavaScript, not TypeScript — see forwarder.mjs's
// header comment for why the whole forwarder is .mjs. Split out from
// forwarder.mjs itself (the thin stdin/socket/stdout shim) so vitest can
// exercise every agent dialect's mapping logic directly, in-process, without
// spawning a real subprocess or socket — see the plan's "Testability of the
// forwarder" note (CI's coverage-fail-under: 80 gate would otherwise be hard
// to satisfy for a file that's only ever invoked as a subprocess).
//
// Each `map<Agent><Kind>` function takes that hook's raw stdin payload
// (already JSON-parsed) and returns a hook-protocol message object, an
// ARRAY of them (a single hook invocation that touches several files — see
// mapCodexPostToolUse below), or `null`/`[]` if this particular event
// doesn't map to anything worth sending (e.g. a PostToolUse call for a tool
// that isn't a file edit). See src/services/hook-protocol.ts for the wire
// shape each message must match.

// Tools whose PostToolUse payload maps to a `file_change` message — kept in
// sync with claude-code.ts's PostToolUse hook `matcher`, which already
// restricts Claude Code to invoking this forwarder only for these tools;
// checked again here defensively in case a hand-edited settings file (or a
// future Claude Code version) ever calls through without that matcher.
const CLAUDE_CODE_FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

// Issue: worktree/branch detection — a single Bash tool call is very often
// several shell commands chained together (`git fetch ... && git worktree
// add ...`, `mkdir -p .worktrees && git worktree add ...`), and
// `parseWorktreeAddCommand`/`parseGitCheckoutCommand` below only ever looked
// at token[0] of the WHOLE string, so a leading unrelated command silently
// hid the git invocation that mattered. Splits on the shell's SEQUENTIAL
// command separators — `&&`, `||`, `;`, and newlines — so each segment can
// be tried on its own. This is still a string-level heuristic, not a real
// shell parse (a separator inside a quoted string would be split
// incorrectly too), same "best-effort, never throw" posture as the parsers
// that consume its output.
//
// Deliberately does NOT split on a bare `|` (pipe): unlike `&&`/`;`, a pipe
// doesn't separate independent top-level commands — it's extremely common
// INSIDE a command substitution (`git checkout $(git branch --show-current
// | grep foo)`), which naive top-level splitting can't tell apart from a
// real pipe between two Bash tool-call-level commands, and mis-splitting
// there risks garbling both halves' tokens in ways this string-level parser
// can't recover from (flagged in review — see PR #335).
function splitShellSegments(command) {
  return command
    .split(/&&|\|\||;|\n/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

// Issue: worktree/branch detection — `git -C <path> worktree add ...` / `git
// -C <path> checkout ...` run against a different directory than the
// command's own cwd, but still change something worth reporting; `git -c
// <key>=<value> checkout ...` (a per-invocation config override, common in
// CI/agent scripts — e.g. `-c core.hooksPath=/dev/null`) doesn't change the
// directory at all but is just as valid a prefix before the subcommand.
// Both are git GLOBAL options, valid in any order and repeated any number
// of times (`git -c a=b -C /repo -c c=d checkout foo` is legal git), so
// this strips every leading `-C <path>`/`-c <key>=<value>` pair — not just
// one of each — before the two parsers below see the tokens, exactly as if
// none of them had been there. Stops at the first token that isn't one of
// these two flags (including a malformed trailing `-C`/`-c` with no value,
// left alone rather than guessed at) — that's the subcommand position the
// callers below expect at a fixed index. Case-sensitive: `-c` and `-C` are
// different git flags, and neither parser here recognizes any of git's
// other global flags (`--git-dir`, `-c` is deliberately the exception since
// it's the one observed to actually show up in real agent-issued commands).
function stripLeadingGitGlobalFlags(tokens) {
  const kept = [tokens[0]];
  let i = 1;
  while ((tokens[i] === "-C" || tokens[i] === "-c") && i + 1 < tokens.length) {
    i += 2;
  }
  kept.push(...tokens.slice(i));
  return kept;
}

/** Extracts the last `-C <path>` argument from a git command segment (before
 * stripLeadingGitGlobalFlags strips it), or null when absent. Only the LAST
 * `-C` matters — git itself uses the last one when multiple are given. */
function extractGitChdirTarget(segment) {
  const parts = segment.trim().split(/\s+/);
  let i = 1;
  let lastChdir = null;
  while ((parts[i] === "-C" || parts[i] === "-c") && i + 1 < parts.length) {
    if (parts[i] === "-C") lastChdir = parts[i + 1];
    i += 2;
  }
  return lastChdir;
}

// Issue: worktree/branch detection — a leading `cd <dir>` segment invalidates
// `resolveCwd` (the command's STARTING cwd) as a base for resolving a later
// segment's relative path, since the shell has since moved elsewhere. Shared
// matcher for the `seenCd` tracking in `detectWorktreeAdd`/`mapAgyPreToolUse`.
function isCdSegment(segment) {
  return /^cd\s/i.test(segment.trim());
}

/** Resolves a `parseWorktreeAddCommand` result's (possibly relative)
 * `worktree` path to absolute, given the segment it came from and the
 * command's starting cwd — shared by `detectWorktreeAdd` and
 * `mapAgyPreToolUse`. Prefers the segment's own `git -C <dir>` target (if
 * any) over `baseCwd`; falls back to the raw relative path, unresolved, when
 * neither is available or a prior segment `cd`'d elsewhere (`seenCd`) — see
 * `detectWorktreeAdd`'s own doc comment for why that's the safe fallback. */
function resolveWorktreePath(segment, worktree, baseCwd, seenCd) {
  const chdirTarget = extractGitChdirTarget(segment);
  const base =
    chdirTarget || (typeof baseCwd === "string" && baseCwd.length > 0 && !seenCd ? baseCwd : null);
  return base ? path.resolve(base, worktree) : worktree;
}

export function mapClaudeCodeNotification(payload) {
  if (payload?.notification_type === "idle_prompt") {
    return { kind: "progress", phase: "done" };
  }
  const body = typeof payload?.message === "string" ? payload.message : "";
  return { kind: "notification", title: "Claude Code", body };
}

export function mapClaudeCodeStop(payload) {
  const result = { kind: "progress", phase: "done" };
  if (payload && typeof payload.last_assistant_message === "string") {
    result.lastAssistantMessage = payload.last_assistant_message;
  }
  if (payload && Array.isArray(payload.background_tasks)) {
    result.backgroundTasks = payload.background_tasks;
  }
  return result;
}

export function mapClaudeCodePostToolUse(payload) {
  const toolName = payload?.tool_name;
  if (typeof toolName !== "string") return null;

  // Fix: status-clearing-semantics — every completed tool call is now also
  // forward-progress evidence a pending permission/plan for THAT tool has
  // resolved (see ToolDoneHookMessage's doc comment in hook-protocol.ts).
  // Always appended alongside whatever this function would otherwise have
  // returned (previously: null for anything but a file edit/worktree/
  // checkout) — mapClaudeCodeEvent's own array-spreading wrapper handles a
  // [detected, toolDone] pair the same way it already handles a bare single
  // message.
  const toolDone = { kind: "tool_done", tool: toolName };

  // Check for git worktree add before checking the file-tools set — a Bash
  // command that creates a worktree is interesting even though Bash is not
  // a file-editing tool.
  const worktreeAddResult = detectWorktreeAdd(payload, payload?.cwd);
  if (worktreeAddResult) return [worktreeAddResult, toolDone];

  // A plain `git checkout`/`git switch` also changes this session's
  // effective branch, even in a shared (non-worktree) checkout.
  const checkoutResult = detectGitCheckout(payload);
  if (checkoutResult) return [checkoutResult, toolDone];

  if (!CLAUDE_CODE_FILE_TOOLS.has(toolName)) {
    return toolDone;
  }
  const input = payload?.tool_input;
  const filePath =
    typeof input?.file_path === "string"
      ? input.file_path
      : typeof input?.notebook_path === "string"
        ? input.notebook_path
        : null;
  if (filePath === null || filePath.length === 0) {
    return toolDone;
  }
  return [{ kind: "file_change", path: filePath, action: "modify" }, toolDone];
}

const GATE_PROMPT_MAX_CHARS = 200;

function summarizeToolCall(payload) {
  const toolName = typeof payload?.tool_name === "string" ? payload.tool_name : "a tool";
  const input = payload?.tool_input;
  const detail =
    typeof input?.command === "string"
      ? input.command
      : typeof input?.file_path === "string"
        ? input.file_path
        : null;
  if (detail === null || detail.length === 0) return toolName;
  const truncated =
    detail.length > GATE_PROMPT_MAX_CHARS ? `${detail.slice(0, GATE_PROMPT_MAX_CHARS)}…` : detail;
  return `${toolName}: ${truncated}`;
}

export function mapClaudeCodePreToolUse(payload) {
  return { kind: "review_gate", state: "waiting", prompt: summarizeToolCall(payload) };
}

export function mapClaudeCodeExitPlanMode(payload) {
  const input = payload?.tool_input;
  const plan = typeof input?.plan === "string" ? input.plan : "";
  const result = { kind: "plan_ready", plan };
  if (typeof input?.plan_file_path === "string") {
    result.filePath = input.plan_file_path;
  }
  return result;
}

export function mapClaudeCodeSessionStart(payload) {
  const result = { kind: "session_start" };
  if (payload && typeof payload.source === "string") {
    result.source = payload.source;
  }
  return result;
}

/** Issue: sidebar worktree detection — maps Claude Code's CwdChanged event
 * to a `cwd_changed` hook message so Mullion can track where Claude is
 * actually working. */
export function mapClaudeCodeCwdChanged(payload) {
  const newCwd = typeof payload?.new_cwd === "string" ? payload.new_cwd : null;
  if (newCwd === null || newCwd.length === 0) return null;
  return { kind: "cwd_changed", cwd: newCwd };
}

/** Issue: sidebar worktree detection — parses a `git worktree add` command
 * string and returns `{ branch, worktree }` when matched, or `null` for a
 * command that isn't a worktree creation. Handles short flags (`-b`, `-f`),
 * long flags (`--force`, `--guess-remote`), value-taking flags (`-b`, `-B`,
 * `--reason`), and a trailing `<commit-ish>` positional argument (the branch
 * checked out in the new worktree when no `-b`/`-B` flag is given) — in ANY
 * relative order to the worktree path itself (`git worktree add <path> -b
 * <branch> <commit-ish>` is just as valid to git, and just as real-world, as
 * `-b <branch> <path> <commit-ish>` — observed both ways in actual session
 * transcripts). Collects every non-flag token as a positional and only
 * decides which is the worktree path vs. the trailing commit-ish once the
 * whole command has been scanned, rather than assuming the FIRST positional
 * seen is the worktree path and immediately treating whatever follows it as
 * the commit-ish. Strips surrounding quotes from each token to tolerate
 * shell-quoted arguments. Extracted as a shared helper so both
 * `detectWorktreeAdd` and `mapAgyPreToolUse` use the same parsing logic. */
function parseWorktreeAddCommand(command) {
  const tokens = stripLeadingGitGlobalFlags(command.trim().split(/\s+/));
  if (tokens.length < 4 || tokens[0] !== "git" || tokens[1] !== "worktree" || tokens[2] !== "add") {
    return null;
  }

  let branch = null;
  let sawBranchFlag = false;
  const positionals = [];

  for (let i = 3; i < tokens.length; i++) {
    const tok = tokens[i].replace(/^["']|["']$/g, "");
    if (tok === "-b" || tok === "-B") {
      sawBranchFlag = true;
      branch = tokens[i + 1]?.replace(/^["']|["']$/g, "") ?? null;
      i++;
      continue;
    }
    if (tok === "--reason") {
      i++;
      continue;
    }
    if (tok.startsWith("-")) continue;
    positionals.push(tok);
  }

  const worktree = positionals[0] ?? null;
  if (!worktree) return null;
  // A trailing commit-ish only counts as the branch when `-b`/`-B` wasn't
  // given — if it was, the second positional is just the ref the worktree
  // is checked out FROM, not a branch name.
  if (!sawBranchFlag && positionals.length > 1) {
    branch = positionals[1];
  }
  const resolvedBranch = branch ?? path.basename(worktree);
  // Independent review, PR #466 — a worktree path ending in `/` (or bare
  // `/`) makes `path.basename` return an empty string, which used to
  // silently become a `git_branch` message with `branch: ""`. That fails
  // hook-protocol.ts's validateGitBranch (requires a non-empty string), and
  // once #462's fix started sending siblings ahead of a blocking message,
  // this became a REAL gate-hijack: hooks.ts's {error} reply to the
  // malformed line arrives as runGate's first data event and gets misread
  // as the actual decision, auto-denying a gate no human ever saw. Treat an
  // empty resolved branch as "no branch detected" instead, same as the
  // other guards in this file.
  if (resolvedBranch.length === 0) return null;
  return { branch: resolvedBranch, worktree };
}

/** Issue: sidebar worktree detection — parses a PostToolUse payload for a
 * Bash tool call and detects `git worktree add` commands, including ones
 * chained with other shell commands (`mkdir -p .worktrees && git worktree
 * add ...`) via splitShellSegments. Returns a `git_branch` hook message when
 * a worktree creation was detected, or `null` otherwise. When more than one
 * segment matches, the LAST one wins — that's the worktree the command
 * actually ended on. Shared by Claude Code and Codex.
 *
 * `resolveCwd` — when provided, the absolute working directory the command
 * ran in, used to resolve a relative worktree path to an absolute one so
 * PtyManager's `_liveCwd` passes the `isGitRepo` absolute-path check in
 * `resolveSessionCwdTargets` (issue: sidebar worktree detection — the
 * worktree path from the git command itself is typically relative, e.g.
 * `.worktrees/feat/x`, and is silently rejected by the absolute-path guard).
 *
 * NOTE: `resolveCwd` is only the STARTING working directory — if a prior
 * segment in a chained command changes directory (`cd /other/dir && git
 * worktree add ...`), resolveCwd is no longer correct for the resolution.
 * This function detects that case and falls back to the raw relative path
 * (which downstream rejects, same as the pre-resolveCwd behavior). */
export function detectWorktreeAdd(payload, resolveCwd) {
  const toolName = payload?.tool_name;
  const command = payload?.tool_input?.command;
  if (typeof command !== "string" || command.length === 0) return null;

  if (toolName !== "Bash" && toolName !== "run_command") return null;

  let seenCd = false;
  let result = null;
  for (const segment of splitShellSegments(command)) {
    if (isCdSegment(segment)) {
      seenCd = true;
      continue;
    }
    const parsed = parseWorktreeAddCommand(segment);
    if (parsed) {
      const worktree = resolveWorktreePath(segment, parsed.worktree, resolveCwd, seenCd);
      result = { kind: "git_branch", branch: parsed.branch, worktree };
    }
  }
  return result;
}

/** Issue: sidebar worktree detection — parses a `git checkout`/`git switch`
 * command string and returns `{ branch }` when it unambiguously switches the
 * checked-out branch, or `null` otherwise (this repo's own working tree is
 * shared across sessions, so a plain checkout — not just `git worktree add`
 * — is what most sessions actually use to change branch).
 *
 * Recognizes `git switch <name>` (with or without `-c`/`-C`) and
 * `git checkout -b|-B <name>`/`git checkout <name>` — but deliberately backs
 * off (`null`) for anything that could be a file restore rather than a
 * branch switch: a `--` pathspec separator, or more than one positional
 * argument after `checkout` (e.g. `git checkout <ref> <path>` or
 * `git checkout -- <file>`). This is a string-level heuristic, not a real
 * git invocation — a bare `git checkout <ref>` that happens to be a
 * detached commit-ish rather than a branch name is reported as if it were
 * one; that's the same "best-effort, never throw" posture as
 * `parseWorktreeAddCommand`. */
function parseGitCheckoutCommand(command) {
  const tokens = stripLeadingGitGlobalFlags(command.trim().split(/\s+/));
  if (tokens.length < 3 || tokens[0] !== "git") return null;
  const sub = tokens[1];
  if (sub !== "checkout" && sub !== "switch") return null;

  const rest = tokens.slice(2);
  if (rest.includes("--")) return null;

  let branch = null;
  let sawBranchFlag = false;
  const positionals = [];
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i].replace(/^["']|["']$/g, "");
    if (
      (sub === "checkout" && (tok === "-b" || tok === "-B")) ||
      (sub === "switch" && (tok === "-c" || tok === "-C"))
    ) {
      sawBranchFlag = true;
      branch = rest[i + 1]?.replace(/^["']|["']$/g, "") ?? null;
      i++;
      continue;
    }
    // A bare `-` is git's own shorthand for "the previously checked-out
    // branch" (`git checkout -`/`git switch -`) — a real positional
    // argument, not a flag, even though it starts with `-`. Everything
    // else starting with `-` is an actual flag to skip.
    if (tok === "-") {
      positionals.push(tok);
      continue;
    }
    if (tok.startsWith("-")) continue;
    positionals.push(tok);
  }

  if (sawBranchFlag) {
    return branch && branch.length > 0 ? { branch } : null;
  }
  // No -b/-B/-c/-C: ambiguous unless there's exactly one positional (a bare
  // ref/branch name) — more than one usually means a file-restore form
  // (`checkout <ref> <path>`), and zero means nothing to report. `git
  // switch` never takes a file argument, so a single positional there is
  // always a branch.
  if (positionals.length !== 1) return null;
  const candidate = positionals[0];
  // Independent review, PR #466 — same empty-branch hazard as
  // parseWorktreeAddCommand above: an explicitly-quoted empty argument
  // (`git checkout ""`) survives the quote-stripping above as an empty
  // string, which would otherwise become an unvalidatable `git_branch`
  // message. The sawBranchFlag branch above already guards this
  // (`branch && branch.length > 0`); this is the same guard for the bare-
  // positional form.
  if (candidate.length === 0) return null;
  if (sub === "switch") return { branch: candidate };
  // Bare `git checkout <arg>` is git's own famously overloaded form — the
  // same syntax restores a file from the index/a ref instead of switching
  // branches (`git checkout .`, `git checkout package.json`). Without
  // running git ourselves there's no way to know which one `<arg>` is, so
  // reject the shapes that are almost certainly a file/pathspec rather than
  // a branch name: current/parent dir, glob pathspecs, and extension-bearing
  // filenames. A bare extensionless filename (e.g. `git checkout Makefile`)
  // still slips through unrecognized — a known limit of this string-level
  // heuristic, same "best-effort, never throw" posture as
  // `parseWorktreeAddCommand`.
  if (candidate === "." || candidate === "..") return null;
  if (/[*?[\]]/.test(candidate)) return null;
  if (/\.\w+$/.test(candidate)) return null;
  return { branch: candidate };
}

/** Issue: sidebar worktree detection — parses a PostToolUse payload for a
 * Bash tool call and detects `git checkout`/`git switch` branch changes.
 * Returns a `git_branch` hook message (no `worktree`, since this is a
 * same-directory branch switch) or `null`. Shared by Claude Code and Codex. */
export function detectGitCheckout(payload) {
  const toolName = payload?.tool_name;
  const command = payload?.tool_input?.command;
  if (typeof command !== "string" || command.length === 0) return null;

  if (toolName !== "Bash" && toolName !== "run_command") return null;

  // Chained (`cd X && git checkout Y`) or sequential (`git checkout Y; npm
  // test`) commands are tried segment by segment — see splitShellSegments.
  // The LAST matching segment wins, since that's the branch the whole
  // command ended on.
  let result = null;
  for (const segment of splitShellSegments(command)) {
    const parsed = parseGitCheckoutCommand(segment);
    if (parsed) result = { kind: "git_branch", branch: parsed.branch };
  }
  return result;
}

export function mapClaudeCodePermissionRequest(payload) {
  const tool = typeof payload?.tool_name === "string" ? payload.tool_name : "a tool";
  const summary = summarizeToolCall(payload);
  return { kind: "permission_request", tool, summary };
}

export function mapClaudeCodeStopFailure(payload) {
  const error = payload && typeof payload.error === "string" ? payload.error : "unknown";
  const result = { kind: "stop_failure", error };
  if (payload && typeof payload.error_details === "string") {
    result.errorDetails = payload.error_details;
  }
  // Claude Code's own documented error_type enum (rate_limit, overloaded,
  // max_output_tokens, authentication_failed, ...) — the short, stable
  // label session-status.ts's deriveSessionStatus surfaces as `detail`.
  if (payload && typeof payload.error_type === "string") {
    result.errorType = payload.error_type;
  }
  return result;
}

export function mapClaudeCodePostToolUseFailure(payload) {
  const tool = typeof payload?.tool_name === "string" ? payload.tool_name : "a tool";
  const error = payload && typeof payload.error === "string" ? payload.error : "unknown";
  const summary = summarizeToolCall(payload);
  return { kind: "tool_failure", tool, error, summary };
}

export function mapClaudeCodeSessionEnd(payload) {
  const reason = payload && typeof payload.reason === "string" ? payload.reason : "other";
  const exitCode = typeof payload?.exit_code === "number" ? payload.exit_code : undefined;
  return exitCode === undefined
    ? { kind: "session_end", reason }
    : { kind: "session_end", reason, exitCode };
}

// Issue: extend surfaced session statuses — UserPromptSubmit is Claude
// Code's one deterministic "a new turn just started" signal (fires once per
// human prompt, before Claude processes it). No payload fields are needed:
// TurnStartHookMessage carries none — see its own doc comment in
// hook-protocol.ts for why this outranks waiting for `progress: generating`.
export function mapClaudeCodeUserPromptSubmit() {
  return { kind: "turn_start" };
}

export function mapClaudeCodePreCompact(payload) {
  const trigger =
    payload?.trigger === "manual" || payload?.trigger === "auto" ? payload.trigger : undefined;
  return trigger
    ? { kind: "compact", state: "started", trigger }
    : { kind: "compact", state: "started" };
}

export function mapClaudeCodePostCompact() {
  return { kind: "compact", state: "finished" };
}

export function mapClaudeCodeSubagentStart(payload) {
  const agentType = typeof payload?.agent_type === "string" ? payload.agent_type : undefined;
  return agentType
    ? { kind: "subagent", state: "started", agentType }
    : { kind: "subagent", state: "started" };
}

// Phase 5 (Track A) — `summary` carries SubagentStop's own last_assistant_message
// (the subagent's final text), absent on the start message since it hasn't
// produced one yet. `agentId`/`agentType` are NOT read from `payload` here —
// they're stamped onto every attributable message uniformly by
// applyAgentEnvelope() in mapClaudeCodeEvent below, from the same
// agent_id/agent_type fields every hook fired inside a subagent carries
// (verified empirically against a live SubagentStart/SubagentStop-bracketed
// tool call, not just the docs).
//
// Issue #428 — `background_tasks` is forwarded here too, mirroring
// mapClaudeCodeStop above: Claude Code's `SubagentStopHookInput` carries the
// same field, and it's the ONLY drain signal for a background subagent's own
// outstanding work (the parent's turn has already ended by the time this
// fires, so no further Stop/progress message reports the list shrinking).
export function mapClaudeCodeSubagentStop(payload) {
  const result = { kind: "subagent", state: "finished" };
  if (typeof payload?.last_assistant_message === "string") {
    result.summary = payload.last_assistant_message;
  }
  if (payload && Array.isArray(payload.background_tasks)) {
    result.backgroundTasks = payload.background_tasks;
  }
  return result;
}

// PermissionDenied fires "when a tool call is denied by the auto mode
// classifier" — a possible EXTRA release path for a pending
// permission_request (see PermissionResolvedHookMessage's doc comment in
// hook-protocol.ts for why this is never asserted as the ONLY release path).
export function mapClaudeCodePermissionDenied() {
  return { kind: "permission_resolved" };
}

export function mapClaudeCodeElicitation(payload) {
  const server = typeof payload?.server === "string" ? payload.server : undefined;
  return server
    ? { kind: "elicitation", state: "started", server }
    : { kind: "elicitation", state: "started" };
}

export function mapClaudeCodeElicitationResult() {
  return { kind: "elicitation", state: "finished" };
}

function mapClaudeCodeEventCore(kind, payload) {
  switch (kind) {
    case "Notification":
      return mapClaudeCodeNotification(payload);
    case "Stop":
      return mapClaudeCodeStop(payload);
    case "PostToolUse":
      return mapClaudeCodePostToolUse(payload);
    case "PreToolUse":
      if (payload?.tool_name === "ExitPlanMode") {
        return mapClaudeCodeExitPlanMode(payload);
      }
      return mapClaudeCodePreToolUse(payload);
    case "SessionStart":
      return mapClaudeCodeSessionStart(payload);
    case "CwdChanged":
      return mapClaudeCodeCwdChanged(payload);
    case "PermissionRequest":
      return mapClaudeCodePermissionRequest(payload);
    case "StopFailure":
      return mapClaudeCodeStopFailure(payload);
    case "PostToolUseFailure":
      return mapClaudeCodePostToolUseFailure(payload);
    case "SessionEnd":
      return mapClaudeCodeSessionEnd(payload);
    case "UserPromptSubmit":
      return mapClaudeCodeUserPromptSubmit();
    case "PreCompact":
      return mapClaudeCodePreCompact(payload);
    case "PostCompact":
      return mapClaudeCodePostCompact();
    case "SubagentStart":
      return mapClaudeCodeSubagentStart(payload);
    case "SubagentStop":
      return mapClaudeCodeSubagentStop(payload);
    case "PermissionDenied":
      return mapClaudeCodePermissionDenied();
    case "Elicitation":
      return mapClaudeCodeElicitation(payload);
    case "ElicitationResult":
      return mapClaudeCodeElicitationResult();
    default:
      return null;
  }
}

// Phase 5 (Track A) — the wire kinds hook-protocol.ts declares an
// agentId/agentType envelope for (file_change, tool_failure, subagent).
// Stamped in ONE place (applyAgentEnvelope, called from mapClaudeCodeEvent
// below) rather than in every individual map* function above, since Claude
// Code's base hook-input schema carries agent_id/agent_type on any event
// fired inside a subagent (verified empirically, not just documented) —
// every mapper already receives that same `payload`.
const AGENT_ATTRIBUTABLE_KINDS = new Set(["file_change", "tool_failure", "subagent"]);

// Non-empty, not just typeof === "string" — an empty agent_id/agent_type is
// treated as absent rather than stamped verbatim. Otherwise a mapper's own
// deliberate drop of an empty value (e.g. mapClaudeCodeSubagentStart's
// truthy check on agentType) would be silently undone right back onto the
// message by this function running afterward (independent review finding
// on PR #414 — traced the exact round-trip). hook-protocol.ts's
// parseAgentEnvelope also drops an empty/oversized value defensively, so
// this isn't load-bearing for correctness anymore, but not sending garbage
// over the wire in the first place is the better fix at the source.
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function withAgentEnvelope(payload, message) {
  if (message === null || message === undefined || !AGENT_ATTRIBUTABLE_KINDS.has(message.kind)) {
    return message;
  }
  const agentId = isNonEmptyString(payload?.agent_id) ? payload.agent_id : undefined;
  const agentType = isNonEmptyString(payload?.agent_type) ? payload.agent_type : undefined;
  if (agentId === undefined && agentType === undefined) return message;
  return {
    ...message,
    // Never overwrites a value a specific mapper already set (e.g. a
    // future mapper reading its own agentId/agentType) — same source
    // field either way, but a mapper's own read stays authoritative.
    // No current mapper sets `agentId` itself (only
    // mapClaudeCodeSubagentStart's `agentType`), so this guard is
    // forward-compatible rather than load-bearing today.
    ...(agentId !== undefined && message.agentId === undefined ? { agentId } : {}),
    ...(agentType !== undefined && message.agentType === undefined ? { agentType } : {}),
  };
}

function applyAgentEnvelope(payload, mapped) {
  if (mapped === null || mapped === undefined) return mapped;
  return Array.isArray(mapped)
    ? mapped.map((m) => withAgentEnvelope(payload, m))
    : withAgentEnvelope(payload, mapped);
}

// Issue: worktree/branch detection — Claude Code's base hook-input schema
// includes a `cwd` field on every event, not just CwdChanged's own
// old_cwd/new_cwd pair (confirmed against the CLI's own hookEventName-
// tagged payload schema). Relying on CwdChanged alone left `liveCwd`
// lagging badly: Claude Code only fires it from its own shell-set-cwd path,
// so a session could sit on a stale cwd through many later tool calls
// before CwdChanged happened to catch up (observed live — see this
// session's own plan doc). Piggybacking a `cwd_changed` onto every event
// converges `liveCwd` within a single hook call instead.
//
// Deliberately excludes the CwdChanged event itself: its own base `cwd` is
// the PRE-change directory (the authoritative new one is `new_cwd`, already
// handled by mapClaudeCodeCwdChanged above), so piggybacking it here would
// race a stale value ahead of the fresh one.
//
// Ordering: the piggybacked cwd_changed is always pushed FIRST, whatever
// the core mapper returned SECOND — same reasoning as
// mapCodexPostToolUse's matching comment: a git_branch message carrying
// `worktree` also sets `_liveCwd` itself, so pushing the stale payload.cwd
// after it would silently overwrite the correct worktree path this same
// event just reported.
export function mapClaudeCodeEvent(kind, payload) {
  const mapped = applyAgentEnvelope(payload, mapClaudeCodeEventCore(kind, payload));
  if (kind === "CwdChanged") return mapped;

  const cwd = payload?.cwd;
  if (typeof cwd !== "string" || cwd.length === 0) return mapped;

  const cwdMessage = { kind: "cwd_changed", cwd };
  if (mapped === null || mapped === undefined) return [cwdMessage];
  return Array.isArray(mapped) ? [cwdMessage, ...mapped] : [cwdMessage, mapped];
}

const APPLY_PATCH_HEADER_RE = /^\*\*\* (Update|Add|Delete) File: (.+)$/gm;
const APPLY_PATCH_ACTION_BY_VERB = { Update: "modify", Add: "create", Delete: "delete" };

export function mapCodexStop() {
  return { kind: "progress", phase: "done" };
}

export function mapCodexSessionStart(payload) {
  const source = typeof payload?.source === "string" ? payload.source : undefined;
  return source ? { kind: "session_start", source } : { kind: "session_start" };
}

export function mapCodexSessionEnd(payload) {
  const reason = typeof payload?.reason === "string" ? payload.reason : "other";
  return { kind: "session_end", reason };
}

export function mapCodexPermissionRequest(payload) {
  const toolName = typeof payload?.tool_name === "string" ? payload.tool_name : "a tool";
  const input = payload?.tool_input;
  const detail =
    typeof input?.command === "string"
      ? input.command
      : typeof input?.file_path === "string"
        ? input.file_path
        : null;
  const summary = detail && detail.length > 0 ? detail : toolName;
  return { kind: "permission_request", tool: toolName, summary };
}

// Issue: extend surfaced session statuses — was previously mapped to a
// generic `notification` message, which made every single prompt submission
// look like an attention-worthy event (a real, if minor, pre-existing bug:
// UserPromptSubmit fires on ordinary human input, not on anything the agent
// itself is signaling). `turn_start` is the correct, deterministic "a new
// turn began" signal instead — same remap Claude Code's own
// mapClaudeCodeUserPromptSubmit uses.
export function mapCodexUserPromptSubmit() {
  return { kind: "turn_start" };
}

export function mapCodexPostToolUse(payload) {
  // Issue: sidebar worktree detection — Bash tool calls may contain
  // `git worktree add` or a plain `git checkout`/`git switch`, either
  // mapped to `git_branch`. Also forward the common `cwd` field from the
  // hook inputs.
  if (payload?.tool_name === "Bash") {
    const branchMsg = detectWorktreeAdd(payload, payload?.cwd) ?? detectGitCheckout(payload);
    const result = [];
    // cwd_changed goes FIRST, branch SECOND: `payload.cwd` here is the
    // directory the command started in (before any worktree it just
    // created), while a `git_branch` message carrying `worktree` also sets
    // `_liveCwd` itself (see pty-manager.ts's "git_branch" case). Pushing
    // the stale cwd after the branch message would let it silently
    // overwrite the correct worktree path this same event just reported.
    if (typeof payload.cwd === "string" && payload.cwd.length > 0) {
      result.push({ kind: "cwd_changed", cwd: payload.cwd });
    }
    if (branchMsg) result.push(branchMsg);
    return result;
  }
  if (payload?.tool_name !== "apply_patch") {
    return [];
  }
  const command = payload?.tool_input?.command;
  if (typeof command !== "string" || command.length === 0) {
    return [];
  }
  const messages = [];
  for (const match of command.matchAll(APPLY_PATCH_HEADER_RE)) {
    const [, verb, rawPath] = match;
    const path = rawPath.trim();
    if (path.length === 0) continue;
    messages.push({ kind: "file_change", path, action: APPLY_PATCH_ACTION_BY_VERB[verb] });
  }
  return messages;
}

export function mapCodexEvent(kind, payload) {
  switch (kind) {
    case "Stop":
      return mapCodexStop();
    case "SessionStart":
      return mapCodexSessionStart(payload);
    case "SessionEnd":
      return mapCodexSessionEnd(payload);
    case "PermissionRequest":
      return mapCodexPermissionRequest(payload);
    case "UserPromptSubmit":
      return mapCodexUserPromptSubmit();
    case "PostToolUse":
      return mapCodexPostToolUse(payload);
    default:
      return null;
  }
}

export function mapAgyPreToolUse(payload) {
  const toolCall = payload?.toolCall;
  if (toolCall?.name !== "run_command") return null;
  const commandLine = toolCall?.args?.CommandLine;
  const cwd = toolCall?.args?.Cwd;

  const result = [];
  // cwd_changed goes FIRST, branch SECOND — same reasoning as
  // mapCodexPostToolUse above: `Cwd` here is the directory the command
  // started in, and a `git_branch` message carrying `worktree` also sets
  // `_liveCwd` itself, so pushing the stale pre-command cwd after it would
  // silently overwrite the correct worktree path.
  if (typeof cwd === "string" && cwd.length > 0) {
    result.push({ kind: "cwd_changed", cwd });
  }
  if (typeof commandLine === "string" && commandLine.length > 0) {
    // Chained commands (`git fetch ... && git worktree add ...`) are tried
    // segment by segment — see splitShellSegments — with the LAST matching
    // segment winning, same as detectWorktreeAdd/detectGitCheckout.
    let branchMsg = null;
    let seenCd = false;
    for (const segment of splitShellSegments(commandLine)) {
      if (isCdSegment(segment)) {
        seenCd = true;
        continue;
      }
      const worktreeParsed = parseWorktreeAddCommand(segment);
      if (worktreeParsed) {
        const worktree = resolveWorktreePath(segment, worktreeParsed.worktree, cwd, seenCd);
        branchMsg = {
          kind: "git_branch",
          branch: worktreeParsed.branch,
          worktree,
        };
        continue;
      }
      // Issue: sidebar worktree detection — same plain `git checkout`/
      // `git switch` detection Claude Code and Codex get, for agy's
      // run_command tool. Sessions sharing one working directory (no
      // worktree) only change branch this way.
      const checkoutParsed = parseGitCheckoutCommand(segment);
      if (checkoutParsed) {
        branchMsg = { kind: "git_branch", branch: checkoutParsed.branch };
      }
    }
    if (branchMsg) result.push(branchMsg);
  }
  return result.length > 0 ? result : null;
}

export function mapAgySessionStart(payload) {
  const source = typeof payload?.source === "string" ? payload.source : undefined;
  return source ? { kind: "session_start", source } : { kind: "session_start" };
}

// No mapAgySessionEnd (issue #461, removed) — a registered SessionEnd hook
// never actually fires, verified empirically (see docs/agent-hooks.md's agy
// section for the full narrative). See agy.ts's mergeAgyHooks for the
// corresponding registration removal.

export function mapAgyEvent(kind, payload) {
  switch (kind) {
    case "Stop": {
      const messages = [{ kind: "progress", phase: "done" }];
      const reason =
        typeof payload?.terminationReason === "string" ? payload.terminationReason : null;
      if (reason === "error") {
        messages.push({
          kind: "stop_failure",
          error: typeof payload?.error === "string" ? payload.error : "",
          terminationReason: reason,
          fullyIdle: payload?.fullyIdle === true,
        });
      }
      return messages;
    }
    case "PreToolUse": {
      const agyMessages = mapAgyPreToolUse(payload);
      // If git branch/cwd messages exist, append a review_gate for the
      // blocking gate flow. If no git/cwd messages, return just the gate.
      const tc = payload?.toolCall;
      const commandLine =
        tc?.name === "run_command" && typeof tc?.args?.CommandLine === "string"
          ? tc.args.CommandLine
          : null;
      if (!commandLine) return agyMessages;
      const gateMsg = {
        kind: "review_gate",
        state: "waiting",
        prompt: `run_command: ${
          commandLine.length > 200 ? `${commandLine.slice(0, 200)}…` : commandLine
        }`,
      };
      if (Array.isArray(agyMessages)) {
        agyMessages.push(gateMsg);
        return agyMessages;
      }
      return [gateMsg];
    }
    case "PostToolUse": {
      const tc = payload?.toolCall;
      if (!tc || typeof tc.name !== "string") return null;
      if (
        tc.name !== "write_to_file" &&
        tc.name !== "replace_file_content" &&
        tc.name !== "multi_replace_file_content"
      )
        return null;
      const args = tc.args || {};
      const filePath =
        typeof args.TargetFile === "string"
          ? args.TargetFile
          : typeof args.FilePath === "string"
            ? args.FilePath
            : null;
      if (!filePath) return null;
      return { kind: "file_change", path: filePath, action: "modify" };
    }
    case "SessionStart":
      return mapAgySessionStart(payload);
    default:
      return null;
  }
}

export function buildForwarderMessage(agent, kind, payload) {
  switch (agent) {
    case "claude-code":
      return mapClaudeCodeEvent(kind, payload ?? {});
    case "codex":
      return mapCodexEvent(kind, payload ?? {});
    case "agy":
      return mapAgyEvent(kind, payload ?? {});
    default:
      return null;
  }
}

export function formatAgyGateDecision(decision, reason) {
  return {
    decision: decision === "approved" ? "allow" : "deny",
    ...(reason ? { reason } : {}),
  };
}

export function formatClaudeCodeGateDecision(decision, reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision === "approved" ? "allow" : "deny",
      permissionDecisionReason:
        reason ?? (decision === "approved" ? "Approved via Mullion" : "Denied via Mullion"),
    },
  };
}

export function formatGateDecision(agent, decision, reason) {
  switch (agent) {
    case "claude-code":
      return formatClaudeCodeGateDecision(decision, reason);
    case "agy":
      return formatAgyGateDecision(decision, reason);
    default:
      console.error(
        `forwarder: no gate dialect registered for agent "${agent}" — this should be unreachable`,
      );
      return { decision: decision === "approved" ? "approved" : "denied" };
  }
}

export function formatClaudeCodeSessionStartOutput(additionalContext) {
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext,
    },
  };
}

export function formatAgySessionStartOutput(additionalContext) {
  // agy's hook I/O uses a protobuf-JSON schema, NOT Claude Code/Codex's
  // hookSpecificOutput shape — extracted from the descriptor embedded in
  // the installed `agy` binary (`third_party/jetski/hooks_pb/hooks.proto`,
  // package `exa.hooks_pb`, agy 1.1.8): `SessionStartHookResult` has a
  // single field, `inject_steps` (json name `injectSteps`), an array of
  // `HookInjectedStep` — a oneof including `ephemeralMessage` (a plain
  // string, documented elsewhere as "transient system message"). This
  // reuses that same shape `PreInvocationHookResult` uses (see the
  // PreInvocation fallback note below), since both fields are literally
  // the same `inject_steps` proto field.
  return { injectSteps: [{ ephemeralMessage: additionalContext }] };
}

// Issue #437 (split into 437a/437b/437c, one PR per agent) — this is the
// dialect-dispatch seam #264 (review-gate PreToolUse dialects) also extends;
// see formatGateDecision above for the sibling switch. Keep new agent cases
// here, not a parallel switch elsewhere.
export function formatSessionStartOutput(agent, additionalContext) {
  switch (agent) {
    case "claude-code":
      return formatClaudeCodeSessionStartOutput(additionalContext);
    case "codex":
      // Verified against the installed Codex CLI's own embedded hook I/O
      // schema (codex-cli 0.145.0): SessionStart's
      // "hookSpecificOutput.additionalContext" shape is byte-identical to
      // Claude Code's, and the schema enforces `additionalProperties: false`
      // at both levels — a schema drift on a future codex-cli upgrade would
      // make Codex reject this reply silently (no error surfaced back to
      // Mullion), so re-verify this shape against the embedded schema when
      // bumping the Codex CLI this host targets, same as the version facts
      // already tracked in hook-adapters/codex.ts. Delivery also depends on
      // the user's one-time interactive `/hooks` trust grant for this
      // Mullion-owned hook group (see hook-adapters/codex-trust.ts) —
      // untrusted, Codex silently skips the hook entirely, so this never
      // throws or blocks on that either.
      return formatClaudeCodeSessionStartOutput(additionalContext);
    case "agy":
      // UNVERIFIED against a live SessionStart firing (issue #437b) — same
      // "no CI or local run here could safely trigger a real hook firing
      // without a live, paid model turn" constraint already documented for
      // Codex's apply_patch extractor in docs/agent-hooks.md. Two facts
      // pull in opposite directions: agy's OWN bundled hooks.md
      // (`~/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/
      // hooks.md`, shipped with agy 1.1.8 — its "Supported Event Types"
      // table) omits SessionStart entirely — the string "SessionStart"
      // does not appear anywhere in that file. But the recognized hook-name
      // set embedded in the installed `agy` binary itself (alongside
      // PreToolUse/PostToolUse/PreInvocation/PostInvocation/Stop) includes
      // it, hook-adapters/agy.ts already registers it unconditionally, and
      // the binary carries real call-site symbols for it —
      // `hookcaller.CallSessionStartHook` and
      // `prehooks.NewSessionStartProviderHook` — not just a recognized
      // name with no wiring behind it.
      //
      // "Unverified" here is narrower than "might never fire": that hook
      // registration is unconditional and hooks.ts's session_start reply
      // (buildAgentGuidePointer) is non-empty by default on any ordinary
      // session, so on Mullion's side this dispatches on every agy
      // SessionStart, not just hypothetically. The actual open question is
      // whether agy's OWN decoder (`hookcaller.maybeParseProtoBytes`,
      // proto-based, not a plain JSON struct) accepts this exact shape —
      // shipping optimistically because a decode mismatch's worst case is
      // the same silent no-op as every other agent's `default` case below,
      // not a crash (proto3 JSON parsers conventionally ignore
      // unrecognized/mismatched fields rather than erroring). If it turns
      // out the shape doesn't decode, the fallback is the documented
      // `PreInvocation` event (same `inject_steps` field) — that fires
      // before every model invocation rather than once per session, so it
      // needs a server-side once-per-session latch (see
      // src/plugins/hooks.ts's consumeSeed for the existing single-use
      // pattern to copy) before it could be used here.
      return formatAgySessionStartOutput(additionalContext);
    default:
      return {};
  }
}

export function parseHookStdin(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed;
}

// Issue #462 — a message array can carry a piggybacked sibling (most
// commonly cwd_changed — see mapClaudeCodeEvent above) alongside a blocking
// message (review_gate/session_start) that forwarder.mjs's forward() reads a
// reply for. A sibling sent ahead of the blocking message must never itself
// elicit a reply from hooks.ts, or that reply would be misread as the
// blocking message's own decision/additionalContext (both runGate/
// runSessionStart settle on the FIRST reply line and destroy the socket).
// These are every kind hooks.ts replies to immediately (review_gate/
// session_start/promote_request/browser_action) — necessary, but NOT
// sufficient on its own: a "safe" kind (cwd_changed/git_branch) that fails
// hook-protocol.ts's own validation also elicits an {error} reply from
// hooks.ts, which this Set can't catch by kind alone (independent review,
// PR #466 — see parseWorktreeAddCommand/parseGitCheckoutCommand above for
// the actual mapper-side fix: never construct a git_branch message with an
// empty branch in the first place, which is the concrete way this was
// reachable).
export const REPLY_ELICITING_KINDS = new Set([
  "review_gate",
  "session_start",
  "promote_request",
  "browser_action",
]);

/** Splits `messages` into the siblings that should be sent ahead of
 * `blockingMessage`, filtering out `blockingMessage` itself and any
 * REPLY_ELICITING_KINDS message that shouldn't have been in the array
 * alongside a blocking one (see that Set's own comment for why this is a
 * defensive backstop, not the primary guarantee). Logs to stderr — never
 * stdout, which forwarder.mjs's main() reserves for this hook's own JSON
 * decision — when it actually drops something, so a future mapper
 * regression that produces one of these kinds as a sibling doesn't vanish
 * without a trace. Lives here (not forwarder.mjs) so its drop+log branch
 * can be unit-tested directly with a synthetic payload, since no real
 * mapper produces a reply-eliciting sibling today (Hermes review, PR #466). */
export function siblingsFor(messages, blockingMessage) {
  const dropped = [];
  const siblings = messages.filter((m) => {
    if (m === blockingMessage) return false;
    if (REPLY_ELICITING_KINDS.has(m.kind)) {
      dropped.push(m.kind);
      return false;
    }
    return true;
  });
  if (dropped.length > 0) {
    console.error(
      `forwarder: dropped ${dropped.length} reply-eliciting sibling message(s) (${dropped.join(", ")}) alongside a blocking ${blockingMessage.kind} message`,
    );
  }
  return siblings;
}
