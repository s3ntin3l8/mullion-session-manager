import { describe, it, expect } from "vitest";
import { resolveCliModelRoles, resolveOpencodeModelRoles } from "./modelRoles.js";

// The DOM-free mirror of the backend's install-wide model-role fallback
// (src/services/task-model-resolve.ts). The two families genuinely differ
// in what an UNSET reviewer model means, and the difference is the whole
// reason this module exists:
//
//   - claude-code / codex / agy: resolveCliModel's candidate order ends
//     "... → install-wide reviewer model → install-wide DEFAULT model", so
//     an unset reviewer model means the reviewer runs on the implementer's
//     model.
//   - opencode: resolveOpenCodeModel's install-wide default is role-split
//     (reviewerModel for the reviewer, implementerModel for the
//     implementer) and an unset value resolves to null — no override at
//     all, so opencode's own default applies. The roles do NOT cross-fall
//     back.

describe("resolveCliModelRoles", () => {
  it("reports the roles as shared when the reviewer model is unset", () => {
    // The case that motivated the warning: an unset reviewer model means the
    // reviewer runs on exactly the implementer's model.
    const roles = resolveCliModelRoles("opusplan", null);
    expect(roles.implementer).toBe("opusplan");
    expect(roles.reviewer).toBe("opusplan");
    expect(roles.shared).toBe(true);
  });

  it("reports the roles as shared when both are unset", () => {
    const roles = resolveCliModelRoles(null, null);
    expect(roles.implementer).toBeNull();
    expect(roles.reviewer).toBeNull();
    expect(roles.shared).toBe(true);
  });

  it("reports the roles as distinct when the reviewer names a different model", () => {
    const roles = resolveCliModelRoles("opusplan", "haiku");
    expect(roles.implementer).toBe("opusplan");
    expect(roles.reviewer).toBe("haiku");
    expect(roles.shared).toBe(false);
  });

  it("reports the roles as shared when both name the same model", () => {
    const roles = resolveCliModelRoles("opusplan", "opusplan");
    expect(roles.shared).toBe(true);
  });

  it("treats undefined and null the same", () => {
    expect(resolveCliModelRoles(undefined, undefined)).toEqual(resolveCliModelRoles(null, null));
  });

  it("treats an empty string as unset, like the backend's own candidate loop", () => {
    // resolveCliModel skips any FALSY value (`if (!value) continue`), so
    // an empty string is "unset" on the backend. `??` would report the two
    // roles as distinct where the backend collapses them onto the
    // implementer's model.
    const roles = resolveCliModelRoles("opusplan", "");
    expect(roles.implementer).toBe("opusplan");
    expect(roles.reviewer).toBe("opusplan");
    expect(roles.shared).toBe(true);
  });

  it("treats a stored-but-invalid reviewer model as unset, like the backend", () => {
    // The backend skips a candidate that fails validation and falls through
    // to the next tier, so an invalid `reviewerModel` collapses onto the
    // implementer's model — a REAL collapse the backend performs. Reporting
    // the two as distinct would hide it.
    const roles = resolveCliModelRoles("opusplan", "not a valid model!");
    expect(roles.implementer).toBe("opusplan");
    expect(roles.reviewer).toBe("opusplan");
    expect(roles.shared).toBe(true);
  });

  it("treats a stored-but-invalid implementer model as no model at all", () => {
    // The same fall-through, the other direction: an invalid `defaultModel`
    // leaves the implementer with NO model, so the backend applies no model
    // to either role. Keeping the bad name would make the note name a
    // model that will never be applied.
    const roles = resolveCliModelRoles("not a valid model!", null);
    expect(roles.implementer).toBeNull();
    expect(roles.reviewer).toBeNull();
    expect(roles.shared).toBe(true);
  });
});

describe("resolveOpencodeModelRoles", () => {
  it("does NOT fall back to the implementer model when the reviewer is unset", () => {
    // The distinction from resolveCliModelRoles: opencode's roles have
    // separate settings and neither inherits the other, so an unset
    // reviewer model means "no override" (opencode's own default), not
    // "the implementer's model".
    const roles = resolveOpencodeModelRoles("opencode-go/minimax-m3.1-flash-free", null);
    expect(roles.implementer).toBe("opencode-go/minimax-m3.1-flash-free");
    expect(roles.reviewer).toBeNull();
    expect(roles.shared).toBe(false);
  });

  it("reports the roles as shared when both name the same model", () => {
    const roles = resolveOpencodeModelRoles(
      "opencode-go/minimax-m3.1-flash-free",
      "opencode-go/minimax-m3.1-flash-free",
    );
    expect(roles.shared).toBe(true);
  });

  it("reports the roles as shared when both are unset", () => {
    // Both unset → both fall to opencode's own default → the same model.
    const roles = resolveOpencodeModelRoles(null, null);
    expect(roles.shared).toBe(true);
  });

  it("reports the roles as distinct when the reviewer names a different model", () => {
    const roles = resolveOpencodeModelRoles(
      "opencode-go/minimax-m3.1-flash-free",
      "opencode-go/claude-haiku-5-5",
    );
    expect(roles.shared).toBe(false);
  });

  it("treats a stored-but-invalid opencode model as unset, like the backend", () => {
    // opencode's `validateModel` requires a `provider/model` shape, so a
    // bare name is skipped and the role ends up with no override at all.
    const roles = resolveOpencodeModelRoles("opencode-go/minimax-m3.1-flash-free", "haiku");
    expect(roles.implementer).toBe("opencode-go/minimax-m3.1-flash-free");
    expect(roles.reviewer).toBeNull();
    expect(roles.shared).toBe(false);
  });
});
