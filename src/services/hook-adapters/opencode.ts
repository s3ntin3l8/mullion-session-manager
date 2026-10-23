import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import {
  resolveOpenCodePluginPath,
  resolveMcpServerPath,
  shellQuote,
  standardPromptFraming,
} from "./shared.js";
import {
  agentGuideSourceExists,
  buildAgentGuideBlock,
  sessionAgentGuidePath,
} from "../agent-guide.js";
import { sessionBriefingPath } from "../project-briefing.js";
import { sessionWorkflowConventionsPath } from "../workflow-conventions.js";
import {
  resolveMullionBundleDir,
  deriveContentName,
  deriveOpenCodeReviewerAgentConfig,
} from "./mullion-bundle.js";
import { isBundleSyncedFor, removeBundleContentForCli } from "../bundle-sync.js";
import type { HookAdapterContext, HookAgentAdapter, HookLaunchPlan } from "./types.js";

// OpenCode adapter (issue #175, reworked for opencode v2 — minimum 2.0.29).
// OpenCode has no shell-command hooks at all — only a JS plugin API — so this
// adapter writes the shared plugin file (src/hooks/opencode-plugin.js) into a
// per-session, ENTIRELY EPHEMERAL scratch directory and references it from
// `OPENCODE_CONFIG_CONTENT`'s `plugins` (a v2 `plugins` entry must be a
// DIRECTORY containing `server.js` — verified against 2.0.29). Everything else
// Mullion injects rides the same env var: `mcp`, `skills`, `agents`, `model`,
// and (Task Master only) `permission`.
//
// Three v2 facts shape this file, each verified against the installed 2.0.29
// binary and its source:
//
//  1. SHARED BACKGROUND SERVICE. By default the v2 TUI attaches to ONE
//     background server per user, spawned (detached, inheriting its env) by
//     whichever client started first, with `process.cwd()` set to `$HOME`.
//     Mullion's per-session env (MULLION_HOOK_SOCKET/TOKEN, the config
//     content) would then belong to the first session that happened to spawn
//     it — wrong for every other session and leaking into the user's own
//     opencode. So `commandTransform` adds `--standalone` (a private
//     `serve --stdio` server per TUI, started in the TUI's directory with its
//     env, dying with it), and every opencode subprocess Mullion itself runs
//     (opencode-models.ts, opencode-session-transfer.ts) does the same.
//
//  2. `OPENCODE_CONFIG_DIR` REPLACES the user's global config root in v2
//     (1.x loaded it additively). Setting it would silently drop the user's
//     own `opencode.json` (MCP servers, `permission.skill` rules), global
//     AGENTS.md, skills and agents inside every Mullion session — so Mullion
//     no longer sets it. The scratch directory (`opencodeConfigDir`) still
//     exists, but only holds files this adapter points `OPENCODE_CONFIG_CONTENT`
//     at. Config entries are additive across layers (verified: the user's
//     MCP servers and Mullion's both connect), so nothing the user configured
//     is displaced.
//
//  3. THE `instructions` CONFIG KEY IS INERT in 2.0.29 (parsed, never read).
//     The tier-0 guide, workflow conventions, project briefing and promote
//     seed are therefore delivered by the plugin appending them to the
//     session's system prompt via its `context` hook; this adapter writes the
//     files (same gating as before) and hands their absolute paths to the
//     plugin as a JSON array in `MULLION_OPENCODE_INSTRUCTIONS`.
//
// Only non-blocking events are forwarded by the plugin — see
// opencode-plugin.js's own header comment (the real gating hook is
// deliberately not wired up, issue #178). The kinds it can emit are listed in
// OPENCODE_EMITS below; the authoritative, tested mapping is its
// mapOpenCodeEvent.

/** The oldest opencode this adapter supports (issue #1593): v2's plugin API,
 * `--standalone`, `session export/import`. A 1.x CLI rejects the plugin shape
 * and the unknown `--standalone` flag, so a hosted session would abort at
 * launch — agent-detect surfaces this as a warning instead. */
export const OPENCODE_MIN_VERSION = "2.0.29";

