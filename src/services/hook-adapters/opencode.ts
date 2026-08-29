import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { resolveOpenCodePluginPath, shellQuote } from "./shared.js";
import { sessionAgentGuidePath } from "../agent-guide.js";
import { sessionBriefingPath } from "../project-briefing.js";
import {
  resolveMullionBundleDir,
  deriveContentName,
  deriveOpenCodeReviewerAgentFile,
} from "./mullion-bundle.js";
import type { HookAdapterContext, HookAgentAdapter, HookLaunchPlan } from "./types.js";

// OpenCode adapter (issue #175). Unlike Claude Code/Codex/agy, OpenCode has
// no shell-command hooks at all — only a JS/TS plugin API (auto-discovered
// from a `plugins/` subdirectory it scans, not referenced by argv or by the
// config file's own `plugin` array, which is npm-package names only). This
// adapter has no `commandTransform`: it writes the shared plugin file
// (src/hooks/opencode-plugin.js) into a per-session, ENTIRELY EPHEMERAL
// scratch directory and points `OPENCODE_CONFIG_DIR` at it, purely via env
// vars, never by rewriting the command line. `initialPromptArgs` below is a
// separate, narrower mechanism (an argv suffix appended by launch-plan.ts
// after everything else, see that field's own doc comment in types.ts) —
// not a contradiction of "no commandTransform," just a second, opt-in argv
// channel this adapter also happens to support.
//
// Verified against the installed OpenCode CLI + its own `@opencode-ai/*`
// package type definitions during this PR (the plan flagged this as an
// open question to confirm empirically): `OPENCODE_CONFIG_DIR` relocates
// OpenCode's own `.opencode`-shaped search (agents/commands/modes/plugins)
// to an arbitrary directory, loaded ADDITIVELY alongside the user's real
// global/project config — not in place of it. That makes this adapter fully
// ephemeral, same posture as Claude Code's `--settings` file: no write to
// `~/.config/opencode` or a project's `.opencode/` at all, and nothing to
// clean up afterward (the scratch directory lives under the sessions dir,
// same lifecycle as everything else there).
//
// Issue #437c — the agent-guide SessionStart nudge (#405/#437a/#437b) also
// rides an env var, `OPENCODE_CONFIG_CONTENT` (same additive-merge posture,
// verified against the installed CLI this PR via `opencode debug config`),
// pointing OpenCode's `instructions` config at the session's own on-disk
// guide file — see prepareLaunch's own doc comment for the full reasoning
// and how this differs in kind (whole-file injection, no per-event seed)
// from the other three agents' short SessionStart pointer sentence.
//
// Only non-blocking events are forwarded by the plugin — see
// opencode-plugin.js's own header comment for why its real gating hook,
// `permission.ask`, is deliberately not wired up yet (issue #178, same
// reasoning as Claude Code's deferred PreToolUse). Stale as of an earlier
// revision of this comment: the plugin now forwards eight event types
// (session.idle, file.edited, permission.updated, permission.replied,
// session.error, tui.toast.show, session.status, vcs.branch.updated), not
// just the original two — see OPENCODE_EMITS below and
// opencode-plugin.js's mapOpenCodeEvent for the authoritative, tested
// mapping.

const OPENCODE_COMMAND_RE = /^(?:\S*\/)?opencode(?:\s|$)/;

