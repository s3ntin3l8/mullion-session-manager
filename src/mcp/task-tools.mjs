/**
 * MCP tools for Task Master tasks (#3165, #3173).
 */

const FULL_SCOPE_NOTE =
  "Requires full scope (MULLION_AUTH_TOKEN) — 403s from inside a normal agent session when " +
  "authentication is enabled (unrestricted if it's disabled entirely).";

export const listTasks = {
  name: "list_tasks",
  description: `List Task Master tasks, optionally filtered by status or projectId. ${FULL_SCOPE_NOTE}`,
  inputSchema: {
    type: "object",
    properties: {
      status: { type: "string", description: "Filter to tasks with this status." },
      projectId: { type: "string", description: "Filter to tasks of this project." },
    },
  },
  async handler(args, client) {
    const result = await client.listTasks({
      status: args?.status,
      projectId: args?.projectId,
    });
    return JSON.stringify(result);
  },
};

export const getTask = {
  name: "get_task",
  description: `Get a single Task Master task by id. ${FULL_SCOPE_NOTE}`,
  inputSchema: {
    type: "object",
    required: ["taskId"],
    properties: {
      taskId: { type: "string", description: "The task id to fetch." },
    },
  },
  async handler(args, client) {
    const result = await client.getTask(args.taskId);
    return JSON.stringify(result);
  },
};

export const retryTask = {
  name: "retry_task",
  description:
    "Retry a failed Task Master task (re-queues a resume or resets to ready, and syncs the " +
    `GitHub label). ${FULL_SCOPE_NOTE}`,
  inputSchema: {
    type: "object",
    required: ["taskId"],
    properties: {
      taskId: { type: "string", description: "The task id to retry." },
      agent: { type: "string", description: "Optional agent override for the retried run." },
      reviewAgent: {
        type: "string",
        description: "Optional review agent override for the retried run.",
      },
    },
  },
  async handler(args, client) {
    const result = await client.retryTask(args.taskId, {
      agent: args?.agent,
      reviewAgent: args?.reviewAgent,
    });
    return JSON.stringify(result);
  },
};

export const startTask = {
  name: "start_task",
  description: `Claim and enqueue a ready Task Master task. ${FULL_SCOPE_NOTE}`,
  inputSchema: {
    type: "object",
    required: ["taskId"],
    properties: {
      taskId: { type: "string", description: "The task id to start." },
      agent: { type: "string", description: "Optional agent override." },
      reviewAgent: { type: "string", description: "Optional review agent override." },
    },
  },
  async handler(args, client) {
    const result = await client.startTask(args.taskId, {
      agent: args?.agent,
      reviewAgent: args?.reviewAgent,
    });
    return JSON.stringify(result);
  },
};

export const closeTask = {
  name: "close_task",
  description:
    "Give up on a Task Master task currently in reviewing, marking it failed and cleaning up " +
    `its sessions and worktree. ${FULL_SCOPE_NOTE}`,
  inputSchema: {
    type: "object",
    required: ["taskId"],
    properties: {
      taskId: { type: "string", description: "The task id to close." },
      reason: { type: "string", description: "Optional failure reason to record." },
    },
  },
  async handler(args, client) {
    const result = await client.closeTask(args.taskId, { reason: args?.reason });
    return JSON.stringify(result);
  },
};

export const archiveTask = {
  name: "archive_task",
  description:
    "Archive (or unarchive with unarchive: true) a finished Task Master task (done or failed). " +
    FULL_SCOPE_NOTE,
  inputSchema: {
    type: "object",
    required: ["taskId"],
    properties: {
      taskId: { type: "string", description: "The task id to archive or unarchive." },
      unarchive: {
        type: "boolean",
        description: "When true, unarchive the task instead of archiving it.",
      },
    },
  },
  async handler(args, client) {
    const result = await client.archiveTask(args.taskId, { unarchive: args?.unarchive });
    return JSON.stringify(result);
  },
};
