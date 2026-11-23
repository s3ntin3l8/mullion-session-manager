// MCP tools for an agent session's own project's dock controls (#2494, #3049).
// A factory so it can borrow tools.mjs's wait-argument normaliser without a
// circular import.
export function createDockTools({ normalizeWaitArgs }) {
  const startDockSession = {
    name: "start_dock_session",
    description:
      "Start one of a project's dock controls (e.g. the dev server) — see list_dock_controls for " +
      "ids. From an agent session this works for your OWN project only (omit projectId); pass " +
      "branch to run it on that branch in a preview worktree, or host to run it on another host the " +
      "project has a checkout on (e.g. a Mac agent). Docker-discovered controls need " +
      "full scope (MULLION_AUTH_TOKEN).",
    inputSchema: {
      type: "object",
      required: ["dockControlId"],
      properties: {
        projectId: {
          type: "string",
          description: "The project (full scope; defaults to your own project in a session).",
        },
        dockControlId: {
          type: "string",
          description: "The dock control's id (list_dock_controls).",
        },
        branch: { type: "string", description: "Optional branch to run the control on." },
        host: {
          type: "string",
          description:
            "Optional host id to run the control on. The project needs a checkout there; omitted, it runs where the project is placed.",
        },
      },
    },
    async handler(args, client) {
      const result = await client.startDockSession(
        args?.projectId,
        args?.dockControlId,
        args?.branch,
        args?.host,
      );
      return JSON.stringify(result);
    },
  };

  const listDockControls = {
    name: "list_dock_controls",
    description:
      "List your project's dock controls (id, title, command, port) and, for each, the running " +
      "session if any. Use the ids with start_dock_session / stop_dock_session.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: {
          type: "string",
          description: "The project (full scope; defaults to your own project in a session).",
        },
      },
    },
    async handler(args, client) {
      return JSON.stringify(await client.listDockControls(args?.projectId));
    },
  };

  const projectIdProp = {
    type: "string",
    description: "The project (full scope; defaults to your own project in a session).",
  };

  const getDockLogs = {
    name: "get_dock_logs",
    description:
      "The terminal screen of one of your project's running dock controls (e.g. the dev server) as " +
      "plain text. 404 if the control is not running — see list_dock_controls.",
    inputSchema: {
      type: "object",
      required: ["dockControlId"],
      properties: { projectId: projectIdProp, dockControlId: { type: "string" } },
    },
    async handler(args, client) {
      return JSON.stringify(await client.dockLogs(args?.projectId, args?.dockControlId));
    },
  };

  const waitForDockOutput = {
    name: "wait_for_dock_output",
    description:
      "Block (server-side) until a running dock control prints `match` (literal, or regex:true), " +
      "or the timeout (default 50s; on timedOut:true call it again). Same result shape and matching " +
      "rules as wait_for_output, but for your own project's dock control instead of a child session.",
    inputSchema: {
      type: "object",
      required: ["dockControlId", "match"],
      properties: {
        projectId: projectIdProp,
        dockControlId: { type: "string" },
        match: { type: "string", description: "Text to wait for (max 256 chars)." },
        regex: { type: "boolean" },
        afterOffset: { type: "number", description: "An earlier outputOffset to start from." },
        timeoutSeconds: { type: "number", description: "Max seconds to wait (default 50)." },
      },
    },
    async handler(args, client) {
      if (typeof args?.dockControlId !== "string" || args.dockControlId.length === 0) {
        throw new Error("dockControlId is required");
      }
      if (typeof args.match !== "string" || args.match.length === 0) {
        throw new Error("match is required");
      }
      const { timeoutMs } = normalizeWaitArgs(args);
      const result = await client.waitForDockOutput({
        projectId: args.projectId,
        dockControlId: args.dockControlId,
        match: args.match,
        regex: args.regex,
        timeoutMs,
        afterOffset: args.afterOffset,
      });
      return JSON.stringify(result);
    },
  };

  const switchDockBranch = {
    name: "switch_dock_branch",
    description:
      "Restart one of your project's dock controls on another branch (`branch`, run in a preview " +
      "worktree) or in an existing worktree (`worktreePath`: the project checkout, a directory " +
      "inside it, or one of its git worktrees). Stops the running control first (a control that is " +
      "not running is just started there); a bad target is refused before anything stops. " +
      "list_dock_controls shows where it runs now.",
    inputSchema: {
      type: "object",
      required: ["dockControlId"],
      properties: {
        projectId: projectIdProp,
        dockControlId: { type: "string" },
        branch: { type: "string" },
        worktreePath: { type: "string" },
        host: {
          type: "string",
          description:
            "Optional host id to restart the control on (the project needs a checkout there).",
        },
      },
    },
    async handler(args, client) {
      const result = await client.switchDockControl(args?.projectId, args?.dockControlId, {
        branch: args?.branch,
        worktreePath: args?.worktreePath,
        host: args?.host,
      });
      return JSON.stringify(result);
    },
  };

  const stopDockSession = {
    name: "stop_dock_session",
    description:
      "Stop a dock control by dockControlId (your own project's, from list_dock_controls) — " +
      "works from an agent session. Passing a raw sessionId instead kills any session by id and " +
      "needs full scope (MULLION_AUTH_TOKEN).",
    inputSchema: {
      type: "object",
      properties: {
        dockControlId: { type: "string", description: "The dock control to stop." },
        projectId: {
          type: "string",
          description: "The project (full scope; defaults to your own project in a session).",
        },
        sessionId: { type: "string", description: "Full scope only: a session id to kill." },
      },
    },
    async handler(args, client) {
      if (args?.dockControlId === undefined && args?.sessionId === undefined) {
        throw new Error("pass dockControlId (or, with full scope, sessionId)");
      }
      const result = await client.stopDockSession(args?.sessionId, {
        projectId: args?.projectId,
        dockControlId: args?.dockControlId,
      });
      return JSON.stringify(result);
    },
  };

  return {
    startDockSession,
    listDockControls,
    getDockLogs,
    waitForDockOutput,
    switchDockBranch,
    stopDockSession,
  };
}