/** The `x.y.z` triple in `opencode --version` output (e.g. "opencode v2.0.29"
 * or "1.19.0"), or null if there isn't one. The LAST match wins: the probe
 * runs in a login shell, whose profile (nvm, direnv, motd…) can print its own
 * versions to stdout before opencode's line. */
export function parseOpencodeVersion(output: string): string | null {
  return [...output.matchAll(/(\d+)\.(\d+)\.(\d+)/g)].at(-1)?.[0] ?? null;
}

function versionTuple(version: string): [number, number, number] {
  const [a = 0, b = 0, c = 0] = version.split(".").map((part) => Number.parseInt(part, 10));
  return [a, b, c];
}

/** A user-facing warning when `version` is older than OPENCODE_MIN_VERSION,
 * else null (including for a null/unparseable version — never warn on doubt). */
export function opencodeVersionWarning(version: string | null): string | null {
  if (!version) return null;
  const have = versionTuple(version);
  const min = versionTuple(OPENCODE_MIN_VERSION);
  for (let i = 0; i < 3; i++) {
    if (have[i] > min[i]) return null;
    if (have[i] < min[i]) {
      return `opencode ${version} is too old: Mullion needs opencode ${OPENCODE_MIN_VERSION} or newer (hosted sessions will fail to launch). Update with \`opencode upgrade\`.`;
    }
  }
  return null;
}

const OPENCODE_COMMAND_RE = /^(?:\S*\/)?opencode(?:\s|$)/;

// Issue: extend surfaced session statuses — the hook-protocol `kind`s
// opencode-plugin.js's mapOpenCodeEvent can ever produce from the v2 events it
// handles, plus `promote_request` from the plugin's own `promote_to_worktree`
// tool (analogous to Claude Code's MCP-tool-sourced promote_request — see
// CLAUDE_CODE_EMITS's doc comment in claude-code.ts for the same caveat: no
// mechanical mapper to parity-test this one against). Unlike the other three
// adapters, this list is verified against opencode-plugin.js's own test suite
// (opencode-plugin.test.ts) rather than forwarder-core.test.ts — see that
// file's parity test asserting mapOpenCodeEvent's output stays inside this
// set.
//
// v2 has no server-side source for 1.x's `todo` (no todo tool), `session.diff`
// or the toast, so `todo` is no longer emitted. `session_diff` is derived by
// the plugin (step files + `ctx.vcs.diff`, tool-sourced like promote_request —
// no mapOpenCodeEvent output to parity-test it against) and `notification`
// comes from v2's `worktree.failed` / `workspace.failed` /
// `session.compaction.failed` (issue #1592).
//
// Issue #1700 — `stop_failure` and `tool_failure` have BOTH sources in v2,
// and they are different things: `session.execution.failed` (the TURN failed —
// a provider/API error) is a `stop_failure`, the same kind Claude Code's
// StopFailure and Codex's Stop failure produce; `session.tool.failed` (one
// tool call failed, the turn carries on) is a `tool_failure`. v2 reports a
// non-zero shell exit as `session.tool.success` with an `exit` code, not as a
// failure.
/** Per-session files/dirs the opencode adapter writes under sessionsDir (#949). */
export function opencodeTier0Path(sessionsDir: string, id: string): string {
  return path.join(sessionsDir, `${id}.opencode-tier0.md`);
}
export function opencodeSeedPath(sessionsDir: string, id: string): string {
  return path.join(sessionsDir, `${id}.opencode-seed.md`);
}
/** Ephemeral per-session scratch directory (plugin dir, project skills).
 * NOT an `OPENCODE_CONFIG_DIR` — v2 would treat that as a replacement for the
 * user's global config root (see this file's header). */
export function opencodeConfigDir(sessionsDir: string, id: string): string {
  return path.join(sessionsDir, `${id}.opencode-config`);
}
/** The plugin DIRECTORY `OPENCODE_CONFIG_CONTENT.plugins` points at; v2's
 * loader resolves `server.js` inside it. */
export function opencodePluginDir(sessionsDir: string, id: string): string {
  return path.join(opencodeConfigDir(sessionsDir, id), "plugin");
}

