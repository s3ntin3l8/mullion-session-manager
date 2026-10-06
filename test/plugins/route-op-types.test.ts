import path from "node:path";
import ts from "typescript";
import { describe, it, expect, vi } from "vitest";
import { routeOp, pinned, unscoped } from "../../src/plugins/control-socket.js";

// #1546 — routeOp's compile-time guard. tsc doesn't cover test/, so run the
// compiler API over a fixture of accepted + @ts-expect-error'd shapes.
describe("routeOp type enforcement", () => {
  it("accepts declared resolvers and rejects an undeclared session-scoped one", () => {
    const root = path.resolve(import.meta.dirname, "../..");
    const cfgPath = path.join(root, "tsconfig.json");
    const cfg = ts.parseJsonConfigFileContent(
      ts.readConfigFile(cfgPath, ts.sys.readFile).config,
      ts.sys,
      root,
    );
    const file = path.join(root, "test/fixtures/route-op-types.ts");
    const program = ts.createProgram([file], { ...cfg.options, noEmit: true });
    const diags = ts
      .getPreEmitDiagnostics(program, program.getSourceFile(file))
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    expect(diags).toEqual([]);
  }, 120_000);
});

describe("routeOp runtime paths", () => {
  const route = () => ({ method: "GET" as const, url: "/x" });
  const mk = (scope: "full" | "session") => {
    const inject = vi.fn(async () => ({ statusCode: 200, payload: '{"a":1}' }));
    const reply = vi.fn();
    const ctx = {
      app: {
        inject,
        config: {
          MULLION_AUTH_TOKEN: "",
          MULLION_OIDC_ISSUER: "",
          MULLION_OIDC_CLIENT_ID: "",
          MULLION_OIDC_CLIENT_SECRET: "",
          MULLION_OIDC_REDIRECT_URI: "",
        },
      },
      conn: { scope, sessionId: null },
      id: 1,
      body: undefined,
      reply,
    };
    return { ctx: ctx as never, inject, reply };
  };

  it("full-only bare resolver: structural gate rejects a session connection", async () => {
    const { ctx, inject, reply } = mk("session");
    await routeOp(["full"], route).handler(ctx);
    expect(inject).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ ok: false, status: 403 }));
  });

  it.each([
    ["pinned", pinned],
    ["unscoped", unscoped],
  ] as const)("%s resolver forwards at session scope", async (_n, wrap) => {
    const { ctx, inject, reply } = mk("session");
    await routeOp(["full", "session"], wrap(route)).handler(ctx);
    expect(inject).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ ok: true, status: 200 }));
  });

  it("an early ReplyPayload from a declared resolver is replied verbatim", async () => {
    // Scope is irrelevant here: an early ReplyPayload short-circuits before any pin check.
    const { ctx, inject, reply } = mk("full");
    const early = { ok: false as const, status: 400, error: "nope" };
    await routeOp(
      ["full", "session"],
      pinned(() => early),
    ).handler(ctx);
    expect(inject).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(early);
  });
});
