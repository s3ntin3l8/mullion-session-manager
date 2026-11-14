// #2494 — `list`/`start`/`stop` go through the narrow `docks.*` ops, which an
// agent session may call for its OWN project: a lone control id means "my
// project's"; `<projectId> <controlId>` names the project (full scope).
// A docker-discovered control (and a raw session id) stays on the legacy
// full-scope path.
export function createDockCommands({ CliUsageError, requireOne }) {
  return {
    async list(client, args = []) {
      // No project: the caller's own (session scope); full scope has none (400),
      // so it keeps the old all-dock-sessions listing.
      if (args[0] === undefined) {
        return client.request("docks.list", {}).then(
          (json) => ({ json }),
          async (err) => {
            if (err?.status !== 400) throw err;
            return { json: await client.request("sessions.list", { kind: "dock" }) };
          },
        );
      }
      return { json: await client.request("docks.list", { projectId: args[0] }) };
    },
    async start(client, rawArgs) {
      // Split flags from positionals once: `--branch <name>` is not a project or control id.
      const args = [];
      let branch;
      for (let i = 0; i < rawArgs.length; i++) {
        if (rawArgs[i] !== "--branch") {
          args.push(rawArgs[i]);
          continue;
        }
        const value = rawArgs[++i];
        if (value === undefined || value.startsWith("--")) {
          throw new CliUsageError("--branch needs a branch name");
        }
        if (branch !== undefined) throw new CliUsageError("--branch given more than once");
        branch = value;
      }
      const hasProject = args[1] !== undefined;
      const projectId = hasProject ? args[0] : undefined;
      const dockId = hasProject ? args[1] : args[0];
      if (dockId === undefined) throw new CliUsageError("dock control id is required");
      try {
        const result = await client.request("docks.start", {
          ...(projectId !== undefined ? { projectId } : {}),
          dockControlId: dockId,
          ...(branch !== undefined ? { branch } : {}),
        });
        return { json: result };
      } catch (err) {
        if (err?.status !== 404 || projectId === undefined || branch !== undefined) throw err;
      }
      const controls = await client.request("projects.dock", { projectId });
      const control = controls.find((c) => c.id === dockId);
      if (!control) throw new CliUsageError(`no dock control '${dockId}' for project ${projectId}`);
      // A docker control is named by its stable containerName identity, not its
      // title/command (dockHelpers.ts's dockerSessionIdentity; issue #73, 5b).
      const identity = control.docker ? `docker-logs:${control.docker.containerName}` : null;
      const body = {
        projectId,
        command: control.command,
        kind: "dock",
        name: identity ?? control.title,
        ...(identity ? { nameLocked: true } : {}),
      };
      if (control.cwd !== undefined) body.cwd = control.cwd;
      if (control.worktreeRefresh !== undefined) body.worktreeRefresh = control.worktreeRefresh;
      if (control.env !== undefined) body.env = control.env;
      const result = await client.request("sessions.create", body);
      return { json: result };
    },
    async stop(client, args) {
      // `stop <controlId> --control` (own project) / `stop <projectId> <controlId>`,
      // else a raw session id (full scope).
      if (args.includes("--control")) {
        const dockControlId = args.find((a) => a !== "--control");
        if (dockControlId === undefined) throw new CliUsageError("dock control id is required");
        return { json: await client.request("docks.stop", { dockControlId }) };
      }
      if (args[1] !== undefined) {
        return {
          json: await client.request("docks.stop", { projectId: args[0], dockControlId: args[1] }),
        };
      }
      const sessionId = requireOne(args, "session id");
      const result = await client.request("sessions.kill", { sessionId });
      return { json: result };
    },
  };
}
