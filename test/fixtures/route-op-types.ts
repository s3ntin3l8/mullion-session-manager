// Compile-only fixture for test/plugins/route-op-types.test.ts, which runs
// the TypeScript compiler over this file and asserts ZERO diagnostics — so
// every `@ts-expect-error` below must really be an error (an unused one is
// itself TS2578). Not part of any tsconfig `include`.
import { routeOp, pinned, unscoped } from "../../src/plugins/control-socket.js";

const route = () => ({ method: "GET" as const, url: "/x" });

// Accepted: full-only with a bare resolver (injectRoute enforces the gate).
routeOp(["full"], route);
// Accepted: session-reachable with a declared resolver.
routeOp(["full", "session"], pinned(route));
routeOp(["full", "session"], unscoped(route));
routeOp(["session"], pinned(route));

// Rejected: session-reachable with a bare, undeclared resolver.
// @ts-expect-error a session-scoped op must declare pinned()/unscoped()
routeOp(["full", "session"], route);
// @ts-expect-error same for a session-only op
routeOp(["session"], route);
// @ts-expect-error a hand-rolled {target} object that lacks `run` is not a declaration
routeOp(["full", "session"], { target: "pinned" });
// @ts-expect-error an unknown scope is rejected
routeOp(["admin"], route);
