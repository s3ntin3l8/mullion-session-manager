import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { resolveOpenCodePluginPath, resolveMcpServerPath, shellQuote } from "./shared.js";
import {
  agentGuideSourceExists,
  buildAgentGuideBlock,
  sessionAgentGuidePath,
} from "../agent-guide.js";
import { sessionBriefingPath } from "../project-briefing.js";
import {
  resolveMullionBundleDir,
  deriveContentName,
  deriveOpenCodeReviewerAgentFile,
} from "./mullion-bundle.js";
import { isBundleSyncedFor } from "../bundle-sync.js";
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
// Issue #437c, redesigned by #949 — the agent-guide tier-0 push also rides
// an env var, `OPENCODE_CONFIG_CONTENT` (same additive-merge posture,
// verified against the installed CLI this PR via `opencode debug config`),
// pointing OpenCode's `instructions` config at a small dedicated tier-0
// file this adapter writes itself — see prepareLaunch's own doc comment for
// the full reasoning and why it's no longer the whole guide doc's content.
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

// Issue #881 — exposes Mullion's own MCP server (src/mcp/server.mjs) to
// OpenCode, mirroring claude-code.ts's buildClaudeMcpConfig (the same three
// env vars, the same "session-scoped hook token only, never
// MULLION_AUTH_TOKEN" reasoning — see that function's own comment for the
// full explanation, which applies verbatim here: this config rides
// OPENCODE_CONFIG_CONTENT, an env var readable by the very agent it's
// spawned for). Kept as its own exported builder, not inlined into
// prepareLaunch, for the same "provably the same bytes across call sites"
// reason buildClaudeMcpConfig is its own function.
//
// The shape is OpenCode's own, verified empirically this PR — first via
// `OPENCODE_CONFIG_CONTENT` + `opencode debug config` for the resolved
// shape (never against the user's real `~/.config/opencode/opencode.json`
// — see the plan doc's S11/S12 spike notes), THEN via `opencode mcp list`
// against a real stdio probe server, which reported `mullion  connected`
// — confirming the entry is actually spawned and initialized, not merely
// resolved into config (the same two-step bar `skills.paths`'s own comment
// above sets: config resolution alone doesn't prove a live session can
// reach it). `mcp.<name>` is `{ type: "local", command: [...],
// environment: {...}, enabled: true }`. Two things differ
// from Claude Code's `mcpServers.<name>` shape and are NOT typos:
// `command` is a single array INCLUDING the executable (Claude Code splits
// `command`/`args`), and the env key is `environment`, not `env`.
export function buildOpenCodeMcpConfig(
  mcpServerPath: string,
  hookSocketPath: string,
  hookToken: string,
  controlSocketPath: string,
  execPath: string = process.execPath,
) {
  return {
    mullion: {
      type: "local",
      command: [execPath, mcpServerPath],
      environment: {
        MULLION_HOOK_SOCKET: hookSocketPath,
        MULLION_HOOK_TOKEN: hookToken,
        // Same posture as buildClaudeMcpConfig's identical field — this
        // config is an env var readable by the agent it's spawned for, so
        // only the session-scoped hook token goes in, never
        // MULLION_AUTH_TOKEN. That token also authenticates the control
        // socket at session scope, so the full-scope-only ops the MCP
        // tools call correctly 403 rather than silently escalating.
        MULLION_SOCKET_PATH: controlSocketPath,
      },
      enabled: true,
    },
  };
}

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

  // Issue #437c, redesigned by #949 — the agent-guide tier-0 push, for
  // OpenCode. Unlike every other agent, OpenCode has no live hook round trip
  // to reply to (see this file's header) — hooks.ts's session_start branch
  // (a per-hook-fire dynamic composition of an optional promote-flow seed +
  // the tier-0 block) simply doesn't apply here. The nearest equivalent
  // OpenCode's config system offers is `instructions`, a list of file paths
  // whose CONTENTS get loaded into context at startup.
  //
  // Through issue #949, this pointed `instructions` at the FULL per-session
  // guide file (writeSessionAgentGuide's own copy of docs/agent-guide.md) —
  // materially different in kind from the other three agents' short pointer
  // sentence, injecting the whole doc as context rather than telling the
  // agent where to go read it. #940 made that gap moot: OpenCode now also
  // gets the SAME `host`/`browser`/`troubleshooting`/`session-ops` skills
  // pulled via `skills.paths` below (mirroring the plugin-dir bundle Claude
  // Code gets), so injecting the full doc a second time here would just be
  // duplicate content. What #940's pull-based skills can't carry — the
  // reason a push channel still exists here at all, same as hooks.ts's own
  // tier-0 reasoning — is host-dependent LIVE state (`ctx.authEnabled`) and
  // the plain fact the guide file and skills exist to go read. So this now
  // builds the SAME small tier-0 block hooks.ts pushes to the other three
  // agents (buildAgentGuideBlock, agent-guide.ts) and writes it to its own
  // small file rather than pointing at the full guide copy.
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
  // push. Also gated on agentGuideSourceExists(), same as hooks.ts's own
  // gate — a checkout/install that hasn't shipped docs/agent-guide.md must
  // never send an agent to a guide-file pointer that isn't there.
  //
  // Written via `settingsFiles` (like the seed file below), so — unlike the
  // pre-#949 existsSync check this replaces — the `instructions` entry can
  // never dangle: this adapter writes the tier-0 file itself, in the same
  // pass, rather than depending on a copy some OTHER write (writeSessionAgentGuide)
  // produced. The tier-0 block's own pointer sentence still names that
  // other copy's path, and CAN dangle if that separate write fails — same
  // accepted risk the other three agents' pointer sentence already has (see
  // agent-guide.ts's own doc comment), no longer a stricter bar for
  // opencode specifically.
  //
  // Confirmed live (not just by reading this adapter), same bar issue
  // #715's own verification set: with `OPENCODE_CONFIG_DIR`/
  // `OPENCODE_CONFIG_CONTENT` set exactly the way this function sets them
  // (an `instructions` entry pointing at a real tier-0 file, no plugin, no
  // tool calls available), `opencode run` against a real installed 1.18.27
  // binary answered a two-part probe — "what does your scope sentence say,
  // and what skill does it tell you to load" — correctly from injected
  // context alone, in its own words identifying the same host-scope claim
  // and the same "go load the host skill" pointer this block's content
  // carries. That proves the CONTENT reaches the model's context, the
  // actual gap this redesign closes (see this file's own header) — it does
  // NOT prove the model, given real tool access, would successfully
  // resolve a skill invocation from that pointer (this probe had no
  // `skills.paths` configured and made no tool calls at all, so the
  // model's answer was free-text paraphrase, not a verified skill lookup;
  // the pointer sentence itself never spells out a literal skill-name
  // string on purpose — see buildAgentGuideBlock's own doc comment for why
  // — so there's no exact string for a probe like this to match against
  // anyway).
  if (ctx.injectAgentGuide && agentGuideSourceExists()) {
    const guidePath = sessionAgentGuidePath(ctx.sessionsDir, ctx.sessionId);
    const tier0Path = path.join(ctx.sessionsDir, `${ctx.sessionId}.opencode-tier0.md`);
    settingsFiles.push({
      path: tier0Path,
      contents: buildAgentGuideBlock(guidePath, ctx.authEnabled ?? true),
    });
    instructions.push(tier0Path);
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
  // Issue #941 — once bundle-sync.ts's boot-time sync has globally
  // installed the shipped bundle's skills under
  // resolveOpenCodeConfigHome()/skills, opencode discovers them there
  // natively; pushing the same shipped bundle's skills/ dir onto
  // skills.paths here would be redundant. isBundleSyncedFor is a cheap
  // manifest read (not a full re-hash), safe to call on every launch.
  // Falls back to today's per-session skills.paths entry when nothing's
  // synced yet. The project-skill/project-reviewer-agent entries below are
  // a separate, always-per-session mechanism and are NOT gated on this.
  if (ctx.injectMullionBundle && !isBundleSyncedFor("opencode")) {
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

  // Issue #881 — the Mullion MCP server, always registered (mirroring
  // claude-code.ts's unconditional --mcp-config and agy.ts's unconditional
  // mergeAgyMcpConfig — neither is gated on any setting, since the tools it
  // exposes are core Mullion functionality, not an optional nudge). This is
  // the one addition that makes `configContent` unconditional: previously
  // OPENCODE_CONFIG_CONTENT was only set when instructions/skillsPaths had
  // content, but `mcp` now always does.
  const mcpConfig = buildOpenCodeMcpConfig(
    resolveMcpServerPath(),
    ctx.hookSocketPath,
    ctx.hookToken,
    ctx.controlSocketPath,
  );

  const configContent: Record<string, unknown> = { mcp: mcpConfig };
  if (instructions.length > 0) configContent.instructions = instructions;
  if (skillsPaths.length > 0) configContent.skills = { paths: skillsPaths };
  if (ctx.model) configContent.model = ctx.model;
  if (ctx.smallModel) configContent.small_model = ctx.smallModel;
  // Task Master (worker / review / retry / re-seed) — deny the superpowers
  // skills that gate on a human in the loop. Verified failing in branchdam-
  // mobile tasks #66 / #67, where the opencode worker invoked
  // `brainstorming` and asked a clarifying question the unattended session
  // could not answer, then ended its turn with no commits (the #722
  // "no commits ahead of base" gate correctly failed the task). Same
  // verified `permission.skill.<name>: "deny"` mechanism that
  // `~/.config/opencode/opencode.json`'s `permission.skill` block uses
  // (Mullion's own Skills Manager, services/skills.ts, writes that exact
  // shape). Only set when ctx.taskId is present (a Task Master spawn), so
  // a human-driven session of the same agent is unaffected.
  //
  // WHY THESE THREE:
  //   - brainstorming: presents clarifying questions to the user (the
  //     actual cause of the #66 / #67 failures).
  //   - writing-plans: writes a plan doc for a human to review, not code
  //     — irrelevant to a worker that has been told exactly what to build.
  //   - finishing-a-development-branch: presents merge / PR / cleanup
  //     options to a human, not the kind of thing a worker should do.
  // The other superpowers skills (using-superpowers,
  // verification-before-completion, test-driven-development, etc.) are
  // either useful or neutral for an unattended worker and are left alone
  // here — broad enough to be useful, narrow enough that a follow-up
  // issue (filed alongside this PR) can grow the list if a future failure
  // shows a different skill biting the same way.
  if (ctx.taskId !== undefined) {
    configContent.permission = {
      // Hermes review, PR #966 — VERIFIED EMPIRICALLY against opencode
      // v1.18.26 (issue #968 closed): `OPENCODE_CONFIG_CONTENT` deep-
      // merges per top-level key over the user's own
      // `~/.config/opencode/opencode.json` / project config, the same
      // way `instructions` (verified empirically in this file's header
      // comment) and `skills.paths` do — NOT a shallow whole-layer
      // shadow, so a user who already has `permission.bash: "ask"` /
      // `permission.edit: "allow"` rules in their own config keeps
      // them across an unattended-worker spawn.
      //
      // The verification (issue #968's spike): wrote a scratch
      // project with a non-empty user `permission` block
      // (`bash: "ask"`, `edit: "allow"`, `webfetch: "deny"`, plus a
      // nested `permission.skill` with `user-skill-1: "deny"` and
      // `user-skill-2: "ask"`), set OPENCODE_CONFIG_CONTENT to
      // `{"permission":{"skill":{"brainstorming":"deny",...}}}`,
      // inspected the merged config via `opencode debug config`:
      //
      //   - `permission.bash: "ask"`, `edit: "allow"`,
      //     `webfetch: "deny"` — all preserved
      //   - `permission.skill.user-skill-1: "deny"`,
      //     `user-skill-2: "ask"` — preserved alongside the new
      //     denies (two-level deep merge)
      //   - `permission.skill.brainstorming: "deny"` (etc.) —
      //     added
      //   - `permission.skill.writing-plans: "allow"` (when user
      //     had it set to allow) — overridden to `"deny"` because
      //     the override wins on shared keys (intentional — the
      //     whole point of this gate is to deny these skills for
      //     unattended workers)
      //
      // The `permission` key is documented as a known config key in
      // opencode's own schema (`https://opencode.ai/config.json`,
      // referenced by the customize-opencode skill's body) and the
      // resolved config shows it present alongside the rest of the
      // user's config, so the key is recognized, not silently inert.
      //
      // IF a future opencode release changes this merge posture
      // (shallow-replace instead of deep-merge, or unrecognized
      // `permission` key), the right fix is to read the user's
      // `~/.config/opencode/opencode.json` here and deep-merge our
      // deny list over their existing `permission` block the way
      // services/skills.ts's writeOpenCodeSkillEnabled already does
      // for the Skills Manager path — but no such fallback is needed
      // today.
      skill: {
        brainstorming: "deny",
        "writing-plans": "deny",
        "finishing-a-development-branch": "deny",
      },
    };
  }
  envAdditions.OPENCODE_CONFIG_CONTENT = JSON.stringify(configContent);

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
