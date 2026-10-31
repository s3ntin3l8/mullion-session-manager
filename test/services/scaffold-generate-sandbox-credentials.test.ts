// Issue #2430 — sandbox credential seeding, persist-back, TMPDIR and failure
// reporting for generation turns. Lives in its own file: scaffold-generate.test.ts
// is at its size ceiling (scripts/check-max-file-lines.mjs).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentSandboxWritablePaths,
  createAgentSandboxHome,
  describeSpawnFailure,
  persistAgentSandboxAuth,
  redactSecrets,
  wrapWithSandbox,
} from "../../src/services/scaffold-generate.js";

describe("createAgentSandboxHome — credential seeding (issue #2430)", () => {
  let realHomeDir: string;
  let scratchDir: string;

  beforeEach(() => {
    realHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-real-"));
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-scratch-"));
    vi.spyOn(os, "homedir").mockReturnValue(realHomeDir);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(realHomeDir, { recursive: true, force: true });
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  // Asserts the BYTES, not just that a file exists: the placeholder bwrap needs
  // used to be created first and silently blocked the copy, leaving 0 bytes.
  it("copies codex's real auth.json into the sandbox HOME byte for byte", () => {
    const real = path.join(realHomeDir, ".codex", "auth.json");
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, '{"tokens":{"access_token":"fixture-a"}}');
    const { fakeHome } = createAgentSandboxHome(scratchDir, "codex");
    const seeded = path.join(fakeHome, ".codex", "auth.json");
    expect(fs.readFileSync(seeded, "utf8")).toBe('{"tokens":{"access_token":"fixture-a"}}');
  });

  it("copies claude's real .credentials.json into the sandbox HOME byte for byte", () => {
    const real = path.join(realHomeDir, ".claude", ".credentials.json");
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, '{"claudeAiOauth":{"accessToken":"fixture-b"}}');
    const { fakeHome } = createAgentSandboxHome(scratchDir, "claude");
    expect(fs.readFileSync(path.join(fakeHome, ".claude", ".credentials.json"), "utf8")).toBe(
      '{"claudeAiOauth":{"accessToken":"fixture-b"}}',
    );
  });

  it("leaves an empty placeholder and warns when the real credentials are missing", () => {
    const { fakeHome } = createAgentSandboxHome(scratchDir, "codex");
    expect(fs.statSync(path.join(fakeHome, ".codex", "auth.json")).size).toBe(0);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("no credentials seeded"),
      "codex",
      "auth.json",
      "ENOENT",
    );
  });

  it("never copies the real ~/.claude directory's other files", () => {
    const realClaude = path.join(realHomeDir, ".claude");
    fs.mkdirSync(realClaude, { recursive: true });
    fs.writeFileSync(path.join(realClaude, ".credentials.json"), "{}");
    fs.writeFileSync(path.join(realClaude, "settings.json"), '{"hooks":{}}');
    const { fakeHome } = createAgentSandboxHome(scratchDir, "claude");
    expect(fs.existsSync(path.join(fakeHome, ".claude", "settings.json"))).toBe(false);
  });

  it("refuses a symlinked .agent-home: credentials are never written through a repo-chosen link", () => {
    const real = path.join(realHomeDir, ".claude", ".credentials.json");
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, '{"claudeAiOauth":{"accessToken":"fixture-c"}}');
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "seed-elsewhere-"));
    try {
      fs.symlinkSync(elsewhere, path.join(scratchDir, ".agent-home"));
      createAgentSandboxHome(scratchDir, "claude");
      expect(fs.readdirSync(elsewhere)).toEqual([]);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("does not seed through a symlinked .claude inside the sandbox HOME", () => {
    const real = path.join(realHomeDir, ".claude", ".credentials.json");
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, '{"claudeAiOauth":{"accessToken":"fixture-d"}}');
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "seed-elsewhere-"));
    try {
      const fakeHome = path.join(scratchDir, ".agent-home");
      fs.mkdirSync(fakeHome);
      fs.symlinkSync(elsewhere, path.join(fakeHome, ".claude"));
      createAgentSandboxHome(scratchDir, "claude");
      expect(fs.readdirSync(elsewhere)).toEqual([]);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("replaces a credentials file the repo committed under .agent-home with the operator's real one", () => {
    const real = path.join(realHomeDir, ".claude", ".credentials.json");
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, '{"claudeAiOauth":{"accessToken":"REAL"}}');
    const planted = path.join(scratchDir, ".agent-home", ".claude", ".credentials.json");
    fs.mkdirSync(path.dirname(planted), { recursive: true });
    fs.writeFileSync(planted, '{"claudeAiOauth":{"accessToken":"ATTACKER-SUPPLIED"}}');
    const { seeded } = createAgentSandboxHome(scratchDir, "claude");
    expect(fs.readFileSync(planted, "utf8")).toBe('{"claudeAiOauth":{"accessToken":"REAL"}}');
    expect(seeded).toEqual([planted]);
  });

  it("with no real credentials, a planted file is removed and nothing counts as seeded", () => {
    const planted = path.join(scratchDir, ".agent-home", ".claude", ".credentials.json");
    fs.mkdirSync(path.dirname(planted), { recursive: true });
    fs.writeFileSync(planted, '{"claudeAiOauth":{"accessToken":"ATTACKER-SUPPLIED"}}');
    const { seeded } = createAgentSandboxHome(scratchDir, "claude");
    expect(seeded).toEqual([]);
    expect(fs.readFileSync(planted, "utf8")).toBe("");
  });

  it("persist-back with the seeded list never copies a planted file over the real credentials", () => {
    const real = path.join(realHomeDir, ".claude", ".credentials.json");
    const planted = path.join(scratchDir, ".agent-home", ".claude", ".credentials.json");
    fs.mkdirSync(path.dirname(planted), { recursive: true });
    fs.writeFileSync(planted, '{"claudeAiOauth":{"accessToken":"ATTACKER-SUPPLIED"}}');
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, '{"claudeAiOauth":{"accessToken":"REAL"}}');
    const { fakeHome, seeded } = createAgentSandboxHome(scratchDir, "claude");
    // Only the file this call seeded (the real credentials) is persisted back.
    persistAgentSandboxAuth(fakeHome, { files: seeded });
    expect(fs.readFileSync(real, "utf8")).toBe('{"claudeAiOauth":{"accessToken":"REAL"}}');
  });

  it("creates the sandbox's writable TMPDIR inside the fake HOME", () => {
    const { fakeHome } = createAgentSandboxHome(scratchDir, "claude");
    expect(fs.statSync(path.join(fakeHome, "tmp")).isDirectory()).toBe(true);
  });
});

