// The Docker Compose-service routes of the projects API, moved out of
// src/routes/projects.ts (issue #2474).
//
// This file is a MOVE, not a rewrite: the routes, their schemas, their status
// codes and their error mapping are exactly what they were. It exists because
// src/routes/projects.ts was one 3,074-code-line function holding three
// remaining surfaces, and the file-size guardrail turns over one ceiling at a
// time.
//
// projectsRoute() calls projectDockerRoute() at the position this block used
// to occupy, so Fastify's registration ORDER — and the plugin encapsulation
// context the routes are registered in — are unchanged. It is a plain call,
// not an app.register(): a registered plugin is deferred to the end of the
// enclosing plugin, which would reorder the routes.
//
// discoveredServicesForProject and localProjectCwds live here because they are
// shared with the /api/projects/:id/dock route that stays in projects.ts;
// importing them from here avoids an import cycle (projects.ts ->
// project-docker.ts -> projects.ts).

import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { projects, sessions } from "../db/schema.js";
import { LOCAL_HOST_ID } from "../services/host-registry.js";
import { DOCKER_STACK_SESSION_NAME_PREFIX } from "../shared/constants.js";
import { getStoredSettings } from "../services/settings.js";
import { createSessionRecord } from "../services/session-lifecycle.js";
import {
  getComposeServices,
  mapServicesToProject,
  composeContextFlags,
  pullComposeImageQuietly,
  inspectImageId,
  restartComposeService,
  stopComposeService,
  startComposeService,
  reconstructConfigHash,
  type ComposeService,
} from "../services/docker-service-detect.js";

// Issue #1182 — a generic keyed async mutex: calls for the SAME key run one
// at a time, in order; calls for different keys never wait on each other.
// Each key gets its own promise CHAIN, not a coalescing cache — a later
// call for a key waits for the earlier one to fully SETTLE before its own
// `fn` runs, rather than sharing the earlier call's result (a coalescing
// map, the shape git-status.ts/docker-service-detect.ts use elsewhere in
// this repo, would hand both callers the same result — wrong here, since
// startStackSession's second caller needs to see `reused: true`, not
// whatever the first caller got).
//
// A module-level export (rather than defined inline in projectsRoute's
// closure, where it originally lived) specifically so it's unit-testable
// with fully controlled promises — see test/routes/projects-docker.test.ts.
// The check-then-create race this exists to close (findActiveStackSession's
// select, then createSessionRecord's insert) is a single-microtask-wide
// window in a synchronous-SQLite codebase, which two `app.inject()` calls
// racing under `Promise.all` don't reliably land in — Hermes review, PR
// #1182: that HTTP-level test passed even with a reverted fix on one host,
// because the two requests never actually interleaved there. A direct test
// against this function needs no such luck.
//
// No timeout on a queued `fn()` — a caller stuck behind a hung `fn()` waits
// indefinitely. For `startStackSession`'s own use below, the unbounded wait
// is inherited from `listOwnedScopes`'s `systemctl --user list-units` spawn
// (session-process.ts), which has no timeout at all — `isMasterAlive`
// already depended on that being fast; this lock just makes a hang there
// block every OTHER stack action on the same compose project too, not only
// the one that triggered it. Deliberately not worked around here: racing a
// timeout against `fn()` and moving on while it's still running would let a
// second `fn()` start before the first's insert completes — reopening the
// exact race this lock exists to close, just narrowed to the rare hang case
// instead of closed. The correct fix is a timeout in `listOwnedScopes`
// itself, which resolves for every caller of isMasterAliveState/
// isMasterAliveStateBatch/isMasterAliveBatch, not just this one — landed in
// issue #1232. That fix
// converts a hang into a fast, confident "unknown," which is exactly what
// findActiveStackSession/startStackSession below now consult via
// `app.pty.isMasterAliveState` rather than the single-id `isMasterAlive`
// boolean that existed at the time (removed, issue #1265) — that function's
// own `?? false` posture would otherwise have folded a merely-slow D-Bus
// round trip into the same branch as a session that's actually dead.
export function createKeyedLock(): <T>(key: string, fn: () => Promise<T>) => Promise<T> {
  const locks = new Map<string, Promise<unknown>>();
  return function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    // `previous` is always this same function's own `tail` below, which is
    // built to never reject — so `fn` only ever runs as the onFulfilled
    // handler here, never as onRejected.
    const run = previous.then(fn);
    // Swallow so a failed run doesn't become an unhandled rejection via the
    // map entry alone — the caller's own `run` promise still rejects.
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    locks.set(key, tail);
    tail.finally(() => {
      if (locks.get(key) === tail) locks.delete(key);
    });
    return run;
  };
}