// Issue: extend surfaced session statuses — the hook-protocol `kind`s
// opencode-plugin.js's mapOpenCodeEvent can ever produce from the plugin
// event-bus types it currently handles, plus `promote_request` from the
// plugin's own `promote_to_worktree` tool (opencode-plugin.js:308-352,
// analogous to Claude Code's MCP-tool-sourced promote_request — see
// CLAUDE_CODE_EMITS's doc comment in claude-code.ts for the same caveat: no
// mechanical mapper to parity-test this one against). Unlike the other three
// adapters, this list is verified against opencode-plugin.js's own test
// suite (opencode-plugin.test.ts) rather than forwarder-core.test.ts — see
// that file's own parity test asserting mapOpenCodeEvent's output stays
// inside this set. Compaction and subagent events (see "compact" and
// "subagent" entries below), wired in #321 from OpenCode's upstream
// experimental.session.compacting and session.subagent hooks.
export const OPENCODE_EMITS = [
  "progress",
  "file_change",
  "turn_start",
  "permission_request",
  // Fix: status-clearing-semantics — was "notification_resolved", which
  // `permission.replied` used to (incorrectly) map to; see
  // opencode-plugin.js's own comment on that event.
  "permission_resolved",
  "tool_failure",
  "notification",
  "git_branch",
  "cwd_changed",
  "promote_request",
  // Issue #271 follow-up — the live opencode session id, reported on every
  // session.idle (see opencode-plugin.js's mapOpenCodeEvent) so a later
  // promote can carry full conversation history, not just a seed summary.
  "agent_session",
  // Issue #321 — wire compaction events from opencode's session.compacting
  "compact",
  // Issue #321 — wire subagent events from opencode's session.subagent
  "subagent",
  // Wire opencode v2 question events from question.asked/replied/rejected
  "question",
  // Wire opencode v2 todo events from todo.updated
  "todo",
  // Wire opencode v2 session diff events from session.diff
  "session_diff",
] as const;