export const OPENCODE_EMITS = [
  "progress",
  "file_change",
  "turn_start",
  "permission_request",
  // Fix: status-clearing-semantics — was "notification_resolved", which
  // `permission.replied` used to (incorrectly) map to; see
  // opencode-plugin.js's own comment on that event.
  "permission_resolved",
  // Issue #1700 — a failed turn (`session.execution.failed`) maps to
  // `stop_failure`, the same kind Claude Code's StopFailure and Codex's Stop
  // failure produce. Before this, opencode's turn failures mapped to
  // `tool_failure` (1.x's `session.error` mapping), which meant an opencode
  // session could never reach the `api_error` status and Task Master's
  // rate-limit grace (which keys off a `stop_failure`'s `errorType`) could
  // never fire for an opencode worker.
  "stop_failure",
  "tool_failure",
  "git_branch",
  "cwd_changed",
  "promote_request",
  // Issue #1594 — a Mullion review gate opened by the plugin alongside
  // opencode's own permission dock (tool-sourced like promote_request, so
  // there is no mapOpenCodeEvent output to parity-test it against).
  "review_gate",
  "session_diff",
  "notification",
  // Issue #271 follow-up — the live opencode session id, reported on every
  // finished turn (see opencode-plugin.js's mapOpenCodeEvent) so a later
  // promote can carry full conversation history, not just a seed summary.
  "agent_session",
  // Issue #321 — compaction events (v2: session.compaction.*)
  "compact",
  // Issue #321 — subagent events (v2: a child session's lifecycle)
  "subagent",
  // opencode's `question` tool (v2: a form whose metadata.kind is "question")
  "question",
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
  const configDir = opencodeConfigDir(ctx.sessionsDir, ctx.sessionId);
  const pluginDir = opencodePluginDir(ctx.sessionsDir, ctx.sessionId);
  const pluginSource = readFileSync(resolveOpenCodePluginPath(), "utf8");
  const envAdditions: Record<string, string> = {};
  // v2's loader resolves `server.js` (or `index.js`) inside a configured
  // plugin DIRECTORY — a bare file path is rejected ("configured plugin path
  // must be a directory").
  const settingsFiles: Array<{ path: string; contents: string }> = [
    { path: path.join(pluginDir, "server.js"), contents: pluginSource },
  ];
  // Issue #678 — the instruction sources below (agent-guide, workflow
  // conventions, briefing, promote-flow seed) are independently gated and
  // simply concatenate into one list. v2 never reads the `instructions`
  // config key (see this file's header), so the list is handed to the plugin
  // as MULLION_OPENCODE_INSTRUCTIONS and appended to the system prompt by its
  // `context` hook — in this order: [tier-0, workflow-conventions, briefing,
  // seed], matching hooks.ts's own ordering (issue #942) for the other three
  // agents.
  const instructions: string[] = [];

  // Issue #437c, redesigned by #949 — the agent-guide tier-0 push. Unlike
  // every other agent, OpenCode has no live hook round trip to reply to
  // (hooks.ts's session_start branch doesn't apply), so this builds the SAME
  // small tier-0 block hooks.ts pushes to the other three agents
  // (buildAgentGuideBlock, agent-guide.ts) and writes it to its own small
  // file. The block carries what #940's pull-based skills can't: host-
  // dependent LIVE state (`ctx.authEnabled`) and the plain fact that the
  // guide file and skills exist to go read.
  //
  // Gated on ctx.injectAgentGuide (a spawn-time snapshot of the setting, see
  // that field's doc comment) and on agentGuideSourceExists() — a checkout/
  // install that hasn't shipped docs/agent-guide.md must never send an agent
  // to a guide-file pointer that isn't there. Written via `settingsFiles`, so
  // the file always exists before opencode starts; the pointer sentence
  // inside it still names the separately-written full guide copy, which CAN
  // dangle if that write fails — the same accepted risk the other agents'
  // pointer sentence has (see agent-guide.ts).
  if (ctx.injectAgentGuide && agentGuideSourceExists()) {
    const guidePath = sessionAgentGuidePath(ctx.sessionsDir, ctx.sessionId);
    const tier0Path = opencodeTier0Path(ctx.sessionsDir, ctx.sessionId);
    settingsFiles.push({
      path: tier0Path,
      contents: buildAgentGuideBlock(guidePath, ctx.authEnabled ?? true),
    });
    instructions.push(tier0Path);
  }

  // Issue #937 — this Mullion install's own workflow-conventions text. No
  // `ctx.injectWorkflowConventions` boolean to check: session-lifecycle.ts's
  // createSessionRecord already resolved the project column AND the global
  // text's non-emptiness into one value before this runs, and
  // writeSessionWorkflowConventions (launch-plan.ts, before
  // applyHookAdapters) unlinks the file rather than writing an empty one —
  // so file presence alone encodes both gates.
  const workflowConventionsPath = sessionWorkflowConventionsPath(ctx.sessionsDir, ctx.sessionId);
  if (existsSync(workflowConventionsPath)) {
    instructions.push(workflowConventionsPath);
  }

  // The project's own briefing, gated on `ctx.injectProjectBriefing` (an
  // independent setting, see that field's doc comment).
  // writeSessionBriefing runs before applyHookAdapters and unlinks any stale
  // copy when nothing resolves, so this existsSync check never sees a
  // briefing from a previous session that reused this id.
  if (ctx.injectProjectBriefing) {
    const briefingPath = sessionBriefingPath(ctx.sessionsDir, ctx.sessionId);
    if (existsSync(briefingPath)) {
      instructions.push(briefingPath);
    }
  }

  // Issue #678 — a user-supplied "resume here" note (POST
  // /api/sessions/:id/promote's `seedPrompt`), superseded in practice by
  // `initialPromptArgs` for the promote flow (routes/sessions.ts prefers
  // `initialPrompt` for any adapter with argv support) but kept as a
  // context-only fallback for any OTHER caller that sets `seedPrompt`
  // without `initialPrompt`. Gated on `ctx.seedPrompt` alone, NOT on
  // `ctx.injectAgentGuide`: a user explicitly asked for this seed and it must
  // not vanish because an unrelated setting is off.
  if (ctx.seedPrompt && ctx.seedPrompt.length > 0) {
    const seedPath = opencodeSeedPath(ctx.sessionsDir, ctx.sessionId);
    settingsFiles.push({ path: seedPath, contents: ctx.seedPrompt });
    instructions.push(seedPath);
  }
  if (instructions.length > 0) {
    envAdditions.MULLION_OPENCODE_INSTRUCTIONS = JSON.stringify(instructions);
  }

  // Mullion's own agent-facing tooling bundle (src/bundle/). v2's config key
  // is `skills: string[]` (1.x's `skills.paths`, which v2 still folds in but
  // reports as migrated). Points directly at the shipped bundle's skills/
  // dir; nothing is written to opencode's own real config. Gated on
  // ctx.injectMullionBundle alone, same spawn-time-snapshot posture as
  // injectAgentGuide/injectProjectBriefing above.
  const skillsPaths: string[] = [];
  // Issue #941 — once bundle-sync.ts's boot-time sync has globally installed
  // the shipped bundle's skills under resolveOpenCodeConfigHome()/skills,
  // opencode discovers them there natively (Mullion no longer redirects
  // OPENCODE_CONFIG_DIR, so the user's global skills dir is visible in a
  // Mullion session); pushing the shipped dir again would be redundant.
  // isBundleSyncedFor is a cheap manifest read, safe on every launch. Falls
  // back to a per-session entry when nothing's synced yet. The project-skill/
  // project-reviewer entries below are a separate, always-per-session
  // mechanism and are NOT gated on this.
  if (ctx.injectMullionBundle && !isBundleSyncedFor("opencode")) {
    const bundleDir = resolveMullionBundleDir();
    if (bundleDir) skillsPaths.push(path.join(bundleDir, "skills"));
  }

  // PR-5 — a project's own skill (project_tooling.skill, schema.ts) rides the
  // same `skills` channel: written into its own subdirectory of this
  // session's ephemeral scratch dir (never the shipped bundle's tree) and
  // that subdirectory added alongside the shipped bundle's. Content whose
  // frontmatter `name` can't be safely derived (deriveContentName's doc
  // comment) is silently skipped — same posture as claude-code.ts's
  // composeClaudeSessionBundle; the route (routes/project-tooling.ts) already
  // rejects that at write time.
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

  // Issue #881 — the Mullion MCP server, always registered (mirroring
  // claude-code.ts's unconditional --mcp-config and agy.ts's unconditional
  // mergeAgyMcpConfig — the tools it exposes are core Mullion functionality,
  // not an optional nudge). Emitted in 1.x's `mcp.<name>` shape, which v2
  // still reads and migrates to `mcp.servers.<name>` (verified).
  const mcpConfig = buildOpenCodeMcpConfig(
    resolveMcpServerPath(),
    ctx.hookSocketPath,
    ctx.hookToken,
    ctx.controlSocketPath,
  );

  const configContent: Record<string, unknown> = { mcp: mcpConfig, plugins: [pluginDir] };
  if (skillsPaths.length > 0) configContent.skills = skillsPaths;
  if (ctx.model) configContent.model = ctx.model;

  // v2 has no `small_model`; its 1.x value migrates only to the title agent's
  // model, so that's set explicitly here. A project's own reviewer subagent
  // (project_tooling.reviewerAgent) rides the same `agents` map as an inline
  // `agents.<name>` entry — v2's `OPENCODE_CONFIG_DIR/agent/<name>.md`
  // discovery depended on the redirect Mullion no longer sets (see
  // deriveOpenCodeReviewerAgentConfig's own doc comment, including why the
  // raw Claude-Code-shaped content can't be used verbatim).
  const agents: Record<string, unknown> = {};
  if (ctx.smallModel) agents.title = { model: ctx.smallModel };
  if (ctx.injectMullionBundle && ctx.projectReviewerAgent) {
    const reviewer = deriveOpenCodeReviewerAgentConfig(ctx.projectReviewerAgent);
    // Never clobber an entry set above (e.g. a reviewer named `title` would
    // otherwise replace the user's small-model setting).
    if (reviewer && !(reviewer.name in agents)) agents[reviewer.name] = reviewer.config;
  }
  if (Object.keys(agents).length > 0) configContent.agents = agents;

  // Task Master (worker / review / retry / re-seed) — deny the superpowers
  // skills that gate on a human in the loop. Verified failing in branchdam-
  // mobile tasks #66 / #67, where the opencode worker invoked
  // `brainstorming` and asked a clarifying question the unattended session
  // could not answer, then ended its turn with no commits (the #722 "no
  // commits ahead of base" gate correctly failed the task). Only set when
  // ctx.taskId is present (a Task Master spawn), so a human-driven session of
  // the same agent is unaffected.
  //
  // WHY THESE THREE:
  //   - brainstorming: presents clarifying questions to the user (the
  //     actual cause of the #66 / #67 failures).
  //   - writing-plans: writes a plan doc for a human to review, not code —
  //     irrelevant to a worker that has been told exactly what to build.
  //   - finishing-a-development-branch: presents merge / PR / cleanup options
  //     to a human, not the kind of thing a worker should do.
  // The other superpowers skills are either useful or neutral for an
  // unattended worker and are left alone.
  //
  // Two layers, because v2 orders rules as: every document's top-level
  // `permission` (global dir first, OPENCODE_CONFIG_CONTENT after it), THEN
  // each agent's own `agents.<id>.permissions` (documents in order), and the
  // LAST matching rule wins (`findLast`; packages/core/src/config/plugin/
  // agent.ts + permission.ts at v2.0.29, issue #1595). So:
  //   - the top-level `permission.skill` denies below (1.x shape, migrated to
  //     `{ action: "skill", resource, effect }`) beat a user's top-level
  //     global allow, but
  //   - a user's AGENT-level allow (`agent.build.permission.skill.<name>`)
  //     sits after every top-level rule and would beat them — so the same
  //     denies are repeated at agent level on the primary agents a worker
  //     runs as. `agents.<id>` entries merge into the built-in agent (only
  //     `permissions` is pushed), and our document loads after the user's,
  //     so these land last.
  // A user's custom agent can't be enumerated here; those are left to the
  // top-level denies.
  if (ctx.taskId !== undefined) {
    configContent.permission = {
      skill: Object.fromEntries(TASK_DENIED_SKILLS.map((name) => [name, "deny"])),
    };
    const agentDenies = TASK_DENIED_SKILLS.map((resource) => ({
      action: "skill",
      resource,
      effect: "deny",
    }));
    for (const id of TASK_WORKER_PRIMARY_AGENTS) {
      const existing = (agents[id] ?? {}) as Record<string, unknown>;
      const prior = Array.isArray(existing.permissions) ? existing.permissions : [];
      agents[id] = { ...existing, permissions: [...prior, ...agentDenies] };
    }
    configContent.agents = agents;
  }
  envAdditions.OPENCODE_CONFIG_CONTENT = JSON.stringify(configContent);

  return {
    settingsFiles,
    envAdditions,
    commandTransform: opencodeStandaloneTransform,
    // Issue #1079 — the setting-off counterpart to the `skills` shipped-bundle
    // branch above, which only ever SKIPS adding a pointer. Codex's and agy's
    // own managedInstall steps already actively uninstall their globally-
    // synced content on every launch when the setting is off; opencode never
    // did, so a prior boot-time sync's content lingered under
    // resolveOpenCodeConfigHome() until the next Mullion process restart. See
    // removeBundleContentForCli's own doc comment for why this is scoped to
    // opencode's own two roots only, never the whole-host
    // removeBundleContent(). A no-op call when nothing was ever synced.
    managedInstall: ctx.injectMullionBundle
      ? undefined
      : async () => {
          await removeBundleContentForCli("opencode");
        },
  };
}

