import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseCredentialInput,
  isGithubHost,
  formatCredentialOutput,
  requestGithubToken,
  runCredentialHelper,
  runGhToken,
} from "../../src/hooks/git-credential-core.mjs";

const GOOD = { token: "ghs_abc", username: "x-access-token", hostFirst: false };
const input = "protocol=https\nhost=github.com\n\n";

describe("git credential helper core (issue #2246)", () => {
  it("parses git's key=value input up to the blank line", () => {
    expect(parseCredentialInput("protocol=https\nhost=github.com\npath=a=b\n\nignored=1")).toEqual({
      protocol: "https",
      host: "github.com",
      path: "a=b",
    });
  });

  it("only answers for github.com over https", () => {
    expect(isGithubHost("github.com")).toBe(true);
    expect(isGithubHost("GitHub.com:443")).toBe(true);
    expect(isGithubHost("gitlab.com")).toBe(false);
    expect(formatCredentialOutput({ protocol: "http", host: "github.com" }, GOOD)).toBe("");
    expect(formatCredentialOutput({ protocol: "https", host: "evil.example" }, GOOD)).toBe("");
    expect(formatCredentialOutput({ protocol: "https", host: "github.com" }, GOOD)).toBe(
      "username=x-access-token\npassword=ghs_abc\n",
    );
  });

  it("get prints the credential; store/erase and other hosts print nothing", async () => {
    const ok = async () => GOOD;
    expect((await runCredentialHelper("get", input, {}, ok)).stdout).toContain("password=ghs_abc");
    expect(await runCredentialHelper("store", input, {}, ok)).toEqual({
      stdout: "",
      stderr: "",
      code: 0,
    });
    expect(await runCredentialHelper("erase", input, {}, ok)).toMatchObject({ stdout: "" });
    const other = await runCredentialHelper("get", "protocol=https\nhost=gitlab.com\n\n", {}, ok);
    expect(other).toEqual({ stdout: "", stderr: "", code: 0 });
  });

  it("with no token it prints the actionable message and fails instead of prompting", async () => {
    const none = async () => ({ error: "connect GitHub in Mullion Settings", hostFirst: true });
    const result = await runCredentialHelper("get", input, {}, none);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("mullion: connect GitHub in Mullion Settings\n");
  });

  it("gh-token mode is one shell-splittable line", async () => {
    expect((await runGhToken({}, async () => GOOD)).stdout).toBe("ok false ghs_abc\n");
    const err = await runGhToken({}, async () => ({ error: "a\nb", hostFirst: true }));
    expect(err.stdout).toBe("err true a b\n");
    expect((await runGhToken({}, async () => undefined)).stdout).toMatch(/^err false no GitHub/);
  });

  describe("requestGithubToken over a real socket", () => {
    const servers: net.Server[] = [];
    afterEach(() => {
      for (const s of servers.splice(0)) s.close();
    });

    function listen(onLines: (lines: string[], socket: net.Socket) => void): string {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-cred-"));
      const sock = path.join(dir, "h.sock");
      const server = net.createServer((socket) => {
        let buf = "";
        socket.on("data", (c) => {
          buf += c.toString();
          const lines = buf.split("\n").filter(Boolean);
          if (lines.length >= 2) onLines(lines, socket);
        });
      });
      server.listen(sock);
      servers.push(server);
      return sock;
    }

    it("sends the handshake then github_token and returns the reply", async () => {
      let seen: string[] = [];
      const sock = listen((lines, socket) => {
        seen = lines;
        socket.write(`${JSON.stringify(GOOD)}\n`);
      });
      await expect(requestGithubToken(sock, "hook-token")).resolves.toEqual(GOOD);
      expect(seen.map((l) => JSON.parse(l))).toEqual([
        { token: "hook-token" },
        { kind: "github_token" },
      ]);
    });

    it("never hangs: a silent server times out, a missing socket errors", async () => {
      const sock = listen(() => {});
      await expect(requestGithubToken(sock, "t", 50)).resolves.toEqual({
        error: "Mullion did not answer in time",
      });
      const gone = await requestGithubToken("/nonexistent/h.sock", "t", 500);
      expect(String((gone as { error: string }).error)).toMatch(/cannot reach Mullion/);
      expect(await requestGithubToken(undefined, undefined)).toMatchObject({
        error: expect.stringMatching(/not running inside a Mullion session/),
      });
    });

    it("reports an unreadable reply", async () => {
      const sock = listen((_l, socket) => socket.write("not json\n"));
      await expect(requestGithubToken(sock, "t")).resolves.toEqual({
        error: "unreadable reply from Mullion",
      });
    });
  });
});
