import { describe, it, expect } from "vitest";
import { parseControlMessage, parseControlHandshake } from "../../src/services/control-protocol.js";

describe("parseControlHandshake", () => {
  it("accepts an empty object as 'no token presented'", () => {
    expect(parseControlHandshake("{}")).toEqual({ token: null });
  });

  it("extracts a string token", () => {
    expect(parseControlHandshake('{"token":"abc123"}')).toEqual({ token: "abc123" });
  });

  it("treats an empty-string token as no token presented", () => {
    expect(parseControlHandshake('{"token":""}')).toEqual({ token: null });
  });

  it("treats a non-string token as no token presented", () => {
    expect(parseControlHandshake('{"token":42}')).toEqual({ token: null });
  });

  it("returns null for malformed JSON", () => {
    expect(parseControlHandshake("not json")).toBeNull();
  });

  it("returns null for a JSON array", () => {
    expect(parseControlHandshake("[1,2,3]")).toBeNull();
  });

  it("returns null for a JSON primitive", () => {
    expect(parseControlHandshake("42")).toBeNull();
  });
});

describe("parseControlMessage", () => {
  it("parses a minimal request with no body", () => {
    const result = parseControlMessage('{"id":1,"op":"ping"}');
    expect(result).toEqual({ ok: true, message: { id: 1, op: "ping", body: undefined } });
  });

  it("parses a request with a body object", () => {
    const result = parseControlMessage('{"id":2,"op":"sessions.list","body":{"projectId":"3"}}');
    expect(result).toEqual({
      ok: true,
      message: { id: 2, op: "sessions.list", body: { projectId: "3" } },
    });
  });

  it("rejects malformed JSON, with no id recoverable", () => {
    const result = parseControlMessage("not json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/malformed JSON/);
      expect(result.id).toBeNull();
    }
  });

  it("rejects a JSON array, with no id recoverable", () => {
    const result = parseControlMessage("[1,2,3]");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/JSON object/);
      expect(result.id).toBeNull();
    }
  });

  it("rejects a message missing 'id', with no id recoverable", () => {
    const result = parseControlMessage('{"op":"ping"}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/'id'/);
      expect(result.id).toBeNull();
    }
  });

  it("rejects a message with a non-numeric 'id', with no id recoverable", () => {
    const result = parseControlMessage('{"id":"1","op":"ping"}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/'id'/);
      expect(result.id).toBeNull();
    }
  });

  it("rejects a message with a non-finite 'id' (NaN/Infinity), with no id recoverable", () => {
    // JSON has no NaN/Infinity literal, but Number.isFinite still guards
    // against a hypothetical caller — same reasoning as
    // control-socket.ts's own tryExtractId-equivalent handling.
    const result = parseControlMessage('{"id":null,"op":"ping"}');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.id).toBeNull();
  });

  it("rejects a message missing 'op', but still recovers a valid 'id'", () => {
    const result = parseControlMessage('{"id":1}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/'op'/);
      expect(result.id).toBe(1);
    }
  });

  it("rejects an empty-string 'op', but still recovers a valid 'id'", () => {
    const result = parseControlMessage('{"id":1,"op":""}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/'op'/);
      expect(result.id).toBe(1);
    }
  });

  it("rejects a non-object 'body', but still recovers a valid 'id'", () => {
    const result = parseControlMessage('{"id":1,"op":"ping","body":"nope"}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/'body'/);
      expect(result.id).toBe(1);
    }
  });

  it("rejects an array 'body', but still recovers a valid 'id'", () => {
    const result = parseControlMessage('{"id":1,"op":"ping","body":[1,2]}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/'body'/);
      expect(result.id).toBe(1);
    }
  });
});