// Skills denied for unattended Task Master workers, and the primary agents they
// can run as (see the permission block in prepareLaunch).
const TASK_DENIED_SKILLS = ["brainstorming", "writing-plans", "finishing-a-development-branch"];
const TASK_WORKER_PRIMARY_AGENTS = ["build", "plan"];

// opencode's own subcommands (`opencode --help` on 2.0.29). `--standalone`
// belongs to the DEFAULT command (the TUI), not to every subcommand, so it
// must not be spliced in front of one of these. Mullion always spawns the
// TUI, so this only matters for a hand-typed `opencode run ...` style command.
const OPENCODE_SUBCOMMANDS = new Set([
  "upgrade",
  "update",
  "uninstall",
  "acp",
  "api",
  "debug",
  "auth",
  "mcp",
  "plugin",
  "models",
  "stats",
  "mini",
  "run",
  "session",
  "service",
  "reload",
  "pair",
  "serve",
]);

/** Inserts `--standalone` right after the `opencode` program token, so the
 * TUI runs against a private server that inherits this session's env instead
 * of attaching to the user's shared background service (see this file's
 * header). Attached to the program token itself — never appended to the end —
 * so it can't land on the wrong part of a chained command; the adapter's
 * `matches` already anchors on the command's first token. Idempotent, and a
 * no-op when the command is an opencode subcommand rather than the TUI, or
 * already attaches to a server (`--server`).
 * One of the sanctioned `commandTransform` exceptions to the opaque-command
 * invariant (AGENTS.md). */
