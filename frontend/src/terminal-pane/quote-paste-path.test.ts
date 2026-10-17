import { describe, it, expect } from "vitest";
import { quotePastedPath } from "./quote-paste-path.js";

describe("quotePastedPath", () => {
  it("leaves a path of safe characters untouched", () => {
    const p = "/home/me/proj-1/.mullion-uploads/3f2a-uuid/shot_1.png";
    expect(quotePastedPath(p)).toBe(p);
  });

  it("backslash-escapes spaces and shell metacharacters", () => {
    expect(quotePastedPath("/home/me/My Project/a.png")).toBe("/home/me/My\\ Project/a.png");
    expect(quotePastedPath("/h/it's $x;(y)/f")).toBe("/h/it\\'s\\ \\$x\\;\\(y\\)/f");
  });

  it("escapes non-ASCII characters", () => {
    expect(quotePastedPath("/h/é/f")).toBe("/h/\\é/f");
    expect(quotePastedPath("/h/😀/f")).toBe("/h/\\😀/f");
  });
});
