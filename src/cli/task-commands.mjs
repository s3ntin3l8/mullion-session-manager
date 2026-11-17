/**
 * CLI handlers for `mullion task ...` (#3165, #3173, #2102).
 */

const TASK_LIST_SPEC = { status: "string", project: "string" };
const TASK_LAUNCH_SPEC = { agent: "string", "review-agent": "string" };
const TASK_CLOSE_SPEC = { reason: "string" };

export function createTaskCommands({ extractFlags, requireOne, taskPushTimeoutMs }) {
  async function runTaskLaunch(client, args, op) {
    const { flags, rest } = extractFlags(args, TASK_LAUNCH_SPEC);
    const id = requireOne(rest, "task id");
    const body = { taskId: id };
    if (flags.agent !== undefined) body.agent = flags.agent;
    if (flags["review-agent"] !== undefined) body.reviewAgent = flags["review-agent"];
    const result = await client.request(op, body);
    return { json: result, text: `${result.id}\t${result.status}` };
  }

  async function runTaskArchive(client, args, op) {
    const id = requireOne(args, "task id");
    const result = await client.request(op, { taskId: id });
    const archivedLabel = result.archivedAt ? "archived" : "unarchived";
    return { json: result, text: `${result.id}\t${result.status}\t${archivedLabel}` };
  }

  return {
    async list(client, args) {
      const { flags } = extractFlags(args, TASK_LIST_SPEC);
      const body = {};
      if (flags.status !== undefined) body.status = flags.status;
      if (flags.project !== undefined) body.projectId = flags.project;
      const result = await client.request("tasks.list", body);
      return {
        json: result,
        text: Array.isArray(result)
          ? result.map((t) => `${t.id}\t${t.status}\t${t.title}`).join("\n")
          : String(result),
      };
    },
    async get(client, args) {
      const id = requireOne(args, "task id");
      const result = await client.request("tasks.get", { taskId: id });
      return { json: result };
    },
    retry(client, args) {
      return runTaskLaunch(client, args, "tasks.retry");
    },
    start(client, args) {
      return runTaskLaunch(client, args, "tasks.start");
    },
    async close(client, args) {
      const { flags, rest } = extractFlags(args, TASK_CLOSE_SPEC);
      const id = requireOne(rest, "task id");
      const body = { taskId: id };
      if (flags.reason !== undefined) body.reason = flags.reason;
      const result = await client.request("tasks.close", body);
      return { json: result, text: `${result.id}\t${result.status}` };
    },
    archive(client, args) {
      return runTaskArchive(client, args, "tasks.archive");
    },
    unarchive(client, args) {
      return runTaskArchive(client, args, "tasks.unarchive");
    },
    // #2102 — a Task Master worker pushes its branch through Mullion (the gated
    // path, bot identity) instead of with its own git credentials.
    async push(client, _args, opts) {
      const body = {};
      if (opts.session !== undefined) body.sessionId = opts.session;
      // A push can take as long as the git remote (plus the lease pre-fetch).
      client.requestTimeoutMs = taskPushTimeoutMs;
      const result = await client.request("tasks.push", body);
      return { json: result, text: `pushed; pull request: ${result.prUrl}` };
    },
  };
}
