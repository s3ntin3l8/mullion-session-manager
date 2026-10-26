// pty-host — Mullion's stand-in for dtach on platforms that have none
// (Windows; issue #1728).
//
//   node pty-host.mjs -n <endpoint> <program> [args...]
//
// Same shape as `dtach -n <socket> <program> [args...]`, and the same
// contract: create a session whose program runs in a pseudo-terminal held by
// a detached MASTER process, serve that terminal on <endpoint>, and exit 0 as
// soon as the master is serving — while the session itself keeps running.
// That is what lets a session outlive the Mullion process that started it,
// the property systemd scopes give on Linux and dtach's daemonize gives on
// macOS (see src/services/scope/).
//
// <endpoint> is whatever `net.Server.listen()` accepts: a named pipe
// (`\\.\pipe\...`) on Windows, a unix socket path elsewhere — the master
// itself is platform-neutral, which is also what lets it be tested on Linux.
// The pseudo-terminal is node-pty's: ConPTY on Windows.
//
// The master serves only clients that present the session token it reads
// from MULLION_PTY_HOST_TOKEN (see master.mjs's serve()).
//
// Clients speak the framed protocol in protocol.mjs. Any number may attach;
// every one receives the program's output and may write input and resize.
// The master keeps no scrollback (dtach keeps none either): Mullion keeps its
// own, and a new client's first RESIZE makes the terminal repaint — ConPTY
// re-renders its whole screen on a resize, which is this master's equivalent
// of `dtach -r winch`.
//
//   node pty-host.mjs --serve <endpoint> <program> [args...]
//
// The master itself (internal: `-n` launches it, detached). Exits when the
// program does. The logic lives in master.mjs; this file only parses argv.
import { fileURLToPath } from "node:url";
import { createSession, serve } from "./master.mjs";
import { TOKEN_ENV } from "./protocol.mjs";

const [mode, endpoint, program, ...args] = process.argv.slice(2);
if (!endpoint || !program || (mode !== "-n" && mode !== "--serve")) {
  process.stderr.write("usage: pty-host.mjs -n <endpoint> <program> [args...]\n");
  process.exit(2);
}
if (mode === "-n") {
  process.exit(
    await createSession(endpoint, program, args, { entry: fileURLToPath(import.meta.url) }),
  );
} else {
  const master = serve(endpoint, program, args, {
    // The session token comes from the environment (never argv, which other
    // processes can read); serve() keeps it out of the program's own env.
    token: process.env[TOKEN_ENV] ?? "",
    onExit: (code) => process.exit(code),
  });
  // A polite stop (POSIX) takes the program down with the master; its exit
  // then ends the master. On Windows the backend stops the whole tree with
  // `taskkill /T /F` instead.
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => master.stop());
}
