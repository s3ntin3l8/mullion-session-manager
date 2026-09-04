// PR #966 — Hermes review's non-blocking suggestion: a CI smoke test
// against a pinned opencode that asserts the user's `permission` keys
// survive an OPENCODE_CONFIG_CONTENT.permission override, so a future
// shallow-replace behavior change in opencode is caught early.
//
// The PR's core assumption is `OPENCODE_CONFIG_CONTENT.permission`
// deep-merges per top-level key with the user's own
// `~/.config/opencode/opencode.json` / project config (verified
// empirically in issue #968 against opencode v1.18.26). If opencode
// ever changes to shallow-replace, the per-skill deny list this PR
// adds for unattended Task Master workers would silently clobber a
// user's existing `permission.bash` / `permission.edit` /
// `permission.webfetch` rules. This test catches that.
//
// Pinned to opencode 1.18.26 (the version the merge was verified
// against). When opencode changes behavior, this test fails and the
// PR author should re-verify and re-pin.
//
// Skipped gracefully if the `opencode` binary is not on PATH (so
// developers without opencode installed can still run `make test-e2e`).
// CI installs opencode explicitly — see .github/workflows/ci-cd.yml.

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PINNED_OPENCODE_VERSION = "1.18.26";

function opencodeAvailable(): { available: true; version: string } | { available: false } {
  try {
    const version = execFileSync("opencode", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return { available: true, version };
  } catch {
    return { available: false };
  }
}

const probe = opencodeAvailable();
const describeIfOpencode = probe.available ? describe : describe.skip;

describeIfOpencode(
  "opencode OPENCODE_CONFIG_CONTENT.permission deep-merge (PR #966, smoke test for issue #968's verification)",
  () => {
    it("asserts the pinned opencode version matches what the merge was verified against", () => {
      // Defends against an accidental version bump. If this fails after
      // intentionally bumping, the merge posture has to be re-verified
      // (issue #968-style spike) BEFORE the version pin is updated.
      expect(probe.available).toBe(true);
      if (!probe.available) return;
      expect(probe.version).toBe(PINNED_OPENCODE_VERSION);
    });

    it("deep-merges permission: a user's permission.bash / edit / webfetch survive an OPENCODE_CONFIG_CONTENT.permission.skill override", () => {
      if (!probe.available) return;

      const projectDir = mkdtempSync(path.join(tmpdir(), "mullion-opencode-permission-merge-"));
      try {
        // Non-empty user `permission` block — covers BOTH level-1
        // (`bash` / `edit` / `webfetch`) AND nested
        // (`permission.skill.user-skill-1` / `user-skill-2`). The
        // verification in issue #968 showed opencode v1.18.26
        // deep-merges at every level; this test pins the same
        // behavior going forward.
        writeFileSync(
          path.join(projectDir, "opencode.json"),
          JSON.stringify(
            {
              $schema: "https://opencode.ai/config.json",
              permission: {
                bash: "ask",
                edit: "allow",
                webfetch: "deny",
                skill: {
                  "user-skill-1": "deny",
                  "user-skill-2": "ask",
                },
              },
            },
            null,
            2,
          ),
        );

        // The exact shape the opencode adapter writes when an
        // unattended Task Master worker spawns — see
        // src/services/hook-adapters/opencode.ts's prepareLaunch
        // (the `permission.skill` block) and the verification in
        // issue #968.
        const result = execFileSync("opencode", ["debug", "config"], {
          cwd: projectDir,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            // Strip any ambient Mullion env vars so the resolved
            // config is the user's + this override alone.
            OPENCODE_CONFIG_DIR: "",
            OPENCODE_CONFIG_CONTENT: JSON.stringify({
              permission: {
                skill: {
                  brainstorming: "deny",
                  "writing-plans": "deny",
                  "finishing-a-development-branch": "deny",
                },
              },
            }),
          },
        });
        const resolved = JSON.parse(result);

        // Level-1: user's non-skill permission keys must survive
        // (the failure mode Hermes flagged in the review — if
        // opencode shallow-replaces, these would be dropped).
        expect(resolved.permission.bash).toBe("ask");
        expect(resolved.permission.edit).toBe("allow");
        expect(resolved.permission.webfetch).toBe("deny");

        // Level-2: the user's nested `permission.skill` entries
        // must survive alongside the new Mullion denies.
        expect(resolved.permission.skill["user-skill-1"]).toBe("deny");
        expect(resolved.permission.skill["user-skill-2"]).toBe("ask");

        // The new denies must be present (the whole point of the PR).
        expect(resolved.permission.skill.brainstorming).toBe("deny");
        expect(resolved.permission.skill["writing-plans"]).toBe("deny");
        expect(resolved.permission.skill["finishing-a-development-branch"]).toBe("deny");

        // The `permission` key must be present (not silently inert
        // — if opencode ever dropped the key entirely, the deny
        // list would have no effect and #66/#67 would recur).
        expect(resolved.permission).toBeDefined();
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    });

    it("override-on-shared-keys: a user's permission.skill.<name> is overridden when the same key is in OPENCODE_CONFIG_CONTENT (intentional — denying these skills for unattended workers IS the override)", () => {
      // Documents the design choice that users who have, say,
      // `permission.skill.writing-plans: "allow"` in their own
      // config will have it overridden to "deny" for a Task Master
      // worker session. If a future opencode release ever stops
      // honoring override precedence (i.e. switches to append-only
      // merge), this test will fail — the right fix is then to
      // re-pin the opencode version and either widen the deny
      // list explicitly or fall back to reading the user's
      // opencode.json the way services/skills.ts's
      // writeOpenCodeSkillEnabled does.
      if (!probe.available) return;

      const projectDir = mkdtempSync(path.join(tmpdir(), "mullion-opencode-permission-override-"));
      try {
        writeFileSync(
          path.join(projectDir, "opencode.json"),
          JSON.stringify(
            {
              $schema: "https://opencode.ai/config.json",
              permission: {
                skill: {
                  "writing-plans": "allow",
                  "user-only-skill": "ask",
                },
              },
            },
            null,
            2,
          ),
        );

        const result = execFileSync("opencode", ["debug", "config"], {
          cwd: projectDir,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            OPENCODE_CONFIG_DIR: "",
            OPENCODE_CONFIG_CONTENT: JSON.stringify({
              permission: {
                skill: { "writing-plans": "deny" },
              },
            }),
          },
        });
        const resolved = JSON.parse(result);

        // The shared key — user's "allow" clobbered by our "deny"
        // (intentional, this is the whole point of the deny list).
        expect(resolved.permission.skill["writing-plans"]).toBe("deny");
        // The user's untouched skill survives.
        expect(resolved.permission.skill["user-only-skill"]).toBe("ask");
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    });
  },
);

// Stays as a real `describe` (not skipped) so the absence of an
// opencode binary is itself visible in the test output — a developer
// running `make test-e2e` locally will see "skipped: opencode binary
// not found" rather than silently passing. CI installs opencode
// explicitly (see .github/workflows/ci-cd.yml's test-e2e job), so this
// only ever skips in dev.
if (!probe.available) {
  console.warn(
    `[smoke] opencode binary not found on PATH — skipping permission-deep-merge smoke tests. ` +
      `Install opencode@${PINNED_OPENCODE_VERSION} (or update the pin in test/e2e/opencode-permission-merge.e2e.test.ts after re-verifying, per issue #968) to enable.`,
  );
}
