import type { FastifyInstance } from "fastify";
import path from "node:path";
import { existsSync } from "node:fs";
import { resolveSshAuthSock } from "../services/ssh-agent-socket.js";
import { appVersion } from "./server-info.js";
import type { AgentConfig } from "../services/remote-host-client.js";
import { paletteBodySchema } from "./terminal-palette.js";
import { setTerminalPalette, type TerminalPalette } from "../services/terminal-query-reply.js";
import { measureHostCapacity } from "../services/host-capacity.js";
import {
  listAgentRules,
  getAgentRule,
  writeAgentRule,
  deleteAgentRule,
  resolveTarget,
  listExistingProjectRuleFileNames,
  AgentRuleTooLargeError,
  AgentRuleSymlinkError,
  AgentRulesTimeoutError,
  isTransientReadError,
} from "../services/agent-rules.js";
import {
  listProjectSkills,
  toggleSkillEnabled,
  classifySkillToggleError,
  SkillsTimeoutError,
  isTransientReadError as isTransientSkillsReadError,
  type SkillAgent,
} from "../services/skills.js";
import {
  discoverCandidates,
  parseProjectsRootsEnv,
  resolveProjectActions,
  resolveProjectDock,
} from "../services/project-config.js";
import {
  readDockConfig,
  writeDockConfig,
  validateDockConfig,
  DockConfigValidationError,
  DockConfigTooLargeError,
  DockConfigSymlinkError,
  isTransientReadError as isTransientDockConfigReadError,
} from "../services/dock-config.js";
import {
  effectiveProjectsRoots,
  resolveEffectiveProjectsRoots,
  protectedAgentDirs,
  validateProjectsRoots,
  writeProjectsRootsOverride,
} from "../services/agent-projects-roots.js";
import { getCachedAgents } from "../services/agent-detect.js";
import { resolveGlobalPresets } from "./actions.js";
import {
  applyUpdateSchema,
  readStatus as readUpdateStatus,
  spawnSelfUpdate,
  type ApplyUpdateBody,
} from "../services/update-apply.js";
import {
  projectsRootsSchema,
  type ProjectsRootsBody,
  writeDockConfigBodySchema,
  agentRuleWriteBodySchema,
  toggleSkillBodySchema,
} from "./internal-schemas.js";
import { INTERNAL_RATE_LIMIT, PROJECTS_ROOTS_RATE_LIMIT } from "./internal-rate-limits.js";
import { requireWithinRoots } from "./internal-roots.js";

/**
 * Issue #247 / roadmap 7.4 — the single source of truth for "this process's
 * own effective config," shared by GET /internal/config below (an agent
 * describing itself) and routes/hosts.ts's `local` special case (the
 * primary describing itself, since it never registers internalRoutes to
 * call on its own process — see src/app.ts's role branch). Independent
 * review, PR #527: without this shared function, the two call sites
 * duplicated the same six-field object literal by hand, with nothing
 * forcing them to stay in sync if a field is ever added.
 */
