import { describe, it, expect } from "vitest";
import {
  parseDevServerPort,
  detectDevServerPortForSessionIds,
} from "../../src/services/dev-server-detect.js";

// Captured (lightly trimmed) real startup banners — see dev-server-detect.ts's
// own comment for why one loose regex covers all four instead of a
// framework-specific parser each.
const VITE_BANNER = `
  VITE v5.2.0  ready in 320 ms

  ➜  Local:   http://localhost:5173/
  ➜  Network: use --host to expose
`;

const NEXT_BANNER = `
   ▲ Next.js 14.2.3
   - Local:        http://localhost:3000
   - Environments: .env.local

 ✓ Starting...
`;

const CRA_BANNER = `
Compiled successfully!

You can now view my-app in the browser.

  Local:            http://localhost:3000
  On Your Network:  http://192.168.1.5:3000

Note that the development build is not optimized.
`;

const ASTRO_BANNER = `
  🚀  astro  v4.5.0 started in 300ms

  ┃ Local    http://localhost:4321/
  ┃ Network  use --host to expose
`;

// Byte-for-byte captured from a real `make dev` run under a pty (`script -qc
// "make dev"`), not hand-written — concurrently's own "[frontend]" prefix
// plus Vite's actual SGR codes, which bold both the word "Local" and just
// the port digits. This is the exact shape that broke detection: the bold
// code's own trailing "m" merged with "Local" and defeated `\bLocal\b`
// outright, and the escape bytes between ":" and the port digits broke the
// port capture group even when unstyled.
const VITE_BANNER_WITH_ANSI =
  "\x1b[32m[frontend]\x1b[39m   \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5175\x1b[22m/\x1b[39m";

describe("parseDevServerPort", () => {
  it("extracts the port from a Vite banner", () => {
    expect(parseDevServerPort(VITE_BANNER)).toBe("5173");
  });

  it("extracts the port from a real, ANSI-colored Vite banner (bold 'Local' and bold port digits)", () => {
    expect(parseDevServerPort(VITE_BANNER_WITH_ANSI)).toBe("5175");
  });

  it("extracts the port from a Next.js banner", () => {
    expect(parseDevServerPort(NEXT_BANNER)).toBe("3000");
  });

  it("extracts the port from a Create React App banner, not the 'On Your Network' LAN port", () => {
    expect(parseDevServerPort(CRA_BANNER)).toBe("3000");
  });

  it("extracts the port from an Astro banner (no colon after 'Local')", () => {
    expect(parseDevServerPort(ASTRO_BANNER)).toBe("4321");
  });

  it("matches a 127.0.0.1 form the same as localhost", () => {
    expect(parseDevServerPort("  Local:   http://127.0.0.1:8080/\n")).toBe("8080");
  });

  it("returns null for plain output with no banner", () => {
    expect(parseDevServerPort("Compiling...\ndone in 40ms\n")).toBeNull();
  });

  it("returns null for a 'Local' mention with no adjoining localhost URL", () => {
    expect(parseDevServerPort("Local development is not yet configured.\n")).toBeNull();
  });

  it("returns null for a Network line with no 'Local' URL anywhere", () => {
    expect(parseDevServerPort("  ➜  Network: use --host to expose\n")).toBeNull();
  });

  it("returns the LAST match when the dev server reprints its banner on a different port (restart)", () => {
    const restarted = `${VITE_BANNER}\n\n  VITE v5.2.0  ready in 210 ms\n\n  ➜  Local:   http://localhost:5174/\n`;
    expect(parseDevServerPort(restarted)).toBe("5174");
  });
});

describe("detectDevServerPortForSessionIds", () => {
  function fakeApp(sessions: Record<string, string | undefined>) {
    return {
      pty: {
        get: (id: string) => {
          const output = sessions[id];
          if (output === undefined) return undefined;
          return { getScrollback: () => Buffer.from(output, "utf8") };
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  it("returns null when there are no dock session ids", () => {
    expect(detectDevServerPortForSessionIds(fakeApp({}), [])).toBeNull();
  });

  it("returns null when a session id isn't tracked by this process's PtyManager", () => {
    expect(detectDevServerPortForSessionIds(fakeApp({}), ["42"])).toBeNull();
  });

  it("returns the detected port from the first session id that has one", () => {
    const app = fakeApp({ "1": "Compiling...\n", "2": VITE_BANNER });
    expect(detectDevServerPortForSessionIds(app, ["1", "2"])).toBe("5173");
  });

  it("returns null when none of the tracked sessions have a banner yet", () => {
    const app = fakeApp({ "1": "Compiling...\n" });
    expect(detectDevServerPortForSessionIds(app, ["1"])).toBeNull();
  });
});
