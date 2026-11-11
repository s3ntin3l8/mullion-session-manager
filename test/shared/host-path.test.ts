import { describe, it, expect } from "vitest";
import {
  ABSOLUTE_HOST_PATH_PATTERN,
  hostPathKey,
  isAbsoluteHostPath,
  sameHostPath,
  isStorablePath,
} from "../../src/shared/host-path.js";

describe("host-path", () => {
  it("isAbsoluteHostPath: POSIX and drive paths yes; relative, drive-relative and UNC no", () => {
    for (const ok of ["/srv/app", "D:\\Projects\\app", "d:/Projects/app"]) {
      expect(isAbsoluteHostPath(ok), ok).toBe(true);
    }
    for (const bad of ["code/app", "D:app", "\\\\srv\\share\\app", ""]) {
      expect(isAbsoluteHostPath(bad), bad).toBe(false);
    }
  });

  it("isStorablePath additionally refuses traversal, control characters and overlong paths", () => {
    expect(isStorablePath("D:\\Projects\\app")).toBe(true);
    for (const bad of ["/a/../b", "D:\\a\\..\\b", "D:/a/../b", "/a\nb", `/${"a".repeat(5000)}`]) {
      expect(isStorablePath(bad), bad.slice(0, 20)).toBe(false);
    }
  });

  it("the schema pattern agrees with isAbsoluteHostPath", () => {
    const re = new RegExp(ABSOLUTE_HOST_PATH_PATTERN);
    for (const p of ["/x", "D:\\x", "D:/x", "x", "D:x", "\\\\s\\x"]) {
      expect(re.test(p), p).toBe(isAbsoluteHostPath(p));
    }
  });

  it("sameHostPath: a drive path ignores separator, case, doubled and trailing separators", () => {
    for (const other of ["d:/projects/app", "D:\\Projects\\app\\", "D:/Projects//app"]) {
      expect(sameHostPath("D:\\Projects\\app", other), other).toBe(true);
    }
    expect(sameHostPath("D:\\Projects\\app", "D:\\Projects\\app2")).toBe(false);
    expect(sameHostPath("D:\\a", "E:\\a")).toBe(false);
    expect(hostPathKey("C:\\")).toBe("c:/");
  });

  it("sameHostPath: a POSIX path folds doubled and trailing separators but stays case-sensitive", () => {
    expect(sameHostPath("/srv/app", "/srv/app/")).toBe(true);
    expect(sameHostPath("/srv/app", "/srv//app")).toBe(true);
    expect(sameHostPath("/srv/App", "/srv/app")).toBe(false);
    expect(hostPathKey("/srv/App")).toBe("/srv/App");
    expect(hostPathKey("/")).toBe("/");
    expect(hostPathKey("//")).toBe("/");
    // A backslash is a legal name character on POSIX, so it is not a separator.
    expect(sameHostPath("/srv/a\\b", "/srv/a/b")).toBe(false);
  });
});