export function buildAgentConfig(app: FastifyInstance): AgentConfig {
  // Issue #820 PR5d — mirror plugins/pty.ts's own resolveSshAuthSock call
  // exactly (same three-tier precedence: configured > ambient > bridge),
  // so this diagnostic reports what a session *actually* gets, not just
  // the raw MULLION_SSH_AUTH_SOCK value. Before this, buildAgentConfig was
  // a second, independent producer of this fact that PtyManager's own
  // resolution could silently drift from (e.g. reporting "not configured"
  // while sessions were actually getting the bridge socket). Note that
  // "not configured" (`sshAuthSock: null` below) still covers the ambient
  // tier: when MULLION_SSH_AUTH_SOCK is unset but this process already
  // inherits a real SSH_AUTH_SOCK, resolveSshAuthSock deliberately returns
  // "" (see its own doc comment) — a session genuinely receives that
  // inherited value, this just means *Mullion* isn't the one supplying it,
  // so there's nothing Mullion-owned to report a path for.
  // app.pty.sessionsDir, not app.config.SESSIONS_DIR:
  // ptyPlugin's own ensureSessionsDir() can redirect a too-long sessionsDir
  // to a short fallback under the platform's temp dir, and app.pty.sessionsDir
  // already reflects whichever one actually won — the same reasoning
  // plugins/ssh-agent.ts's own sshAgentSocketPath call already relies on.
  //
  // Hermes review, PR #877 — `app.sshAuthSockBridgeExpected`
  // (plugins/pty.ts), not `materializesBridgeSocket(app.config.MULLION_ROLE)`
  // recomputed from scratch. The raw role predicate says nothing about
  // whether THIS boot's preflight probe actually let the bridge tier
  // through — on a host where it didn't (a live foreign listener already
  // occupies the bridge socket path), PtyManager froze every session to
  // `none`/`ambient`, but re-deriving from the role alone would still
  // report `source: "bridge"` here: Settings would show a path pointing at
  // a process this host doesn't control, while sessions actually get
  // something else entirely. That's the exact producer-drift this
  // function's own PR5d history exists to prevent (see the paragraph
  // above) — `sshAuthSockBridgeExpected` is the one value both this
  // function and pty.ts must agree on.
  const ambientSshAuthSock = process.env.SSH_AUTH_SOCK;
  const resolved = resolveSshAuthSock({
    configured: app.config.MULLION_SSH_AUTH_SOCK,
    ambient: ambientSshAuthSock,
    materializesBridgeSocket: app.sshAuthSockBridgeExpected,
    sessionsDir: app.pty.sessionsDir,
  });
  // PR7a: the "ambient" tier's own `path` is always "" (resolveSshAuthSock's
  // signal to "don't touch it" — see its own doc comment), so there's no
  // Mullion-resolved path to report for it. Report the ambient value itself
  // instead — it's a real path this process inherited and sessions actually
  // get it — so Settings > Hosts can show *something* other than "unknown"
  // for the one tier resolveSshAuthSock deliberately returns empty for.
  // `?? ""` is defensive, not reachable: resolveSshAuthSock only ever
  // returns source "ambient" when it saw `ambientSshAuthSock` truthy (see
  // its own precedence — that's the whole point of this substitution).
  const rawSshAuthSock = resolved.source === "ambient" ? (ambientSshAuthSock ?? "") : resolved.path;
  // For `configured`/`bridge`, resolved the same way PtyManager's own
  // constructor resolves this same value (pty-manager.ts) — a relative path
  // must not be reported (or existsSync'd) as-is, since PtyManager resolves
  // it once, up front, precisely so it doesn't get re-resolved against some
  // other cwd later. Reporting the raw string here would show an operator a
  // path that doesn't match what sessions actually receive. (The
  // bridge-socket case is already absolute, so this is a no-op for it.)
  //
  // For `ambient`, this is best-effort diagnostics only, NOT the same
  // resolution a session gets: launch-plan.ts only overwrites
  // SSH_AUTH_SOCK when resolveSshAuthSock's result is truthy, so the
  // ambient tier is skipped there entirely and a spawned session inherits
  // this process's own SSH_AUTH_SOCK exactly as-is via normal env
  // inheritance — PtyManager never sees or resolves it. If that value were
  // ever relative (unusual for an ssh-agent socket, but not something
  // Mullion controls), resolving it here against this server process's own
  // cwd for display could report a path a session doesn't actually use —
  // acceptable for a read-only diagnostic, but don't read this as "what the
  // session gets" the way it is for the other two tiers.
  const sshAuthSockPath = rawSshAuthSock === "" ? "" : path.resolve(rawSshAuthSock);
  const projectsRoots = resolveEffectiveProjectsRoots(app);
  return {
    role: app.config.MULLION_ROLE,
    version: appVersion,
    projectsRoots: projectsRoots.roots,
    // Issue #1951 follow-up — where the roots above come from, what a reset
    // goes back to, and whether this host's operator pinned them. Optional on
    // the wire: an agent build that predates them omits them.
    projectsRootsSource: projectsRoots.source,
    projectsRootsEnv: parseProjectsRootsEnv(app.config.PROJECTS_ROOTS),
    projectsRootsLocked: app.config.PROJECTS_ROOTS_LOCKED,
    // A saved override that the operator's lock is keeping from applying: the
    // dialog offers to clear it (clearing only moves toward the pinned value).
    projectsRootsOverrideIgnored: projectsRoots.overrideIgnored,
    sessionsDir: app.config.SESSIONS_DIR,
    crsConfigDir: app.config.CRS_CONFIG_DIR,
    browserEnabled: app.browserEnabled,
    // existsSync, not fs.stat — this stays synchronous so neither of this
    // function's two callers (this route, and hosts.ts's `local` branch)
    // needs to change shape. A dangling socket is expected, not an error
    // (see AgentConfig's own comment); this is read-only visibility only.
    // `source` is present on every non-null case below; the only case with
    // no `source` to report is sshAuthSockPath === "" (the "none" tier),
    // which reports `null` for the whole field below — same as before
    // PR7a — rather than an object with nothing useful in it.
    sshAuthSock:
      sshAuthSockPath === ""
        ? null
        : {
            path: sshAuthSockPath,
            present: existsSync(sshAuthSockPath),
            source: resolved.source,
          },
  };
}

