// Imported first by src/server.ts (before anything else is evaluated; a plain
// statement in server.ts would run only after its hoisted imports).
//
// Gives the server a command line that a generic `pkill -f "dist/server.js"`
// (the usual cleanup for another Node project's dev server) does not match.
// On Linux, setting process.title rewrites /proc/<pid>/cmdline, which is what
// `ps`, `pgrep -f` and `pkill -f` read. Nothing in Mullion reads it back.
process.title = "mullion-server";