describe("persistAgentSandboxAuth — claude credentials (issue #2430)", () => {
  let realHomeDir: string;
  let scratchDir: string;

  beforeEach(() => {
    realHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "persist-claude-real-"));
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "persist-claude-fake-"));
    vi.spyOn(os, "homedir").mockReturnValue(realHomeDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(realHomeDir, { recursive: true, force: true });
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  const setup = (sandboxed: string) => {
    const real = path.join(realHomeDir, ".claude", ".credentials.json");
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, '{"claudeAiOauth":{"accessToken":"old"}}');
    const fakeHome = path.join(scratchDir, ".agent-home");
    const fake = path.join(fakeHome, ".claude", ".credentials.json");
    fs.mkdirSync(path.dirname(fake), { recursive: true });
    fs.writeFileSync(fake, sandboxed);
    return { real, fake, fakeHome };
  };

  it("copies a rotated .credentials.json back to the real HOME", () => {
    const { real, fake, fakeHome } = setup('{"claudeAiOauth":{"accessToken":"rotated"}}');
    persistAgentSandboxAuth(fakeHome, { files: [fake] });
    expect(fs.readFileSync(real, "utf8")).toBe('{"claudeAiOauth":{"accessToken":"rotated"}}');
  });

  it("does not read through a symlinked directory in the sandbox HOME", () => {
    const { real, fakeHome } = setup('{"claudeAiOauth":{"accessToken":"x"}}');
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "persist-elsewhere-"));
    try {
      fs.writeFileSync(
        path.join(elsewhere, ".credentials.json"),
        '{"claudeAiOauth":{"accessToken":"ATTACKER"}}',
      );
      fs.rmSync(path.join(fakeHome, ".claude"), { recursive: true });
      fs.symlinkSync(elsewhere, path.join(fakeHome, ".claude"));
      persistAgentSandboxAuth(fakeHome, {
        files: [path.join(fakeHome, ".claude", ".credentials.json")],
      });
      expect(fs.readFileSync(real, "utf8")).toBe('{"claudeAiOauth":{"accessToken":"old"}}');
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("never replaces the real credentials with an empty placeholder", () => {
    const { real, fake, fakeHome } = setup("");
    persistAgentSandboxAuth(fakeHome, { files: [fake] });
    expect(fs.readFileSync(real, "utf8")).toBe('{"claudeAiOauth":{"accessToken":"old"}}');
  });
});

