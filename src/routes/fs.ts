import type { FastifyInstance } from "fastify";
import { opendir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

// Bound both the returned folders and the work done in file-heavy directories.
const MAX_DIRECTORIES = 1000;
const MAX_SCANNED_ENTRIES = 10000;

export async function fsRoute(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { path: string; hidden?: string } }>(
    "/api/fs/dirs",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["path"],
          properties: {
            path: { type: "string", minLength: 1, maxLength: 4096 },
            hidden: { type: "string", enum: ["0", "1"] },
          },
        },
      },
    },
    async (request, reply) => {
      const input = request.query.path;
      const expanded =
        input === "~" ? homedir() : input.startsWith("~/") ? homedir() + input.slice(1) : input;
      if (!isAbsolute(expanded) || expanded.includes("\0")) {
        return reply.badRequest("Path must be an absolute path or start with ~/.");
      }

      try {
        // Resolve against the filesystem, including symlinks and .., before
        // returning navigation paths. No arbitrary file data is read.
        const path = await realpath(expanded);
        const directories: { name: string; path: string }[] = [];
        let scanned = 0;
        let truncated = false;
        const dir = await opendir(path);
        for await (const entry of dir) {
          if (++scanned > MAX_SCANNED_ENTRIES || directories.length >= MAX_DIRECTORIES) {
            truncated = true;
            break;
          }
          if (entry.name.startsWith(".") && request.query.hidden !== "1") continue;
          const childPath = join(path, entry.name);
          let isDirectory = entry.isDirectory();
          if (entry.isSymbolicLink()) {
            // Follow directory links like normal navigation; broken links and
            // links to files never become names in the response.
            isDirectory = await stat(childPath).then(
              (info) => info.isDirectory(),
              () => false,
            );
          }
          if (isDirectory) directories.push({ name: entry.name, path: childPath });
        }
        directories.sort((a, b) => a.name.localeCompare(b.name));
        const parent = dirname(path);
        return { path, parent: parent === path ? null : parent, directories, truncated };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") {
          return reply.notFound("Directory does not exist.");
        }
        if (code === "EACCES" || code === "EPERM") {
          return reply.forbidden("Directory is not readable.");
        }
        if (code === "ELOOP" || code === "ENAMETOOLONG" || code === "EINVAL") {
          return reply.badRequest("Directory path is invalid.");
        }
        throw error;
      }
    },
  );
}