function prepareLaunch(ctx: HookAdapterContext): HookLaunchPlan {
  const configDir = path.join(ctx.sessionsDir, `${ctx.sessionId}.opencode-config`);
  const pluginPath = path.join(configDir, "plugins", "mullion-hook-emitter.js");
  const pluginSource = readFileSync(resolveOpenCodePluginPath(), "utf8");
  const envAdditions: Record<string, string> = { OPENCODE_CONFIG_DIR: configDir };
  const settingsFiles: Array<{ path: string; contents: string }> = [
    { path: pluginPath, contents: pluginSource },
  ];
  // Issue #678 — the two `instructions` sources below (agent-guide,
  // promote-flow seed) are independently gated and simply concatenate into
  // one array; see each source's own comment for why.
  const instructions: string[] = [];

  // Issue #437c — the agent-guide SessionStart nudge (#405/#437a/#437b), for
  // OpenCode. Unlike every other agent, OpenCode has no live hook round trip
  // to reply to (see this file's header) — hooks.ts's session_start branch
  // (a per-hook-fire dynamic composition of an optional promote-flow seed +
  // a short guide pointer) simply doesn't apply here. The nearest equivalent
  // OpenCode's config system offers is `instructions`, a list of file paths
  // whose CONTENTS get loaded into context at startup — so this points it at
  // the session's own on-disk guide file directly (writeSessionAgentGuide,
  // called unconditionally right after this in bootstrapMaster, so the file
  // exists by the time OpenCode's process actually starts). That is a
  // materially different mechanism from the other three agents' short
  // pointer sentence: OpenCode gets the guide's FULL content injected as
  // context, not a pointer telling it where to go read it — and there is no
  // way to compose in a promote-flow seed here, since `instructions` is
  // static config resolved once at startup, not a live per-event reply.
  //
  // `OPENCODE_CONFIG_CONTENT` is a runtime override near the top of
  // OpenCode's own documented config-precedence chain, and — verified
  // empirically this PR (`opencode debug config`, no live session/model
  // call needed) — its `instructions` array CONCATENATES with the user's
  // own project/global `instructions` rather than replacing them, including
  // when combined with `OPENCODE_CONFIG_DIR` above. Also verified the merge
  // is genuinely per-key, not a whole-layer shadow: a project config with
  // unrelated top-level keys (`model`, `small_model`) still has both intact
  // in the resolved config with `OPENCODE_CONFIG_CONTENT` only setting
  // `instructions` — so this never drops anything the user configured
  // themselves, in `instructions` or elsewhere.
  //
  // Gated on ctx.injectAgentGuide (see that field's own doc comment for why
  // this is necessarily a spawn-time snapshot of the setting, not a live
  // read) — mirrors hooks.ts's own setting gate for every other agent's
  // pointer, even though the underlying guide FILE is still always written
  // regardless (agent-guide.ts's own invariant: gate the pointer, never
  // the on-disk write).
  //
  // Checks existsSync on the actual PER-SESSION COPY here, not
  // agentGuideSourceExists() (the shipped source doc) the way every other
  // consumer of this setting does — deliberately stricter than that
  // precedent, because the failure mode is worse for opencode specifically.
  // For Claude Code/Codex/agy, a dangling pointer (source existed when
  // checked, but writeSessionAgentGuide's own copy write then failed —
  // logged-and-swallowed, e.g. full disk or EACCES on sessionsDir) is just
  // a sentence an LLM reads and ignores. For opencode, `instructions`
  // becomes a config reference its own CLI resolves at startup — checking
  // the copy that will ACTUALLY be referenced, not merely the source it
  // was copied from, is what this call site can control. Safe to check
  // here regardless of call order elsewhere: bootstrapMaster() (pty-
  // manager.ts) writes the guide file before calling applyHookAdapters
  // specifically so this check sees the real, current state, not a stale
  // one from a previous session reusing this path.
  if (ctx.injectAgentGuide) {
    const guidePath = sessionAgentGuidePath(ctx.sessionsDir, ctx.sessionId);
    if (existsSync(guidePath)) {
      instructions.push(guidePath);
    }
  }

  // Same existsSync-on-the-per-session-copy posture as the guide block
  // immediately above, for the identical reason (a dangling `instructions`
  // entry is a real failure for opencode's own config resolution, not just
  // ignorable prose) — but gated on `ctx.injectProjectBriefing`, the
  // independent setting a project's own briefing uses (see that field's own
  // doc comment). writeSessionBriefing runs before applyHookAdapters for
  // the same ordering reason writeSessionAgentGuide does (launch-plan.ts),
  // and — unlike the guide — unlinks any stale copy when nothing resolves,
  // so this existsSync check never sees a briefing from a previous session
  // that reused this id.
  if (ctx.injectProjectBriefing) {
    const briefingPath = sessionBriefingPath(ctx.sessionsDir, ctx.sessionId);
    if (existsSync(briefingPath)) {
      instructions.push(briefingPath);
    }
  }

  // Issue #678, superseded in practice by the `initialPromptArgs` below for
  // the promote flow specifically (see that field's own comment) — kept as
  // a context-only fallback for any OTHER caller that sets `seedPrompt`
  // without also requesting `initialPrompt` (routes/sessions.ts's promote
  // handler now prefers `initialPrompt` for any adapter with argv support,
  // opencode included, and passes `seedPrompt` only when the target adapter
  // has none). A user-supplied "resume here" note (POST
  // /api/sessions/:id/promote's `seedPrompt` body field), for opencode
  // specifically. Every other agent gets this delivered live, via hooks.ts's
  // "session_start" branch replying to that agent's own SessionStart hook
  // with `additionalContext` (app.pty.consumeSeed) — opencode has no such
  // round trip (see this file's header), so it needs the same spawn-time
  // `instructions` channel the agent-guide pointer above uses. Deliberately
  // gated on `ctx.seedPrompt` alone, NOT on `ctx.injectAgentGuide`: a user
  // explicitly asked for this seed when they submitted the promote dialog,
  // and it must not silently vanish just because someone disabled the
  // unrelated agent-guide setting. Written via `settingsFiles`, the same
  // mechanism the plugin file above already uses — so it exists on disk
  // before opencode's process actually starts, same ordering guarantee
  // agent-guide.ts's own writeSessionAgentGuide has for the guide file
  // (bootstrapMaster calls that before applyHookAdapters).
  if (ctx.seedPrompt && ctx.seedPrompt.length > 0) {
    const seedPath = path.join(ctx.sessionsDir, `${ctx.sessionId}.opencode-seed.md`);
    settingsFiles.push({ path: seedPath, contents: ctx.seedPrompt });
    instructions.push(seedPath);
  }

  // Issue: Mullion's own agent-facing tooling bundle (src/bundle/ — see
  // mullion-bundle.ts and claude-code.ts's --plugin-dir wiring for the
  // Claude Code half of this). opencode has no --plugin-dir equivalent,
  // but its config schema has an explicit `skills.paths: string[]` key —
  // verified empirically this session (`opencode debug config`, then a
  // real `opencode run` against a probe skill) that setting it via
  // OPENCODE_CONFIG_CONTENT, the same channel `instructions` above already
  // uses, makes opencode load and invoke a skill from an arbitrary
  // absolute path with no copy required — the superpowers plugin's own
  // skills path in that same debug output lives nowhere under
  // OPENCODE_CONFIG_DIR either, so this isn't a special case. Points
  // directly at the shipped bundle's skills/ dir; nothing is written to
  // opencode's own real config (unlike codex/agy's managedInstall — see
  // mullion-bundle.ts's installBundleSkills doc comment for why those two
  // need a real, host-level write instead). Gated on ctx.injectMullionBundle
  // alone, same spawn-time-snapshot posture as injectAgentGuide/
  // injectProjectBriefing above.
  const skillsPaths: string[] = [];
  if (ctx.injectMullionBundle) {
    const bundleDir = resolveMullionBundleDir();
    if (bundleDir) skillsPaths.push(path.join(bundleDir, "skills"));
  }

  // PR-5 — a project's own skill (project_tooling.skill, schema.ts) rides
  // the same verified `skills.paths` channel as the universal bundle
  // immediately above: written into its own subdirectory of this session's
  // already-ephemeral configDir (never the shipped bundle's own tree,
  // which this checkout doesn't own writing into) and that subdirectory
  // added to `skills.paths` alongside the shipped bundle's. Unlike Claude
  // Code's single composed --plugin-dir (claude-code.ts), opencode's
  // `skills.paths` is already a list, so this is a second entry, not a
  // merge. Content whose frontmatter `name` can't be safely derived
  // (deriveContentName's own doc comment) is silently skipped — same
  // posture as claude-code.ts's composeClaudeSessionBundle, and the route
  // (routes/project-tooling.ts) already rejects that at write time.
  if (ctx.injectMullionBundle && ctx.projectSkill) {
    const name = deriveContentName(ctx.projectSkill);
    if (name) {
      const projectSkillsDir = path.join(configDir, "mullion-project-skills");
      settingsFiles.push({
        path: path.join(projectSkillsDir, name, "SKILL.md"),
        contents: ctx.projectSkill,
      });
      skillsPaths.push(projectSkillsDir);
    }
  }

  // PR-5 — a project's own reviewer subagent (project_tooling.reviewerAgent)
  // rides opencode's `<OPENCODE_CONFIG_DIR>/agent/<name>.md` convention
  // (verified empirically this session, see
  // deriveOpenCodeReviewerAgentFile's own doc comment for the full spike —
  // including why it CANNOT be the raw Claude-Code-shaped content
  // ctx.projectReviewerAgent actually holds). No `skills.paths`-style env
  // entry needed beyond the file write itself: opencode auto-discovers
  // `agent/*.md` under OPENCODE_CONFIG_DIR, which envAdditions below
  // already points at this session's configDir.
  if (ctx.injectMullionBundle && ctx.projectReviewerAgent) {
    const agentFile = deriveOpenCodeReviewerAgentFile(ctx.projectReviewerAgent);
    if (agentFile) {
      settingsFiles.push({
        path: path.join(configDir, "agent", `${agentFile.name}.md`),
        contents: agentFile.contents,
      });
    }
  }

  if (instructions.length > 0 || skillsPaths.length > 0) {
    const configContent: Record<string, unknown> = {};
    if (instructions.length > 0) configContent.instructions = instructions;
    if (skillsPaths.length > 0) configContent.skills = { paths: skillsPaths };
    envAdditions.OPENCODE_CONFIG_CONTENT = JSON.stringify(configContent);
  }

  return {
    settingsFiles,
    envAdditions,
  };
}

