import { describe, expect, it } from "vitest";
import {
  scanDirectory,
  scanFileForAntipatterns,
} from "../../scripts/check-security-antipatterns.mjs";

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
});
