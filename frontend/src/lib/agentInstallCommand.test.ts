import { describe, it, expect } from "vitest";
import {
  envUpdateSnippet,
  staticEnvUpdateSnippet,
  unixInstallCommand,
  windowsInstallCommand,
} from "./agentInstallCommand.js";

const base = { token: "abc123", primaryUrl: "http://dev-01:3100", name: "win-pc" };

describe("windowsInstallCommand", () => {
  it("sets the token in the environment, never as a parameter", () => {
    const cmd = windowsInstallCommand(base);
    expect(cmd).toContain("$env:MULLION_AGENT_ENROLLMENT_TOKEN = 'abc123'");
    expect(cmd).not.toMatch(/-Token\b/);
    expect(cmd).toContain("-PrimaryUrl 'http://dev-01:3100'");
    expect(cmd).toContain("-AgentName 'win-pc'");
  });

  it("passes -AdvertiseUrl only when a base URL was given", () => {
    expect(windowsInstallCommand(base)).not.toContain("-AdvertiseUrl");
    expect(windowsInstallCommand({ ...base, baseUrl: "http://192.168.1.50:4000" })).toContain(
      "-AdvertiseUrl 'http://192.168.1.50:4000'",
    );
  });

  it("doubles single quotes in values", () => {
    expect(windowsInstallCommand({ ...base, name: "bob's pc" })).toContain(
      "-AgentName 'bob''s pc'",
    );
  });
});

describe("windowsInstallCommand typographic quotes", () => {
  it("doubles the curly single quotes PowerShell also treats as delimiters", () => {
    const cmd = windowsInstallCommand({ ...base, name: "x\u2019; calc; \u2018" });
    expect(cmd).toContain("-AgentName 'x\u2019\u2019; calc; \u2018\u2018'");
  });
});

describe("unixInstallCommand", () => {
  it("passes the variables install.sh reads and installs as an agent", () => {
    const cmd = unixInstallCommand(base);
    expect(cmd).toContain("MULLION_AGENT_PRIMARY_URL='http://dev-01:3100'");
    expect(cmd).toContain("MULLION_AGENT_ENROLLMENT_TOKEN='abc123'");
    expect(cmd).toContain("MULLION_AGENT_NAME='win-pc'");
    expect(cmd).toContain("sh mullion-install.sh --role agent");
    expect(cmd).not.toContain("MULLION_AGENT_ADVERTISE_URL");
  });

  it("includes the advertise URL when a base URL was given", () => {
    expect(unixInstallCommand({ ...base, baseUrl: "http://10.0.0.5:4000" })).toContain(
      "MULLION_AGENT_ADVERTISE_URL='http://10.0.0.5:4000'",
    );
  });

  it("escapes single quotes POSIX-style", () => {
    expect(unixInstallCommand({ ...base, name: "bob's" })).toContain(
      "MULLION_AGENT_NAME='bob'\\''s'",
    );
  });
});

describe("envUpdateSnippet", () => {
  it("sets the enrollment token, clears the manual one, and leaves the primary URL alone", () => {
    expect(envUpdateSnippet("tok")).toBe("MULLION_ENROLLMENT_TOKEN=tok\nMULLION_AGENT_TOKEN=");
  });
});

describe("staticEnvUpdateSnippet", () => {
  it("sets only the manual agent token", () => {
    expect(staticEnvUpdateSnippet("tok")).toBe("MULLION_AGENT_TOKEN=tok");
  });
});