/**
 * The agent's discovery, config, projects-roots, capacity, updates, actions, dock, agent-rules, skills and agents routes. Registered from `internalRoutes` so they sit
 * behind its auth hook and share its rate limits.
 */
export function registerConfigRoutes(app: FastifyInstance): void {
  // This agent's own project roots: its env PROJECTS_ROOTS unless the primary
  // saved an override (services/agent-projects-roots.ts). Unlike the primary's
  // resolveProjectRoots (routes/projects.ts) there is no DB Settings value to
  // check — an agent has no DB.
  app.get("/internal/discover", INTERNAL_RATE_LIMIT, async () => {
    return discoverCandidates(effectiveProjectsRoots(app));
  });

  // Issue #247 / roadmap 7.4 — per-agent effective-config visibility, pull-
  // based so it works identically against a manually-registered
  // (static-bearer) host and, once #245 lands, a self-registered one; no
  // new auth surface, just another route behind this file's existing
  // onRequest gate. Reads app.config only, deliberately never app.db — an
  // agent has none (src/app.ts's agent branch never registers dbPlugin),
  // which is exactly why five *other* routes in this file crash today when
  // reached on an agent role (see issue #522, filed separately). Session
  // idle-timeout is intentionally NOT included here: that's a DB-backed
  // Settings value (services/settings.ts's idleThresholdSeconds) with no
  // env-var equivalent, so an agent has no way to know it either.
  app.get("/internal/config", INTERNAL_RATE_LIMIT, async () => buildAgentConfig(app));

  // Issue #1951 follow-up — the primary editing THIS agent's project roots
  // (Settings → Hosts → config). The roots are the containment barrier for
  // this file's file and git routes, so a refusal here is deliberate and
  // explained: it answers HTTP 422 carrying `{status, error}` (a 4xx,
  // because RemoteHostClient.request() discards the body of a 5xx) with the
  // status the primary should show. `roots: null` removes the saved override
  // and goes back to this host's env value. The change is persisted
  // (services/agent-projects-roots.ts) and applies to the very next request
  // — no restart. Logged at warn level: a moved barrier should never be
  // silent on the host it protects.
  app.put<{ Body: ProjectsRootsBody }>(
    "/internal/projects-roots",
    { ...PROJECTS_ROOTS_RATE_LIMIT, schema: projectsRootsSchema },
    async (request, reply) => {
      const requested = request.body.roots;
      // Pinned: the primary may not SET roots, but clearing a stale saved
      // override is allowed — it only moves toward the value the operator
      // pinned, and without it an override saved before the lock would sit
      // there, ignored, until someone unlocks the host and it springs back.
      if (app.config.PROJECTS_ROOTS_LOCKED && requested !== null) {
        reply.code(422);
        return {
          status: 409,
          error:
            "this host's project roots are pinned by its operator (PROJECTS_ROOTS_LOCKED) and cannot be changed from the primary",
        };
      }
      if (requested === null) {
        writeProjectsRootsOverride(null);
        app.log.warn("project roots: the saved override was removed by the primary");
        return buildAgentConfig(app);
      }
      const checked = validateProjectsRoots(requested, { protectedDirs: protectedAgentDirs(app) });
      if (!checked.ok) {
        reply.code(422);
        return { status: 400, error: checked.error };
      }
      writeProjectsRootsOverride(checked.roots);
      app.log.warn({ roots: checked.roots }, "project roots: changed by the primary");
      return buildAgentConfig(app);
    },
  );

  // Issue #1721 / roadmap 8.7 — this agent's own CAPACITY: how busy this
  // machine is, in numbers a placement policy can compare across hosts.
  // The fleet has a health signal today (online / degraded / offline) but no
  // capacity signal, so "put the work on the idle machine" is still a manual
  // decision (see the placement half, #1723-#1727).
  //
  // Read-only and self-describing, exactly like /internal/config above, and
  // behind the same gate: the bearer token plus the HMAC signature (or the
  // static-Bearer path for a manually-registered host). It reads no DB —
  // an agent has none — only the `os` primitives and this process's own
  // in-memory session tracking.
  //
  // The measurement lives in services/host-capacity.ts, NOT here, because
  // the primary measures ITSELF with the same function: one producer, two
  // callers, so a local host's numbers and an agent's numbers are
  // comparable by construction rather than by two implementations that
  // happen to agree today.
  app.get("/internal/capacity", INTERNAL_RATE_LIMIT, async () => {
    return { ...measureHostCapacity(app), sampledAt: new Date().toISOString() };
  });

  // Issue #647 / roadmap 7.8 — agent self-update, under /internal/ rather
  // than mirroring the primary's /api/updates/* verbatim (as the issue text
  // literally suggests). That distinction matters: src/app.ts's agent
  // branch never registers authPlugin, so /internal/* (gated by this file's
  // own onRequest bearer check, above) is the ONLY authenticated surface an
  // agent has. Mounting an unauthenticated POST that systemd-runs a script
  // which curls a tarball and `npm ci`s it would be remote code execution
  // with no credential at all. Logic is shared byte-for-byte with the
  // primary's own route via services/update-apply.ts, so there is exactly
  // one implementation of the spawn/status contract to keep correct.
  app.get("/internal/updates/status", INTERNAL_RATE_LIMIT, async () => {
    const mullionHome = app.config.MULLION_HOME;
    if (mullionHome.trim() === "") return { phase: "unavailable" };
    return readUpdateStatus(mullionHome);
  });

  app.post<{ Body: ApplyUpdateBody }>(
    "/internal/updates/apply",
    {
      schema: applyUpdateSchema,
      // Tighter than INTERNAL_RATE_LIMIT (1000/min) — matches the primary's
      // own /api/updates/apply limit for the same reason: each call spawns a
      // systemd-run child that downloads a release and runs `npm ci`.
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const result = await spawnSelfUpdate(app, request.body);
      if (!result.ok) {
        reply.code(result.status);
        return { message: result.message };
      }
      reply.code(result.status);
      return result.body;
    },
  );

  // resolveGlobalPresets (actions.ts) reads app.config.CRS_CONFIG_DIR and
  // calls getCachedAgents() — both already mean "this host's own" on an
  // agent process, exactly the reason this can't be computed on the primary
  // side instead (a remote box can have a different set of installed CLIs
  // than the primary — see the design plan).
  app.get<{ Querystring: { cwd?: string } }>(
    "/internal/actions",
    INTERNAL_RATE_LIMIT,
    async (request, reply) => {
      const { cwd } = request.query;
      if (!cwd) return reply.badRequest("cwd query param is required");
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      const globalPresets = await resolveGlobalPresets(app);
      return resolveProjectActions(resolvedCwd, globalPresets);
    },
  );

  app.get<{ Querystring: { cwd?: string } }>(
    "/internal/dock",
    INTERNAL_RATE_LIMIT,
    async (request, reply) => {
      const { cwd } = request.query;
      if (!cwd) return reply.badRequest("cwd query param is required");
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      return resolveProjectDock(resolvedCwd, app.config.CRS_CONFIG_DIR);
    },
  );

  // U4 — the agent-side half of the dock-config write triple
  // (routes/dock-config.ts is the primary side, remote-host-client.ts the
  // client that calls here). Same resolveWithinRoots containment as
  // /internal/dock above — required here too since `cwd` arrives as a
  // caller-supplied query param over the wire, unlike the primary's own
  // routes, which can trust project.cwd straight from the DB (see
  // dock-config.ts's own resolveDockConfigPath comment on why it still
  // re-checks anyway).
  app.get<{ Querystring: { cwd?: string } }>(
    "/internal/dock-config",
    INTERNAL_RATE_LIMIT,
    async (request, reply) => {
      const { cwd } = request.query;
      if (!cwd) return reply.badRequest("cwd query param is required");
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      try {
        return readDockConfig(resolvedCwd);
      } catch (err) {
        // Same "unreachable via any current call site, kept as a guard
        // against a future one" reasoning as routes/dock-config.ts's own
        // GET — resolvedCwd is already path.resolve()d by
        // resolveWithinRoots above.
        if (err instanceof DockConfigValidationError) return reply.badRequest(err.message);
        if (isTransientDockConfigReadError(err)) {
          return reply.serviceUnavailable("Permission denied reading dock.json");
        }
        throw err;
      }
    },
  );

  // The primary forwards the dashboard's resolved terminal palette here so this
  // agent's sessions get their startup color queries answered by the backend
  // (see services/terminal-query-reply.ts).
  app.put<{ Body: TerminalPalette }>(
    "/internal/terminal/palette",
    { ...INTERNAL_RATE_LIMIT, schema: paletteBodySchema },
    async (request, reply) => {
      const { foreground, background, cursor } = request.body;
      setTerminalPalette({ foreground, background, cursor });
      return reply.code(204).send();
    },
  );

  app.put<{ Querystring: { cwd?: string }; Body: { controls: unknown[] } }>(
    "/internal/dock-config",
    { ...INTERNAL_RATE_LIMIT, schema: writeDockConfigBodySchema },
    async (request, reply) => {
      const { cwd } = request.query;
      if (!cwd) return reply.badRequest("cwd query param is required");
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      let controls;
      try {
        controls = validateDockConfig({ controls: request.body.controls });
      } catch (err) {
        if (err instanceof DockConfigValidationError) return reply.badRequest(err.message);
        throw err;
      }
      try {
        writeDockConfig(resolvedCwd, controls);
        return readDockConfig(resolvedCwd);
      } catch (err) {
        if (err instanceof DockConfigTooLargeError) return reply.badRequest(err.message);
        if (err instanceof DockConfigSymlinkError) return reply.badRequest(err.message);
        if (err instanceof DockConfigValidationError) return reply.badRequest(err.message);
        if (isTransientDockConfigReadError(err)) {
          return reply.serviceUnavailable("Permission denied writing dock.json");
        }
        throw err;
      }
    },
  );

  // Issue #431 — the agent-side half of the project-scoped agent-rules
  // triple (routes/agent-rules.ts is the primary side, remote-host-client.ts
  // the client that calls here). `cwd` goes through the exact same
  // resolveWithinRoots containment as /internal/actions and /internal/dock
  // above — required and validated on every request here for consistency
  // with those routes, though it only actually GATES a project-scope
  // target's path (resolveTargetDir uses `projectCwd` for those). A
  // global-scope target resolves off THIS host's own env-derived dir
  // (globalDir(agent) — ~/.claude, $CODEX_HOME, etc.) regardless of `cwd`;
  // its safety comes from `target` never being a caller-supplied path —
  // resolveTarget() confines it to the fixed allow-list (see
  // agent-rules.ts), so there's nothing here for a
  // traversal attempt to reach beyond that enum.
  app.get<{ Querystring: { cwd?: string } }>(
    "/internal/agent-rules",
    INTERNAL_RATE_LIMIT,
    async (request, reply) => {
      const { cwd } = request.query;
      if (!cwd) return reply.badRequest("cwd query param is required");
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      try {
        return await listAgentRules(resolvedCwd);
      } catch (err) {
        if (err instanceof AgentRulesTimeoutError) {
          return reply.serviceUnavailable("Timed out reading agent rule files");
        }
        if (isTransientReadError(err)) {
          return reply.serviceUnavailable("Permission denied reading agent rule files");
        }
        throw err;
      }
    },
  );

  app.put<{ Params: { target: string }; Querystring: { cwd?: string }; Body: { content: string } }>(
    "/internal/agent-rules/:target",
    { ...INTERNAL_RATE_LIMIT, schema: agentRuleWriteBodySchema },
    async (request, reply) => {
      const { cwd } = request.query;
      if (!cwd) return reply.badRequest("cwd query param is required");
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      const target = resolveTarget(request.params.target);
      if (!target) return reply.badRequest("Unknown agent-rules target");
      try {
        writeAgentRule(target, resolvedCwd, request.body.content);
        return await getAgentRule(target, resolvedCwd);
      } catch (err) {
        if (err instanceof AgentRuleTooLargeError) return reply.badRequest(err.message);
        if (err instanceof AgentRuleSymlinkError) return reply.badRequest(err.message);
        if (err instanceof AgentRulesTimeoutError) {
          return reply.serviceUnavailable("Timed out reading agent rule file");
        }
        // Independent review, PR #458 — same EACCES-to-503 gap as the
        // primary route's PUT: this had no such mapping at all before.
        if (isTransientReadError(err)) {
          return reply.serviceUnavailable("Permission denied accessing agent rule file");
        }
        throw err;
      }
    },
  );

  app.delete<{ Params: { target: string }; Querystring: { cwd?: string } }>(
    "/internal/agent-rules/:target",
    INTERNAL_RATE_LIMIT,
    async (request, reply) => {
      const { cwd } = request.query;
      if (!cwd) return reply.badRequest("cwd query param is required");
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      const target = resolveTarget(request.params.target);
      if (!target) return reply.badRequest("Unknown agent-rules target");
      try {
        deleteAgentRule(target, resolvedCwd);
      } catch (err) {
        if (isTransientReadError(err)) {
          return reply.serviceUnavailable("Permission denied accessing agent rule file");
        }
        throw err;
      }
      reply.code(204);
    },
  );

  // Issue #431, Hermes review on PR #458 — a lightweight, names-only
  // counterpart to /internal/agent-rules above, for the sidebar's per-project
  // indicator (projects.ts's ruleFiles field) on a REMOTE-hosted project.
  // The full /internal/agent-rules round trip inlines content for all 12
  // targets (up to 512KB each) — fine for the actual editor panel, wasteful
  // for a presence-only badge that GET /api/projects recomputes on every
  // poll. Mirrors listExistingProjectRuleFileNames's own local-project path.
  app.get<{ Querystring: { cwd?: string } }>(
    "/internal/agent-rules/exists",
    INTERNAL_RATE_LIMIT,
    async (request, reply) => {
      const { cwd } = request.query;
      if (!cwd) return reply.badRequest("cwd query param is required");
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      return listExistingProjectRuleFileNames(resolvedCwd);
    },
  );

  // Issue #432 — the agent-side half of the skills-discovery triple
  // (routes/skills.ts is the primary side, remote-host-client.ts the
  // client). Same resolveWithinRoots containment as /internal/agent-rules
  // above; skills.ts's own listProjectSkills combines this cwd's
  // project-scope dirs with THIS host's own global/builtin dirs.
  app.get<{ Querystring: { cwd?: string } }>(
    "/internal/skills",
    INTERNAL_RATE_LIMIT,
    async (request, reply) => {
      const { cwd } = request.query;
      if (!cwd) return reply.badRequest("cwd query param is required");
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      try {
        return await listProjectSkills(resolvedCwd);
      } catch (err) {
        if (err instanceof SkillsTimeoutError) {
          return reply.serviceUnavailable("Timed out reading skill directories");
        }
        if (isTransientSkillsReadError(err)) {
          return reply.serviceUnavailable("Permission denied reading skill directories");
        }
        throw err;
      }
    },
  );

  // Issue #463 — the agent-side half of the skills enable/disable triple;
  // see routes/skills.ts's own header for the {agent, name, enabled}
  // body-only contract. classifySkillToggleError (skills.ts) is the SAME
  // function the primary route uses, so a local write and a remote-hosted
  // write that hit the identical underlying failure produce the identical
  // status/message — forwardHostRequestError on the primary forwards this
  // response's body/status verbatim.
  app.put<{
    Querystring: { cwd?: string };
    Body: { agent: SkillAgent; name: string; enabled: boolean };
  }>(
    "/internal/skills",
    { ...INTERNAL_RATE_LIMIT, schema: toggleSkillBodySchema },
    async (request, reply) => {
      const { cwd } = request.query;
      if (!cwd) return reply.badRequest("cwd query param is required");
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      const { agent, name, enabled } = request.body;
      try {
        return await toggleSkillEnabled(resolvedCwd, agent, name, enabled);
      } catch (err) {
        const classified = classifySkillToggleError(err);
        if (classified)
          return reply.code(classified.statusCode).send({ message: classified.message });
        if (err instanceof SkillsTimeoutError) {
          return reply.serviceUnavailable("Timed out reading skill directories");
        }
        if (isTransientSkillsReadError(err)) {
          // Hermes review, PR #469, round 4 — this wraps toggleSkillEnabled,
          // which can fail on the writer's own openSync/writeFileSync, not
          // just discovery — "reading skill directories" would misdescribe
          // a write-permission failure.
          return reply.serviceUnavailable(
            "Permission denied reading or writing skill configuration",
          );
        }
        throw err;
      }
    },
  );

  app.get("/internal/agents", INTERNAL_RATE_LIMIT, async () => {
    return getCachedAgents();
  });
}