describe("wrapWithSandbox — TMPDIR (issue #2430)", () => {
  it("points TMPDIR at a directory inside the fake HOME, since /tmp is read-only", () => {
    const r = wrapWithSandbox("claude", ["-p"], "/tmp/wt", [], "/tmp/wt/.agent-home");
    const i = r.args.indexOf("TMPDIR");
    expect(r.args[i - 1]).toBe("--setenv");
    expect(r.args[i + 1]).toBe("/tmp/wt/.agent-home/tmp");
  });

  it("sets no TMPDIR without a fake HOME", () => {
    expect(wrapWithSandbox("claude", ["-p"], "/tmp/wt").args).not.toContain("TMPDIR");
  });

  it("never binds the real ~/.claude directory", () => {
    const r = wrapWithSandbox("claude", ["-p"], "/tmp/wt", [], "/tmp/wt/.agent-home");
    expect(r.args.join(" ")).not.toContain(path.join(os.homedir(), ".claude"));
  });
});

describe("describeSpawnFailure (issue #2430)", () => {
  const warn = "Warning: no stdin data received in 3s, proceeding without it. If piping…";

  it("leads with the exit code and the stdout tail, not the stdin warning", () => {
    const msg = describeSpawnFailure(
      { code: 1, killed: false, signal: undefined, message: "Command failed" } as never,
      "Not logged in · Please run /login\n",
      `${warn}\n`,
    );
    expect(msg).toContain("exit code 1");
    expect(msg).toContain("stdout: Not logged in · Please run /login");
    expect(msg).not.toContain("no stdin data received");
  });

  it("keeps other stderr lines, reports a signal, and keeps a spawn error's message", () => {
    expect(
      describeSpawnFailure({ code: 1, message: "x" } as never, "", `${warn}\nboom happened`),
    ).toContain("stderr: boom happened");
    expect(
      describeSpawnFailure({ killed: true, signal: "SIGTERM", message: "x" } as never, "", ""),
    ).toContain("killed by SIGTERM");
    expect(
      describeSpawnFailure({ code: "ENOENT", message: "spawn claude ENOENT" } as never, "", ""),
    ).toContain("spawn claude ENOENT");
  });

  it("stays bounded for a huge stdout", () => {
    const msg = describeSpawnFailure({ code: 2, message: "x" } as never, "y".repeat(100_000), "");
    expect(msg.length).toBeLessThan(700);
  });
});

describe("redactSecrets (issue #2430)", () => {
  it("removes tokens an agent turn could echo from a failure tail", () => {
    const text = [
      "key sk-ant-oat01-abcDEF123_-xyz",
      "jwt eyJhbGciOi.eyJzdWIiOiIx.SflKxwRJSMeKKF2QT4",
      '{"claudeAiOauth":{"accessToken":"super-secret-value","refreshToken":"another-one"}}',
      "Authorization: Bearer abc.def-123",
    ].join("\n");
    const out = redactSecrets(text);
    for (const secret of [
      "sk-ant-oat01",
      "SflKxwRJSMeKKF2QT4",
      "super-secret-value",
      "another-one",
      "abc.def-123",
    ]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain("[redacted]");
  });

  it("leaves ordinary text alone, and describeSpawnFailure applies it to both tails", () => {
    expect(redactSecrets("Not logged in · Please run /login")).toBe(
      "Not logged in · Please run /login",
    );
    const msg = describeSpawnFailure(
      { code: 1, message: "x" } as never,
      'out {"accessToken":"leak-me-1"}',
      "err Bearer leak-me-2",
    );
    expect(msg).not.toContain("leak-me");
  });
});

describe("claude's sandbox paths (issue #2430)", () => {
  it("lists only the OAuth credentials file, never the whole ~/.claude", () => {
    expect(agentSandboxWritablePaths("claude")).toEqual({
      dirs: [],
      files: [path.join(os.homedir(), ".claude", ".credentials.json")],
    });
  });

  it("createAgentSandboxHome materializes .agent-home for claude (bwrap --bind needs its source)", () => {
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-home-"));
    try {
      const { fakeHome, writablePaths } = createAgentSandboxHome(scratchDir, "claude");
      expect(writablePaths.files).toEqual([path.join(fakeHome, ".claude", ".credentials.json")]);
      expect(fs.existsSync(path.join(scratchDir, ".agent-home"))).toBe(true);
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});
