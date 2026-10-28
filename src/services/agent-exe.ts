import fs from "node:fs";
import path from "node:path";

/**
 * On Windows the agent runs as mullion-agent.exe, a windowless, branded copy of
 * Node that deploy/windows/register-task.ps1 makes, with the Node it was made
 * from recorded beside it (mullion-agent.exe.json). This is that Node: the one
 * to hand to tooling that wants a plain console `node` (the update script,
 * `register-task.ps1 -NodePath`, the `mullion` command-line wrapper). Anything
 * else, including a Node that is not the copy, is returned as it is.
 */
export function toolNodePath(execPath: string = process.execPath): string {
  if (path.win32.basename(execPath).toLowerCase() !== "mullion-agent.exe") return execPath;
  try {
    const stamp = JSON.parse(fs.readFileSync(`${execPath}.json`, "utf8")) as { source?: unknown };
    if (typeof stamp.source === "string" && fs.existsSync(stamp.source)) return stamp.source;
  } catch {
    // No (or an unreadable) stamp: the running executable is all there is.
  }
  return execPath;
}
