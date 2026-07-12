import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { projects, sessions } from "../db/schema.js";

interface ResizeMessage {
  type: "resize";
  cols: number;
  rows: number;
}

function isResizeMessage(value: unknown): value is ResizeMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "resize" &&
    typeof (value as { cols?: unknown }).cols === "number" &&
    typeof (value as { rows?: unknown }).rows === "number"
  );
}

const BACKPRESSURE_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export async function terminalRoute(app: FastifyInstance) {
  app.get(
    "/ws/terminal",
    {
      websocket: true,
      // Runs before the WS upgrade completes (@fastify/websocket respects
      // the normal Fastify request lifecycle up to onRequest/preValidation),
      // so an unknown or killed sessionId gets a real HTTP error response
      // instead of an upgrade that immediately closes.
      preValidation: async (request, reply) => {
        const query = request.query as Record<string, string | undefined>;
        const sessionId = Number(query.sessionId);
        if (!Number.isInteger(sessionId)) {
          return reply.badRequest("sessionId query param is required");
        }

        const [row] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
        if (!row) return reply.notFound(`No session ${sessionId}`);
        if (row.status === "killed") {
          return reply.badRequest(`Session ${sessionId} was killed`);
        }
        // "exited" (session-reconciler.ts) means the program already ended
        // on its own and the master is gone — same reasoning as "killed":
        // reattaching would otherwise silently bootstrap a fresh program
        // under this id (the exact M2-era gap this status exists to close).
        if (row.status === "exited") {
          return reply.badRequest(`Session ${sessionId} exited`);
        }
      },
    },
    (socket, req) => {
      const query = req.query as Record<string, string | undefined>;
      const sessionId = Number(query.sessionId);
      const cols = Number(query.cols) || 80;
      const rows = Number(query.rows) || 24;

      // preValidation above already confirmed this session and its project
      // exist, so these lookups can't miss.
      const [row] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
      const [project] = app.db
        .select()
        .from(projects)
        .where(eq(projects.id, row.projectId))
        .all();

      const session = app.pty.getOrCreate({
        id: String(sessionId),
        cwd: row.cwd ?? project.cwd,
        command: row.command,
        cols,
        rows,
      });

      app.db
        .update(sessions)
        .set({ lastAttachedAt: new Date() })
        .where(eq(sessions.id, sessionId))
        .run();

      app.log.info(
        { sessionId, cwd: row.cwd ?? project.cwd, command: row.command, alreadyAlive: session.isAlive },
        "terminal ws attached",
      );

      // Replay whatever this session produced while unwatched. In the common
      // case (browser tab closed, Node process never restarted) this alone
      // reconstructs the screen correctly, with no dtach-level reattach
      // involved at all — see pty-manager.ts.
      const backlog = session.getScrollback();
      if (backlog.length > 0) socket.send(backlog);

      const unsubscribeData = session.onData((chunk) => {
        if (socket.readyState !== socket.OPEN) return;
        // Backpressure: bufferedAmount is how much this client hasn't
        // acknowledged yet (a stalled connection, an overwhelmed mobile
        // link). Drop new output past this threshold rather than letting
        // the queue — and this process's memory — grow unbounded for one
        // slow subscriber; the scrollback ring buffer (pty-manager.ts)
        // still holds the last 256KB regardless, so a reconnect (or this
        // same connection catching back up) replays cleanly rather than
        // needing every dropped byte replayed in order.
        if (socket.bufferedAmount > BACKPRESSURE_MAX_BUFFERED_BYTES) return;
        socket.send(chunk);
      });

      const unsubscribeExit = session.onExit(() => {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ type: "exited" }));
        }
      });

      socket.on("message", (data, isBinary) => {
        if (isBinary) {
          // RawData is Buffer | ArrayBuffer | Buffer[]; narrow each arm
          // explicitly since Buffer.from() can't take the union directly.
          const buf = Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.isBuffer(data)
              ? data
              : Buffer.from(data);
          session.write(buf.toString("utf8"));
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(data.toString("utf8"));
        } catch {
          app.log.warn({ sessionId }, "dropped malformed control message");
          return;
        }

        if (isResizeMessage(parsed)) {
          session.resize(parsed.cols, parsed.rows);
        }
      });

      socket.on("close", () => {
        unsubscribeData();
        unsubscribeExit();
        // Deliberately not killing the session — it keeps running on the
        // host until the Node process itself shuts down (ptyPlugin's onClose)
        // or an explicit DELETE /api/sessions/:id.
        app.log.info({ sessionId }, "terminal ws detached (session kept alive)");
      });
    },
  );
}
