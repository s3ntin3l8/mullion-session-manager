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
      let host;
      for (let i = 0; i < rawArgs.length; i++) {
        if (rawArgs[i] !== "--branch" && rawArgs[i] !== "--host") {
          args.push(rawArgs[i]);
          continue;
        }
        const flag = rawArgs[i];
        const value = rawArgs[++i];
        if (value === undefined || value.startsWith("--")) {
          throw new CliUsageError(
            `${flag} needs ${flag === "--host" ? "a host id" : "a branch name"}`,
          );
        }
        if (flag === "--branch") {
          if (branch !== undefined) throw new CliUsageError("--branch given more than once");
          branch = value;
        } else {
          if (host !== undefined) throw new CliUsageError("--host given more than once");
          host = value;
        }
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
          ...(host !== undefined ? { hostId: host } : {}),
        });
        return { json: result };
      } catch (err) {
        if (
          err?.status !== 404 ||
          projectId === undefined ||
          branch !== undefined ||
          host !== undefined
        ) {
          throw err;
        }
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
    // `logs <controlId>` (own project) / `logs <projectId> <controlId>`.
    async logs(client, args) {
      const hasProject = args[1] !== undefined;
      const dockControlId = hasProject ? args[1] : requireOne(args, "dock control id");
      return {
        json: await client.request("docks.logs", {
          ...(hasProject ? { projectId: args[0] } : {}),
          dockControlId,
        }),
      };
    },
    // `switch [<projectId>] <controlId> <branch>` or `... --worktree <path>`, either with `--host <id>`.
    async switch(client, rawArgs) {
      const hostAt = rawArgs.indexOf("--host");
      if (
        hostAt !== -1 &&
        (rawArgs[hostAt + 1] === undefined || rawArgs[hostAt + 1].startsWith("--"))
      ) {
        throw new CliUsageError("--host needs a host id");
      }
      const host = hostAt === -1 ? undefined : rawArgs[hostAt + 1];
      const args =
        hostAt === -1 ? rawArgs : rawArgs.filter((_, i) => i !== hostAt && i !== hostAt + 1);
      const wt = args.indexOf("--worktree");
      const rest = wt === -1 ? [...args] : args.filter((_, i) => i !== wt && i !== wt + 1);
      const target = wt === -1 ? rest.pop() : args[wt + 1];
      if (rest.length === 0 || target === undefined) {
        throw new CliUsageError(
          "usage: dock switch [<projectId>] <controlId> <branch|--worktree <path>>",
        );
      }
      return {
        json: await client.request("docks.switch", {
          ...(rest.length > 1 ? { projectId: rest[0] } : {}),
          dockControlId: rest[rest.length - 1],
          ...(wt === -1 ? { branch: target } : { worktreePath: target }),
          ...(host !== undefined ? { hostId: host } : {}),
        }),
      };
    },
    // `config get [<projectId>]` / `config set [<projectId>] --upsert <json> | --remove <id> | --controls <json>`.
    async config(client, args) {
      const usage =
        "usage: dock config get [<projectId>] | set [<projectId>] --upsert <json> | --remove <id> | --controls <json>";
      const [action, ...rest] = args;
      // One optional projectId and (for set) exactly one flag with a value; anything else is refused.
      const positional = [];
      const flags = [];
      for (let i = 0; i < rest.length; i++) {
        if (!rest[i].startsWith("--")) {
          positional.push(rest[i]);
          continue;
        }
        if (rest[i + 1] === undefined || rest[i + 1].startsWith("--")) {
          throw new CliUsageError(`${rest[i]} needs a value`);
        }
        flags.push([rest[i], rest[++i]]);
      }
      if (positional.length > 1) throw new CliUsageError(usage);
      const body = positional[0] !== undefined ? { projectId: positional[0] } : {};
      if (action === "get") {
        if (flags.length > 0) throw new CliUsageError(usage);
        return { json: await client.request("projects.get_dock_config", body) };
      }
      if (action !== "set" || flags.length !== 1) throw new CliUsageError(usage);
      const [flag, value] = flags[0];
      if (flag === "--remove") body.remove = value;
      else if (flag === "--upsert" || flag === "--controls") {
        try {
          body[flag.slice(2)] = JSON.parse(value);
        } catch {
          throw new CliUsageError(`${flag} must be valid JSON`);
        }
      } else throw new CliUsageError(`unknown flag ${flag}`);
      return { json: await client.request("projects.set_dock_config", body) };
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
