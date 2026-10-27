import { describe, it, expect } from "vitest";
import { SERVER_ENV_KEYS } from "../../src/services/session-env.js";
import { schema } from "../../src/plugins/env.js";
import { SESSION_RUNTIME_ENV_KEYS } from "./session-runtime-env.js";

describe("SESSION_RUNTIME_ENV_KEYS", () => {
  it("covers every non-schema, non-git key the server strips from a session", () => {
    const schemaKeys = new Set(Object.keys(schema.properties));
    const stripped = SERVER_ENV_KEYS.filter((k) => !schemaKeys.has(k) && !k.startsWith("GIT_"));
    expect([...SESSION_RUNTIME_ENV_KEYS].sort()).toEqual([...stripped].sort());
  });
});