export function opencodeStandaloneTransform(command: string): string {
  // `--server <url>` attaches to an existing server; `--standalone` would
  // contradict it (and the plugin/config then live in that server anyway).
  if (/(?:^|\s)--(?:server(?:\s|=)|standalone(?:\s|=|$))/.test(command)) return command;
  const m = /^(\s*(?:\S*\/)?opencode)(?=\s|$)(\s+(\S+))?/.exec(command);
  if (!m) return command;
  const next = m[3];
  if (next !== undefined) {
    if (next === "--standalone" || OPENCODE_SUBCOMMANDS.has(next)) return command;
  }
  return `${m[1]} --standalone${command.slice(m[1].length)}`;
}

export const openCodeAdapter: HookAgentAdapter = {
  name: "opencode",
  // A plain anchored program-token match. The one argv edit this adapter
  // makes (`--standalone`) is spliced right after that same first token (see
  // opencodeStandaloneTransform), so — unlike an appended flag — it can't be
  // misattached to another part of a chained command.
  matches: (command) => OPENCODE_COMMAND_RE.test(command.trim()),
  prepareLaunch,
  emits: OPENCODE_EMITS,
  // Verified against the installed opencode v2.1.3 (the version this host's
  // PATH resolves to for a nvm/global install). The subagent tool's input
  // schema is:
  //
  //   agent      — the type of specialized agent to run (v1's
  //                `subagent_type`; the tool's own migration notice says
  //                "The `subagent` tool takes `agent` instead of
  //                `subagent_type` and `sessionID` instead of `task_id`")
  //   model      — optional, "providerID/modelID" or
  //                "providerID/modelID#variant"
  //   description, prompt, sessionID
  //
  // So v2 DOES take a per-call model — the same shape as Claude Code's Task
  // tool, and the lever the worker can actually pull. The previous row
  // named neither, and pointed instead at `explore` and `general` as
  // "shipped in" subagents to prefer — but their v2 definitions set only
  // name/description/mode/permissions and carry no model of their own, so
  // the advice named a lever that does not exist.
  //
  // The row below says "on 2.x" rather than claiming v1 is impossible:
  // OPENCODE_MIN_VERSION only WARNS (opencodeVersionWarning →
  // DetectedAgent.versionWarning → the launcher's "update needed" badge),
  // it does not refuse the agent, and a 1.x install still launches. This
  // host has BOTH a 2.1.3 and a 1.17.20 opencode on PATH, so a worker can
  // land on either. A 1.x tool has no per-call model at all, so the row
  // hedges with "where the tool offers one" rather than naming a parameter
  // that may not exist.
  //
  // The clause also repeats the tool's own rule about the model id ("look
  // the model up with the models tool, filtering to your own provider
  // first... do not guess the ID"), and says that this task is the ask
  // that rule refers to — the tool's note tells the model not to set
  // `model` unasked, and a worker that took that literally would skip the
  // one argument the whole row depends on.
  delegationHint:
    "If this task has parts that could be done independently, delegate them: " +
    "opencode's subagent tool takes `agent` (the subagent type — 1.x calls " +
    "it `subagent_type`) and, on 2.x, an optional per-call `model` for that " +
    "call, written as `providerID/modelID` or `providerID/modelID#variant` — " +
    "so route the mechanical parts to a cheaper model where the tool offers " +
    "one, and keep the parts that need your own judgement for yourself. The " +
    "tool's own note says to set that model only when the caller asks for a " +
    "particular one; this task is that ask. Look the model up with the " +
    "`models` tool, filtered to your own provider, rather than guessing the " +
    "id. A delegated part may run in its own workspace or fork, so whatever " +
    "you delegate has to land on this branch — you remain responsible for " +
    "the final commit here.",
  // `--prompt <text>` is a top-level option on the DEFAULT `opencode
  // [directory]` command (the TUI, which is what Mullion always spawns — there
  // is no `run`/`exec` subcommand involved), and in v2 it SUBMITS that text
  // as the session's first turn once the model and agent are ready, rather
  // than merely pre-filling the input box (verified against 2.0.29's TUI
  // source, `routes/home.tsx`). `--prompt`, not the bare positional the other
  // three adapters' `initialPromptArgs` use (`-- <prompt>`) — opencode's
  // positional argument is `[directory]`, so an unflagged prompt would be
  // silently misread as one.
  initialPromptArgs: (prompt) => `--prompt ${shellQuote(prompt)}`,
  // sessions.prompt: paste-then-Enter into the running TUI (see standardPromptFraming).
  submitPrompt: standardPromptFraming,
  // Issue #271 follow-up — resume an existing session by id. v2's
  // `--session <id>` means "continue, or CREATE it if it doesn't exist".
  //
  // This is the mechanism `--fork` was rejected for (see
  // opencode-session-transfer.ts's own header comment): `--fork` pins the
  // forked session's directory to the ORIGINAL session's stored directory, so
  // tool calls would silently run back in the live main checkout. Bare
  // `--session` on a session already re-keyed to the new directory
  // (opencode-session-transfer.ts's import step) has no such pinning — this
  // only works because the transfer step re-keys `directory` before this ever
  // runs.
  //
  // Unlike 1.18 (where `--prompt` was accepted but silently NEVER submitted
  // alongside `--session`/`--continue`), v2's session route auto-submits
  // `--prompt` on a resumed session too (2.0.29 `routes/session/index.tsx`),
  // so `resumeSessionArgs` and `initialPromptArgs` may be combined in one
  // launch.
  resumeSessionArgs: (agentSessionId) => `--session ${shellQuote(agentSessionId)}`,
};
