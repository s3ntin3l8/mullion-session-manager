import net from "node:net";

/** A free loopback port no other branch preview holds. The OS picks it
 * (listen on 0), so it is free at the time of asking; the dev server binds it
 * moments later. Runs on the host the preview's dev server runs on: the
 * primary for a local project, the agent (`/internal/preview-port`, #3428) for
 * a remote one. Stateless: what is reserved is the primary's to track. */
export async function allocatePreviewPort(taken: ReadonlySet<number>): Promise<number> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const chosen = typeof address === "object" && address ? address.port : 0;
        server.close(() => resolve(chosen));
      });
    });
    if (port > 0 && !taken.has(port)) return port;
  }
  throw new Error("no free port for a branch preview");
}
