// MCP tools for an agent session's own project's setup recipe (#3592).
const projectIdProp = {
  type: "string",
  description: "The project (full scope; defaults to your own project in a session).",
};

export const getSetupRecipe = {
  name: "get_setup_recipe",
  description:
    "Your project's setup recipe ({projectId, setupRecipe}): the shell command (`sh -c`) Mullion " +
    "runs to install dependencies in a fresh worktree or a new checkout on another host. null = none.",
  inputSchema: { type: "object", properties: { projectId: projectIdProp } },
  async handler(args, client) {
    return JSON.stringify(await client.getSetupRecipe(args?.projectId));
  },
};

export const setSetupRecipe = {
  name: "set_setup_recipe",
  description:
    "Set your project's setup recipe: the shell command (`sh -c`) Mullion runs in every fresh " +
    "worktree and new checkout (e.g. `npm ci`), so dev servers and branch previews there have their " +
    "dependencies. `recipe` is the command (trimmed; at most 4096 characters), null or '' clears it. " +
    "Validated like Settings → Edit project. With `run: true` the saved recipe also runs once in " +
    "your session's working directory on its host and the reply's `run` carries the outcome, exit " +
    "code and log tail (this replaces your session's setup log; it can take minutes).",
  inputSchema: {
    type: "object",
    properties: {
      projectId: projectIdProp,
      recipe: { type: ["string", "null"], description: "The command; null clears it." },
      run: { type: "boolean", description: "Also run it once now, as a check." },
      sessionId: {
        type: "string",
        description: "Full scope only: the session whose directory `run` uses.",
      },
    },
    required: ["recipe"],
  },
  async handler(args, client) {
    const result = await client.setSetupRecipe(args?.projectId, {
      recipe: args?.recipe,
      run: args?.run,
      sessionId: args?.sessionId,
    });
    return JSON.stringify(result);
  },
};
