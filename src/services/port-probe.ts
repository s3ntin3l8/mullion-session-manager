import net from "node:net";

// Issue #2069 — Mullion never chooses a dev-server port, so the only way to
// notice two dock sessions fighting over one is to look at the port before
// spawning the second. This is that look: a loopback TCP probe, nothing more.

/** True for an integer TCP port (1–65535). A type guard so a raw JSON value
 * (a dock.json `port`) narrows to `number` at the call site. */
export function isValidPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

function connectProbe(port: number, host: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: timeoutMs });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

/**
 * Whether something already holds `host:port` (default loopback). Tries to
 * bind it first — the same operation the dev server is about to do, so it
 * also catches a listener that is bound but not accepting yet — and falls
 * back to a connect when the bind can't answer (EACCES on a privileged
 * port, EADDRNOTAVAIL, ...). Never throws; "can't tell" reads as free so a
 * probe failure can never block a launch.
 */
export function isPortInUse(port: number, host = "127.0.0.1", timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        resolve(true);
        return;
      }
      void connectProbe(port, host, timeoutMs).then(resolve);
    });
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolve(false));
    });
  });
}