export const openCodeAdapter: HookAgentAdapter = {
  name: "opencode",
  // No commandTransform here, so — unlike Claude Code — there's no risk of
  // misattaching a rewritten argv to the wrong part of a chained command;
  // OPENCODE_CONFIG_DIR is just an env var, harmless to set even for a
  // shell that runs other programs before/after `opencode`. A plain
  // anchored program-token match is enough.
  matches: (command) => OPENCODE_COMMAND_RE.test(command.trim()),
  prepareLaunch,
  emits: OPENCODE_EMITS,
  // Verified empirically against the installed OpenCode CLI (`opencode
  // --help`, and a live headless run checked against its own session DB):
  // `--prompt <text>` is a top-level option on the DEFAULT `opencode
  // [project]` command (the TUI, which is what Mullion always spawns — see
  // this file's header, there's no `run`/`exec` subcommand involved), and
  // it genuinely SUBMITS that text as the session's first turn rather than
  // merely pre-filling the input box: a real user/assistant message pair
  // landed in opencode's own SQLite session store, not just an unsent
  // draft. `--prompt`, not the bare positional the other three adapters'
  // `initialPromptArgs` use (`-- <prompt>`) — opencode's positional
  // argument is `[project]`, a directory path, so an unflagged prompt would
  // be silently misread as one.
  initialPromptArgs: (prompt) => `--prompt ${shellQuote(prompt)}`,
  // Issue #271 follow-up — verified empirically TWICE against the real
  // opencode 1.18.18 binary in an isolated scratch repo + worktree (no live
  // session touched), because the first pass tested the wrong command form:
  //
  // 1. `opencode run --session <id> "…"` — the `run` subcommand, headless,
  //    one-shot. Passed: recalled a fact planted only in the transferred
  //    history, and a bash tool it ran had `cwd` = the worktree.
  // 2. The bare `opencode [project] --session <id>` form — the actual TUI
  //    Mullion spawns (this file's own header: no `run`/`exec` subcommand
  //    involved). `run` and the bare TUI are separate code paths; passing
  //    on (1) does NOT establish (2). Re-verified directly: launched the
  //    bare command inside a real pty (matching how `dtach` attaches it),
  //    typed a message into the loaded session as a real user would, and
  //    confirmed via the session's own SQLite rows that the resulting bash
  //    tool call had `cwd` = the worktree, not the source repo. Bare
  //    `--session <id>` (no `--fork`, no `--continue`) is safe on both
  //    command forms.
  //
  // This is the mechanism `--fork` was rejected for (see
  // opencode-session-transfer.ts's own header comment): `--fork` pins the
  // forked session's directory to the ORIGINAL session's stored directory
  // even with `--dir` pointing elsewhere, silently redirecting tool calls
  // back into the live main checkout. Bare `--session` on a session already
  // re-keyed to the new directory (opencode-session-transfer.ts's import
  // step) has no such pinning — this only works because the transfer step
  // rewrites `directory` in the session's own DB row before this ever runs.
  //
  // IMPORTANT, and the actual reason two verification passes were needed:
  // on the bare TUI form, `--prompt` auto-submits as a real turn ONLY when
  // it creates a brand-new session (see `initialPromptArgs` above). Paired
  // with `--session <id>` — or `--continue`, confirmed to behave
  // identically — the flag is accepted but silently NEVER submitted: left
  // running well past normal response latency, the session's message rows
  // never gained a new turn. Do not combine `resumeSessionArgs` with
  // `initialPromptArgs`/a synthesized nudge in the same launch — the
  // caller (`routes/sessions.ts`'s promote handler) deliberately sends
  // `--session` alone and surfaces a `warnings[]` note instead, precisely
  // because that combination silently drops the prompt.
  resumeSessionArgs: (agentSessionId) => `--session ${shellQuote(agentSessionId)}`,
};
