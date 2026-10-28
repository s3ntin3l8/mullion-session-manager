import type { FastifyInstance } from "fastify";
import { setTerminalPalette } from "../services/terminal-query-reply.js";

// The frontend reports the palette it has resolved for the current theme and
// color scheme, so the backend can answer a program's startup color query
// while no browser is attached (see services/terminal-query-reply.ts). Held in
// memory only: the dashboard re-reports on every load and theme change.
const HEX = "^#[0-9a-fA-F]{6}$";

export async function terminalPaletteRoute(app: FastifyInstance) {
  app.put(
    "/api/terminal/palette",
    {
      schema: {
        body: {
          type: "object",
          required: ["foreground", "background", "cursor"],
          additionalProperties: false,
          properties: {
            foreground: { type: "string", pattern: HEX },
            background: { type: "string", pattern: HEX },
            cursor: { type: "string", pattern: HEX },
          },
        },
      },
    },
    async (req, reply) => {
      const { foreground, background, cursor } = req.body as {
        foreground: string;
        background: string;
        cursor: string;
      };
      setTerminalPalette({ foreground, background, cursor });
      return reply.code(204).send();
    },
  );
}
