import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  cli,
  scanDirectory,
  scanFileForAntipatterns,
} from "../../scripts/check-security-antipatterns.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("check-security-antipatterns", () => {
  it("flags Access-Control-Allow-Credentials set to true", () => {
    const code = `
      function setHeaders(reply) {
        reply.header("Access-Control-Allow-Origin", req.headers.origin);
        reply.header("Access-Control-Allow-Credentials", "true");
      }
    `;
    const findings = scanFileForAntipatterns("test.ts", code);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      file: "test.ts",
      line: 4,
      rule: "cors-misconfiguration-for-credentials",
    });
  });

  it("allows safe fixed-origin Access-Control-Allow-Origin with credentials: true", () => {
    const code = `
      function setHeaders(reply) {
        reply.header("Access-Control-Allow-Origin", "https://app.example.com");
        reply.header("Access-Control-Allow-Credentials", "true");
      }
    `;
    const findings = scanFileForAntipatterns("safe-fixed.ts", code);
    expect(findings).toHaveLength(0);
  });

  it("allows fixed origin whose hostname contains 'origin' and URL with //", () => {
    const code = `
      function setHeaders(reply) {
        reply.header("Access-Control-Allow-Origin", "https://origin.example.com//api");
        reply.header("Access-Control-Allow-Credentials", "true");
      }
    `;
    const findings = scanFileForAntipatterns("origin-word.ts", code);
    expect(findings).toHaveLength(0);
  });

  it("flags dynamic variable origin reflection with credentials: true", () => {
    const code = `
      function setHeaders(reply, origin) {
        reply.header("Access-Control-Allow-Origin", origin);
        reply.header("Access-Control-Allow-Credentials", "true");
      }
    `;
    const findings = scanFileForAntipatterns("dynamic-origin.ts", code);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      file: "dynamic-origin.ts",
      rule: "cors-misconfiguration-for-credentials",
    });
  });

  it("flags wildcard Access-Control-Allow-Origin with credentials: true", () => {
    const code = `
      function setHeaders(reply) {
        reply.header("Access-Control-Allow-Origin", "*");
        reply.header("Access-Control-Allow-Credentials", "true");
      }
    `;
    const findings = scanFileForAntipatterns("wildcard.ts", code);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      file: "wildcard.ts",
      rule: "cors-misconfiguration-for-credentials",
    });
  });

  it("allows allowlisted Access-Control-Allow-Credentials with pragma", () => {
    const code = `
      reply.header("Access-Control-Allow-Origin", "*");
      reply.header("Access-Control-Allow-Credentials", "true"); // pragma: allowlist cors-credentials
    `;
    const findings = scanFileForAntipatterns("allowlist.ts", code);
    expect(findings).toHaveLength(0);
  });

  it("flags Fastify CORS with credentials: true and origin: true", () => {
    const code = `
      fastify.register(cors, {
        origin: true,
        credentials: true,
      });
    `;
    const findings = scanFileForAntipatterns("cors.ts", code);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      file: "cors.ts",
      rule: "cors-misconfiguration-for-credentials",
    });
  });

  it("flags Fastify CORS callback reflection cb(null, true) with credentials: true", () => {
    const code = `
      fastify.register(cors, {
        origin: (origin, cb) => {
          cb(null, true);
        },
        credentials: true,
      });
    `;
    const findings = scanFileForAntipatterns("cors-fn.ts", code);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      file: "cors-fn.ts",
      rule: "cors-misconfiguration-for-credentials",
    });
  });

  it("flags Fastify CORS callback reflection cb(null, origin) with credentials: true", () => {
    const code = `
      fastify.register(cors, {
        origin: (origin, cb) => {
          cb(null, origin);
        },
        credentials: true,
      });
    `;
    const findings = scanFileForAntipatterns("cors-origin-cb.ts", code);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      file: "cors-origin-cb.ts",
      rule: "cors-misconfiguration-for-credentials",
    });
  });

  it("flags Fastify CORS callback reflection with req.headers.origin", () => {
    const code = `
      fastify.register(cors, {
        origin: (req, cb) => {
          cb(null, req.headers.origin);
        },
        credentials: true,
      });
    `;
    const findings = scanFileForAntipatterns("cors-req-headers.ts", code);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      file: "cors-req-headers.ts",
      rule: "cors-misconfiguration-for-credentials",
    });
  });

  it("flags Fastify CORS arrow returning true with credentials: true", () => {
    const code = `
      fastify.register(cors, {
        origin: (origin) => true,
        credentials: true,
      });
    `;
    const findings = scanFileForAntipatterns("cors-arrow.ts", code);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      file: "cors-arrow.ts",
      rule: "cors-misconfiguration-for-credentials",
    });
  });

  it("ignores Access-Control-Allow-Credentials in comments", () => {
    const code = `
      // Responses do NOT set Access-Control-Allow-Credentials: true, so
      /* Access-Control-Allow-Credentials: true is omitted */
      reply.header("Access-Control-Allow-Origin", "*");
    `;
    const findings = scanFileForAntipatterns("safe.ts", code);
    expect(findings).toHaveLength(0);
  });

  it("honors allowlist pragma comment on the flagged line", () => {
    const code = `
      reply.header("Access-Control-Allow-Credentials", "true"); // pragma: allowlist cors-credentials
    `;
    const findings = scanFileForAntipatterns("allowlisted.ts", code);
    expect(findings).toHaveLength(0);
  });

  it("scans current src directory cleanly", () => {
    const findings = scanDirectory(new URL("../../src", import.meta.url).pathname);
    expect(findings).toHaveLength(0);
  });

  it("executes CLI successfully on clean directory", () => {
    const scriptPath = path.join(root, "scripts/check-security-antipatterns.mjs");
    const output = execFileSync("node", [scriptPath, path.join(root, "src")], {
      encoding: "utf8",
    });
    expect(output).toContain("OK — no security anti-patterns detected");
  });

  it("cli returns 0 on clean directory", () => {
    expect(cli([path.join(root, "src")])).toBe(0);
  });
});
