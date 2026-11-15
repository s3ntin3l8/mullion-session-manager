// MCP tools for an agent session's own project's dock config (#3050).
const projectIdProp = {
  type: "string",
  description: "The project (full scope; defaults to your own project in a session).",
};

export const getDockConfig = {
  name: "get_dock_config",
  description:
    "Your project's dock config: the raw `.crs/dock.json` ({controls, invalid, reason}) behind " +
    "Settings → Dock. Read it before set_dock_config.",
  inputSchema: { type: "object", properties: { projectId: projectIdProp } },
  async handler(args, client) {
    return JSON.stringify(await client.getDockConfig(args?.projectId));
  },
};

export const setDockConfig = {
  name: "set_dock_config",
  description:
    "Edit your project's dock config: `.crs/dock.json` in the project's checkout on your host, the " +
    "file the dock itself reads (if you work in a separate git worktree, it is NOT inside that " +
    "worktree, so it will not appear in your worktree's diff). Pass exactly one of: `upsert` (one control object with an id — added, or replaced " +
    "if the id exists), `remove` (a control id), or `controls` (the whole list, replacing it). " +
    "Control fields: id, title, command, cwd, height, env, worktreeRefresh, port, preview. " +
    "Validated exactly like the Settings editor; upsert/remove keep the user's other controls.",
  inputSchema: {
    type: "object",
    properties: {
      projectId: projectIdProp,
      upsert: { type: "object", description: "One dock control (needs `id`)." },
      remove: { type: "string", description: "Id of the control to remove." },
      controls: { type: "array", items: { type: "object" }, description: "The whole list." },
    },
  },
  async handler(args, client) {
    const result = await client.setDockConfig(args?.projectId, {
      controls: args?.controls,
      upsert: args?.upsert,
      remove: args?.remove,
    });
    return JSON.stringify(result);
  },
};
