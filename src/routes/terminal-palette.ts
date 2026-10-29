import type { FastifyInstance } from "fastify";
import { setTerminalPalette } from "../services/terminal-query-reply.js";
import { pushTerminalPaletteToHosts } from "../services/terminal-palette-sync.js";

// The frontend reports the palette it has resolved for the current theme and
// color scheme, so the backend can answer a program's startup color query
// while no browser is attached (see services/terminal-query-reply.ts). Held in
// memory only: the dashboard re-reports on every load and theme change.
const HEX = "^#[0-9a-fA-F]{6}$";

export const paletteBodySchema = {
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
} as const;

export async function terminalPaletteRoute(app: FastifyInstance) {
  app.put("/api/terminal/palette", { schema: paletteBodySchema }, async (req, reply) => {
    const { foreground, background, cursor } = req.body as {
      foreground: string;
      background: string;
      cursor: string;
    };
    setTerminalPalette({ foreground, background, cursor });
    // Remote agent hosts answer their own sessions' startup queries, so they
    // need the palette too. Fire-and-forget: an unreachable host must not
    // hold up the browser's 204.
    void pushTerminalPaletteToHosts(app);
    return reply.code(204).send();
  });
}
