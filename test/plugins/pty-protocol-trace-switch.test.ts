import { describe, it, expect, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import {
  isProtocolTraceEnabled,
  setProtocolTraceEnabled,
} from "../../src/services/terminal-protocol-trace.js";

// MULLION_PROTOCOL_TRACE -> setProtocolTraceEnabled hop in plugins/pty.ts: the
// unit tests flip the module flag directly, so a renamed key or a dropped call
// would otherwise leave the trace on with the suite green.

const tmpDb = path.join(os.tmpdir(), `pty-protocol-trace-switch-test-${process.pid}.db`);

async function bootWith(value: string | undefined): Promise<void> {
  fs.rmSync(tmpDb, { force: true });
  process.env.DATABASE_URL = `file:${tmpDb}`;
  if (value === undefined) delete process.env.MULLION_PROTOCOL_TRACE;
  else process.env.MULLION_PROTOCOL_TRACE = value;
  const app = await buildApp();
  await app.close();
  closeDb();
}

describe("plugins/pty.ts applies MULLION_PROTOCOL_TRACE at boot", () => {
  afterEach(() => {
    delete process.env.MULLION_PROTOCOL_TRACE;
    delete process.env.DATABASE_URL;
    fs.rmSync(tmpDb, { force: true });
    setProtocolTraceEnabled(true);
  });

  it("switches the trace off when MULLION_PROTOCOL_TRACE=false", async () => {
    setProtocolTraceEnabled(true);
    await bootWith("false");
    expect(isProtocolTraceEnabled()).toBe(false);
  });

  it("leaves it on by default", async () => {
    setProtocolTraceEnabled(false);
    await bootWith(undefined);
    expect(isProtocolTraceEnabled()).toBe(true);
  });
});