// Issue #73 — every registered local-host project's cwd, used to decide
// which project "owns" a discovered Compose service when project
// directories nest (see docker-service-detect.ts's mapServicesToProject
// doc comment for why the full list is needed rather than just the one
// project's own cwd).
export function localProjectCwds(app: FastifyInstance): string[] {
  return app.db
    .select({ cwd: projects.cwd })
    .from(projects)
    .where(eq(projects.hostId, LOCAL_HOST_ID))
    .all()
    .map((row) => row.cwd);
}

// Issue #73 — this project's own discovered Compose services (never
// called for a non-local project). Shared by the dock route in
// projects.ts and the docker/check-update + docker/update routes here,
// so the discovery pass, project-ownership mapping, and dedupe logic
// all live in exactly one place.
export async function discoveredServicesForProject(
  app: FastifyInstance,
  project: { cwd: string },
): Promise<ComposeService[]> {
  const all = await getComposeServices();
  return mapServicesToProject(all, project.cwd, localProjectCwds(app));
}

export async function projectDockerRoute(app: FastifyInstance): Promise<void> {
  // Issue #73 — resolves `controlId` (the "docker:<project>:<service>" id
  // toDockControls() synthesizes) against THIS project's own discovery
  // result. This lookup is both the authorization boundary (you cannot
  // touch a stack that isn't linked to this project — a stale/foreign id
  // 404s) and the injection guard for the two routes below: neither ever
  // builds a docker/shell argument from the request body itself, only from
  // the matched ComposeService's own fields.
  //
  // Also enforces settings.dock.dockerServices here (Hermes review) rather
  // than only gating the GET .../dock merge: that GET route's own check was
  // documented as a "visibility kill-switch", but leaving these two POST
  // routes reachable by a still-valid controlId while the setting is off
  // made it something less than that in practice. Checking it here — the
  // one place both POST routes fall through — makes it a real kill-switch
  // for defense in depth, at the cost of no extra plumbing per route.
  async function resolveOwnedService(
    project: { cwd: string },
    controlId: unknown,
  ): Promise<ComposeService | null> {
    if (typeof controlId !== "string") return null;
    if (!getStoredSettings(app.db).dock.dockerServices) return null;
    const services = await discoveredServicesForProject(app, project);
    return services.find((s) => `docker:${s.composeProject}:${s.service}` === controlId) ?? null;
  }

  interface DockerControlBody {
    controlId: string;
  }

  // Shared by both POST .../docker/* routes below — without this, a POST
  // with no body (or the wrong shape) dereferences `request.body.controlId`
  // on `undefined` and 500s, unlike every other mutating route in this repo
  // (e.g. sessions.ts's createSessionSchema), which gets a clean 400 from an
  // explicit schema instead. resolveOwnedService's own `typeof controlId !==
  // "string"` guard only covers a wrong-TYPED field already past this gate.
  const dockerControlSchema = {
    body: {
      type: "object",
      required: ["controlId"],
      additionalProperties: false,
      properties: {
        controlId: { type: "string", minLength: 1 },
      },
    },
  } as const;

  // Runs a quiet `docker compose pull` for one service and compares the
  // resulting local image id against the currently-running container's own
  // `com.docker.compose.image` label — catches both "a new image exists
  // upstream" and "a newer image was already pulled but the container was
  // never recreated." Deliberately not the issue's literal
  // before/after-pull-digest diff (see the plan's rationale). A pull
  // failure (private registry, no image at all) is a 200 with
  // reason:"pull-failed", never a 5xx — "can't check" isn't a server error.
  app.post<{ Params: { id: string }; Body: DockerControlBody }>(
    "/api/projects/:id/docker/check-update",
    { schema: dockerControlSchema, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");

      const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
      if (!project) return reply.notFound();
      if (project.hostId !== LOCAL_HOST_ID) {
        return reply.badRequest("Docker service management is only available for local projects");
      }

      const service = await resolveOwnedService(project, request.body.controlId);
      if (!service) return reply.notFound();

      if (!service.pullable) {
        return { updateAvailable: false, reason: "build-only" as const };
      }

      const pulled = await pullComposeImageQuietly(service);
      if (!pulled) {
        return { updateAvailable: false, reason: "pull-failed" as const };
      }

      const latestImageId = await inspectImageId(service.imageRef);
      if (!latestImageId) {
        return { updateAvailable: false, reason: "pull-failed" as const };
      }

      return {
        updateAvailable: latestImageId !== service.imageId,
        currentImageId: service.imageId,
        latestImageId,
        imageRef: service.imageRef,
        checkedAt: new Date().toISOString(),
      };
    },
  );

  // Kicks off `docker compose pull && docker compose up -d` for the WHOLE
  // stack (not just the one service — per the issue, so the stack isn't
  // left internally inconsistent) as a `kind: "dock"` session, rather than
  // running it inline and blocking the response. A multi-minute `up -d`
  // behind a reverse proxy (this repo's own deploy/ Traefik config included)
  // would otherwise hit a proxy idle timeout while the command kept
  // running, leaving the user to retry and race the first invocation. The
  // response echoes back a synthesized, EPHEMERAL DockControl for the new
  // session — this control is never emitted by GET .../dock — because its
  // command is deliberately distinct from the service's own logs command
  // (so Dock.tsx's command-based session matching can't confuse an update
  // run with a log stream), which means no control from the normal list
  // would ever match the session the frontend just created. The frontend
  // prepends this control to its local list so the new session renders
  // through the ordinary monitor body.
  app.post<{ Params: { id: string }; Body: DockerControlBody }>(
    "/api/projects/:id/docker/update",
    { schema: dockerControlSchema, config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");

      const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
      if (!project) return reply.notFound();
      if (project.hostId !== LOCAL_HOST_ID) {
        return reply.badRequest("Docker service management is only available for local projects");
      }

      const service = await resolveOwnedService(project, request.body.controlId);
      if (!service) return reply.notFound();
      if (!service.pullable) {
        return reply.badRequest("This service has no registry image to pull");
      }

      // composeContextFlags reconstructs the stack's own recorded -f/--env-file
      // list — without it this resolves whatever default-named compose file
      // sits in workingDir instead of the file(s) the stack was actually
      // `up`ed with (verified live: a bare -p/--project-directory invocation
      // for a stack started with `-f docker-compose.prod.yml` instead
      // resolves an unrelated dev docker-compose.yml next to it), and never
      // auto-loads a compose.override.yaml either way.
      const projectFlag = composeContextFlags(service);
      const command = `docker compose ${projectFlag} pull && docker compose ${projectFlag} up -d`;

      // Routed through the same startStackSession the 4 stack-wide routes
      // below use (this route predates that table-driven refactor, hence
      // living up here on its own) — this is a stack-wide action exactly
      // like those four, sharing the same "one operation at a time per
      // stack" identity concern: a "Restart stack" clicked mid-pull would
      // otherwise fire a second, concurrent `docker compose` invocation
      // against the same stack, command-matching having no way to catch it
      // since every one of the five actions has a different command.
      const started = await startStackSession(
        projectId,
        service,
        "docker-update",
        `Update ${service.composeProject}`,
        command,
      );
      if (!started.ok) {
        return reply.badGateway("Failed to start the update session");
      }

      const { sessionId, control, reused } = started;
      return reply
        .code(201)
        .send({ sessionId, control, reused, willRecreate: await willRecreateOnApply(service) });
    },
  );

  // Whether an action that runs `up -d` (this route's own pull-restart,
  // plus stack/apply and stack/rebuild below) would RECREATE the
  // container(s) — the on-disk compose config no longer matches what the
  // running container was actually created from, so `up -d` would replace
  // it rather than leave it untouched. Advisory only, never a guard: `null`
  // ("couldn't tell" — compose file missing, docker unreachable, no
  // recorded hash to compare against, …) and `true` both let the caller
  // proceed, just with different confirm-label wording on the frontend
  // (issue #73 follow-up plan's "surface it in the arm-confirm label rather
  // than blocking").
  async function willRecreateOnApply(service: ComposeService): Promise<boolean | null> {
    // Hermes review — parsePsOutput defaults a missing config-hash label to
    // "", and an empty string trivially `!==` any real hash, so a container
    // predating this label (or whose docker/compose version never sets it)
    // would otherwise always report willRecreate:true even with an
    // unchanged config. Treat "nothing recorded" the same as "couldn't
    // recompute" — both are "can't tell," not "yes."
    if (service.configHash === "") return null;
    const currentHash = await reconstructConfigHash(service);
    if (currentHash === null) return null;
    return currentHash !== service.configHash;
  }

  // A stack-wide action's identity is the compose project it targets, not
  // the command it happens to run — five different actionIds (docker-
  // update/-restart/-apply/-rebuild/-stop, dockHelpers.ts's own
  // composeProjectForControl list on the frontend) can each spawn a `docker
  // compose` invocation against the SAME stack, and two of those running
  // concurrently would leave it internally inconsistent (the exact
  // "don't leave the stack half-applied" reasoning the stack-wide routes
  // below already use to justify running the whole stack rather than one
  // service). `nameLocked` matches the frontend's own convention for a
  // stable session identity (Dock.tsx's dockIdentity/identityOpts).
  function stackSessionName(composeProject: string): string {
    return `${DOCKER_STACK_SESSION_NAME_PREFIX}${composeProject}`;
  }

  // Issue #1182 — findActiveStackSession's check + createSessionRecord's
  // create are two separate `await`s with nothing between them stopping a
  // second, genuinely concurrent request for the SAME stack from also
  // seeing "no active session" and also inserting one. `createKeyedLock`
  // (module scope, above `projectsRoute`) is the actual mutex; see its own
  // doc comment for the full design rationale, including why it's a module
  // -level export rather than defined inline here. Keyed by
  // `${projectId}:${composeProject}` — same identity stackSessionName()
  // already uses. Called fresh per `projectsRoute(app)` invocation (not
  // hoisted to module scope itself) so its internal Map doesn't leak
  // entries across `buildApp()` instances sharing a `projectId` value, e.g.
  // in tests.
  //
  // Per-process only: two backend processes against the same SQLite file
  // would still race THIS mutex — it's an in-memory Map, so it has no
  // visibility across processes. #1182's original conclusion was that a
  // DB-level unique constraint "can't fix this cleanly" for that case
  // either, because findActiveStackSession isn't a pure DB check — it also
  // requires `isMasterAlive` (see its own comment above), since
  // `sessions.status` records intent, not live process state. A NAIVE
  // constraint would reject the legitimate, common case of a finished
  // action whose row hasn't yet been reconciled (session-reconciler.ts's
  // sweep lags 5s-1h) — exactly the case findActiveStackSession's own
  // liveness check exists to tolerate.
  //
  // Issue #1223 overturns that "can't fix this cleanly" conclusion by
  // making the constraint TOLERANT instead of naive:
  // `sessions_stack_identity_unique` (schema.ts) is a real DB-level unique
  // index, but a violation is not treated as "the existing row wins" —
  // `createSessionRecord` surfaces it as a `reason: "unique-conflict"`
  // result instead of letting the raw constraint error propagate, and
  // `startStackSession` below reconciles it with the SAME liveness check
  // findActiveStackSession already trusts: if the conflicting row's process
  // is actually dead, flip it to `exited` and retry the insert once; only
  // if it's genuinely still alive does the caller get a reused session.
  // That reconcile-then-retry step is what closes the gap this mutex can't
  // — a second backend process (still not a supported configuration
  // today; `deriveInstanceId` namespaces an instance by its own
  // `sessionsDir`, which is where the DB lives — but this is now
  // defense-in-depth for that shape), or any future `kind: "dock"` insert
  // that bypasses `withStackLock` entirely.
  //
  // A single process hits this reconcile path too, and routinely, not just
  // in the cross-process case above: findActiveStackSession's own
  // isMasterAlive check is read-only, so the moment it decides a row is
  // dead it does NOT flip that row's status — the row stays `active` in
  // the DB until either session-reconciler.ts's own sweep gets to it or
  // THIS reconcile-then-retry does. So any restart request landing in that
  // same 5s-1h reconciler-lag window `findActiveStackSession`'s own comment
  // already describes will hit `unique-conflict` on its very next insert,
  // with zero concurrency involved at all — see startStackSession's own
  // comment at its `unique-conflict` branch below.
  const withStackLock = createKeyedLock();

  async function findActiveStackSession(projectId: number, composeProject: string) {
    const [existing] = app.db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.projectId, projectId),
          eq(sessions.kind, "dock"),
          eq(sessions.status, "active"),
          eq(sessions.name, stackSessionName(composeProject)),
        ),
      )
      .all();
    if (!existing) return null;
    // AGENTS.md's own invariant — `sessions.status` records INTENT, not live
    // process state; a `docker compose` process that finished on its own
    // (the common case: the action simply completed) isn't reflected there
    // until session-reconciler.ts's own periodic sweep next runs, which can
    // lag by up to its configured interval (5s-1h, settings.ts). Trusting
    // `status: "active"` alone here would silently redirect a genuinely new
    // action onto a dead session for that whole window (Hermes review).
    //
    // `app.pty.get(id)?.isAlive` (a bare in-memory Map lookup, no reattach)
    // was tried here first and is WRONG — caught in review: PtyManager's own
    // map starts EMPTY on every process boot (plugins/pty.ts constructs it
    // fresh) and killAll() (the onClose shutdown hook, i.e. every redeploy)
    // clears it entirely while the session's real systemd scope + dtach
    // master survive underneath (AGENTS.md's own session-model invariant).
    // So right after any redeploy, a bare `.get()` would report EVERY
    // pre-existing session as not-alive — the opposite failure mode from
    // the one this whole check exists to close, and with unbounded blast
    // radius for anything (like a background stack-action session) with no
    // client re-attaching to force a reattach. `isMasterAlive` is the
    // primitive session-reconciler.ts already uses for exactly this reason
    // — it queries the systemd scope directly, deliberately independent of
    // anything tracked in this process's own memory (see its own doc
    // comment, session-process.ts), so it's correct immediately after a
    // restart too, not just mid-process.
    //
    // Issue #1232 — `isMasterAliveState`, not plain `isMasterAlive`: a
    // merely-slow or momentarily-failing listing ("unknown") is treated as
    // LIVE here, never dead. Over-trusting a stale row in that case costs at
    // most a second `docker compose` invocation racing a session that
    // already finished — annoying, not destructive. The opposite mistake
    // (treating a genuinely live stack session as dead) feeds
    // startStackSession's own mark-exited-and-recreate branch below, which
    // permanently orphans the still-running scope (session-reconciler.ts
    // never revisits a row once it leaves `status: "active"`).
    const state = await app.pty.isMasterAliveState(String(existing.id));
    return state === "dead" ? null : existing;
  }

  // Shared by every stack-wide lifecycle route below (restart/apply/
  // rebuild/stop/update) — same "spawn a kind:dock session, echo an
  // ephemeral control" shape, so a multi-minute compose operation streams
  // its own output instead of blocking the request or risking a
  // reverse-proxy idle timeout. Refuses to start a SECOND concurrent
  // operation on the same stack (rather than letting a "Restart" clicked
  // mid-rebuild fire a second `docker compose` invocation against it) —
  // `reused: true` on the response tells the caller nothing new actually
  // started, so it can surface that instead of treating this as a fresh
  // action (Dock.tsx's handleStackAction).
  async function startStackSession(
    projectId: number,
    service: ComposeService,
    actionId: string,
    title: string,
    command: string,
  ): Promise<
    | {
        ok: true;
        sessionId: number;
        control: {
          id: string;
          title: string;
          command: string;
          source: "docker";
          composeProject: string;
        };
        reused?: boolean;
      }
    | { ok: false }
  > {
    const control = {
      id: `${actionId}:${service.composeProject}`,
      title,
      command,
      source: "docker" as const,
      // Issue #1112 — a real field instead of making every caller parse it
      // back out of `id` against a hand-synced prefix list
      // (EPHEMERAL_STACK_ACTION_PREFIXES, dockHelpers.ts). Also what makes
      // the dock log-streaming resize fix's own reconstruction possible: a
      // control rebuilt from a live `docker-stack:<composeProject>` session
      // (Dock.tsx, after a workspace switch loses the POST response's
      // optimistic control) has no `actionId` to parse from an id it never
      // had, but it always knows its own compose project directly from the
      // session name.
      composeProject: service.composeProject,
    };

    // Issue #1182 — see createKeyedLock's own comment. The check-then
    // -create below has to run as a single unit per (projectId,
    // composeProject) — otherwise two concurrent callers of THIS function
    // can both observe "no active session" and both insert one. Scoped to
    // this one call path, not every possible way a `docker-stack:
    // <composeProject>` session could get created — Hermes review caught
    // that `POST /api/sessions/:id/promote` (sessions.ts) creates a
    // replacement session carrying the source's own `name` forward with no
    // kind/name guard at all, entirely outside this lock; fixed as issue
    // #1233 by rejecting promote outright for any `kind: "dock"` source,
    // rather than folding it into this lock (different route, its own
    // review surface).
    //
    // The lock is held across the WHOLE call below, including
    // createSessionRecord's actual process spawn (systemd-run) — not just
    // the DB read/write. Deliberate: a second request arriving mid-spawn
    // waits for the spawn to finish before it can even re-check, rather
    // than returning promptly off a not-yet-existing row, but the
    // alternative (release the lock right after the insert, before the
    // spawn) reopens a narrower version of the exact race this closes — a
    // third request between "row inserted" and "spawn confirmed" could
    // still see the row as active but not yet a going process.
    return withStackLock(`${projectId}:${service.composeProject}`, async () => {
      const existing = await findActiveStackSession(projectId, service.composeProject);
      if (existing) {
        // `control` here still describes the just-REQUESTED action (title/
        // command), not necessarily whatever the reused session was actually
        // started with. Hermes review — Dock.tsx doesn't attach anything by
        // `sessionId` for a stack-wide action (only ephemeral controls,
        // matched by command string), so this mismatch isn't just cosmetic:
        // the frontend's own handler (handlePullAndRestart/
        // handleRebuildAndRestart/handleStackAction) checks `reused` FIRST
        // and skips adding this control entirely, surfacing a status message
        // instead — see those handlers' own comments. `control` is still
        // returned (not omitted) for a caller that hasn't been updated to
        // check `reused` first, so it degrades to the same "wrong label,
        // right session" behavior this comment used to claim was the whole
        // story.
        return { ok: true, sessionId: existing.id, control, reused: true };
      }

      const sessionParams = {
        projectId,
        command,
        kind: "dock" as const,
        name: stackSessionName(service.composeProject),
        nameLocked: true,
      };
      const result = await createSessionRecord(app, sessionParams);
      if (result.ok) return { ok: true, sessionId: result.row.id, control };
      if (result.reason !== "unique-conflict") return { ok: false };

      // Issue #1223 — createSessionRecord hit sessions_stack_identity_unique.
      // This is NOT just a rare cross-process edge case — it's the ROUTINE
      // path any time this stack's previous session died since the last
      // session-reconciler.ts sweep (5s-1h lag): findActiveStackSession
      // just above already called isMasterAlive and saw the row was dead,
      // but it never WRITES anything (it's read-only, by design — see its
      // own comment), so the stale row is still `status: "active"` in the
      // DB the moment this insert runs, and collides with it. A second
      // backend process (or a future `kind: "dock"` insert bypassing
      // withStackLock) can ALSO land here, but is not the common case.
      // findActiveStackSession is the wrong primitive to reach for again
      // here: it collapses both "no row" and "dead-process row" to `null`,
      // giving no handle on the actual conflicting row to reconcile.
      // Select it directly instead.
      const [conflictingRow] = app.db
        .select()
        .from(sessions)
        .where(
          and(
            eq(sessions.projectId, projectId),
            eq(sessions.name, sessionParams.name),
            eq(sessions.kind, "dock"),
            eq(sessions.status, "active"),
          ),
        )
        .all();

      // Same primitive findActiveStackSession already trusts for this
      // identity. Issue #1232 — three-way, not a boolean: an "unknown"
      // answer (the listing timed out, or couldn't confirm ownership) must
      // NOT fall through to the mark-exited-and-recreate branch below —
      // that would permanently orphan a scope that's actually still
      // running, since session-reconciler.ts never revisits a row once it
      // leaves `status: "active"`. Bail out with no DB write instead; both
      // callers of startStackSession already map `!ok` to a plain 502, so
      // this surfaces as an honest, retryable failure rather than data
      // loss. `!conflictingRow` (vanished between the select above and
      // here, e.g. a concurrent reconciler pass already flipped it) skips
      // this whole block and falls straight to the retry below, same as
      // before this issue.
      if (conflictingRow) {
        const conflictState = await app.pty.isMasterAliveState(String(conflictingRow.id));
        if (conflictState === "alive") {
          return { ok: true, sessionId: conflictingRow.id, control, reused: true };
        }
        if (conflictState === "unknown") {
          return { ok: false };
        }
        // Confirmed dead — flip it, CAS'd exactly like session-reconciler.ts's
        // own sweep, so a concurrent reconciler pass touching the same row
        // can't race this update.
        app.db
          .update(sessions)
          .set({ status: "exited" })
          .where(and(eq(sessions.id, conflictingRow.id), eq(sessions.status, "active")))
          .run();
      }

      // Retry once. If this ALSO hits unique-conflict, some other actor won
      // an exceedingly rare double-race — give up rather than loop.
      const retried = await createSessionRecord(app, sessionParams);
      if (!retried.ok) return { ok: false };
      return { ok: true, sessionId: retried.row.id, control };
    });
  }

  // Per-service, inline lifecycle actions (restart/stop/start) — bounded
  // compose operations (SERVICE_ACTION_TIMEOUT_MS in
  // docker-service-detect.ts), so unlike the stack-wide actions below they
  // run synchronously and return their own result rather than spawning a
  // session. Force-refreshes the discovery cache on success so the very
  // next `GET .../dock` poll reflects the new state instead of serving up
  // to CACHE_TTL_MS of staleness.
  const dockerServiceActionRoutes: Array<{
    path: string;
    run: (service: ComposeService) => Promise<boolean>;
  }> = [
    { path: "/api/projects/:id/docker/service/restart", run: restartComposeService },
    { path: "/api/projects/:id/docker/service/stop", run: stopComposeService },
    { path: "/api/projects/:id/docker/service/start", run: startComposeService },
  ];
  for (const { path, run } of dockerServiceActionRoutes) {
    app.post<{ Params: { id: string }; Body: DockerControlBody }>(
      path,
      { schema: dockerControlSchema, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
      async (request, reply) => {
        const projectId = Number(request.params.id);
        if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");

        const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
        if (!project) return reply.notFound();
        if (project.hostId !== LOCAL_HOST_ID) {
          return reply.badRequest("Docker service management is only available for local projects");
        }

        const service = await resolveOwnedService(project, request.body.controlId);
        if (!service) return reply.notFound();

        const success = await run(service);
        if (success) await getComposeServices(true);
        return { success };
      },
    );
  }

  // Stack-wide lifecycle actions — each restarts/rebuilds/stops the WHOLE
  // compose stack (not just the one service the controlId names), same
  // "don't leave the stack internally inconsistent" reasoning as the
  // existing pull-restart route above. Deliberately no `down`: it removes
  // the containers entirely, so the service would drop out of `docker ps
  // -a`, discovery would stop finding it, and the Dock control would
  // vanish with no UI path back — `stop` covers "I want this off" while
  // leaving a way back on.
  //
  // Table-driven (Hermes review) — the 4 routes previously repeated the
  // same project-lookup/local-host/resolveOwnedService prologue verbatim;
  // since that prologue IS the authz/injection guard, keeping it in one
  // loop body means a future hardening change can't accidentally miss one
  // of the copies.
  interface StackActionSpec {
    path: string;
    actionId: string;
    // Human word for the badGateway error message below — actionId is a
    // control-id prefix (e.g. "docker-rebuild"), not prose a user should see.
    verb: string;
    title: (composeProject: string) => string;
    buildCommand: (service: ComposeService) => string;
    // Returns a 400 message when the action doesn't apply to this service
    // (only `rebuild` uses this — the buildable mirror-guard of the
    // existing pull-restart route above).
    guard?: (service: ComposeService) => string | null;
    // Only an action that runs `up -d` needs the recreate precondition.
    reportWillRecreate?: boolean;
  }

  const stackActionRoutes: StackActionSpec[] = [
    {
      path: "/api/projects/:id/docker/stack/restart",
      actionId: "docker-restart",
      verb: "restart",
      title: (p) => `Restart ${p}`,
      buildCommand: (s) => `docker compose ${composeContextFlags(s)} restart`,
    },
    {
      path: "/api/projects/:id/docker/stack/apply",
      actionId: "docker-apply",
      verb: "apply",
      title: (p) => `Apply config ${p}`,
      buildCommand: (s) => `docker compose ${composeContextFlags(s)} up -d`,
      reportWillRecreate: true,
    },
    {
      path: "/api/projects/:id/docker/stack/rebuild",
      actionId: "docker-rebuild",
      verb: "rebuild",
      title: (p) => `Rebuild ${p}`,
      buildCommand: (s) => {
        const flags = composeContextFlags(s);
        return `docker compose ${flags} build --pull && docker compose ${flags} up -d`;
      },
      // The `build:`-only counterpart to the existing pull-restart route
      // above — gated on `buildable` (issue #1243), not the inverse of
      // `pullable`: a service can be BOTH (a `build:` key next to a real
      // registry image), in which case both this route and the pull-restart
      // route above must accept it. Only a service with no `build:` key at
      // all is rejected here.
      guard: (s) =>
        s.buildable ? null : "This service has a registry image — use Pull & restart instead",
      reportWillRecreate: true,
    },
    {
      path: "/api/projects/:id/docker/stack/stop",
      actionId: "docker-stop",
      verb: "stop",
      title: (p) => `Stop ${p}`,
      buildCommand: (s) => `docker compose ${composeContextFlags(s)} stop`,
    },
  ];

  for (const spec of stackActionRoutes) {
    app.post<{ Params: { id: string }; Body: DockerControlBody }>(
      spec.path,
      { schema: dockerControlSchema, config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
      async (request, reply) => {
        const projectId = Number(request.params.id);
        if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");

        const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
        if (!project) return reply.notFound();
        if (project.hostId !== LOCAL_HOST_ID) {
          return reply.badRequest("Docker service management is only available for local projects");
        }

        const service = await resolveOwnedService(project, request.body.controlId);
        if (!service) return reply.notFound();

        const guardError = spec.guard?.(service);
        if (guardError) return reply.badRequest(guardError);

        const command = spec.buildCommand(service);
        const started = await startStackSession(
          projectId,
          service,
          spec.actionId,
          spec.title(service.composeProject),
          command,
        );
        if (!started.ok) return reply.badGateway(`Failed to start the ${spec.verb} session`);
        // Destructured rather than `send(started)`/`{ ...started }`
        // (Hermes review) — `started` also carries the internal
        // discriminant `ok: true`, which has no business on the wire.
        const { sessionId, control, reused } = started;
        if (!spec.reportWillRecreate) return reply.code(201).send({ sessionId, control, reused });
        // Ordering here is incidental, not load-bearing: the session (and
        // its `up -d`/build) has already been spawned by the time this
        // reads the on-disk config, so it's a best-effort snapshot that the
        // just-started command may itself change moments later — same
        // "advisory, not a guarantee" contract documented on
        // willRecreateOnApply above. What actually matters is only that
        // this resolves before the reply is sent, so the client gets a
        // value instead of a promise.
        return reply
          .code(201)
          .send({ sessionId, control, reused, willRecreate: await willRecreateOnApply(service) });
      },
    );
  }
}
