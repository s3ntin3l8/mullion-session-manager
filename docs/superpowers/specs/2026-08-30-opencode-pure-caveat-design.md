# Design: Document `opencode --pure` Mullion Integration Caveat

**Issue:** #927
**Date:** 2026-08-30
**Status:** Approved

## Problem

opencode's `--pure` flag ("run without external plugins") disables the JS
plugin loading mechanism. Mullion's opencode integration uses two channels:

1. **JS plugin file** (`src/hooks/opencode-plugin.js`) — loaded via
   opencode's plugin loader from `OPENCODE_CONFIG_DIR/plugins/`
2. **Environment variables** — `OPENCODE_CONFIG_CONTENT` (instructions,
   skills.paths) and `OPENCODE_CONFIG_DIR`, set in the process env before
   opencode starts

`--pure` definitely voids channel 1 (the plugin). Whether it also voids
channel 2 (env-var-based config) was the open question.

## Empirical Findings

Tested by running `opencode debug config` with `OPENCODE_CONFIG_CONTENT` and
`OPENCODE_CONFIG_DIR` set, with and without `--pure`:

| What                                                   | `--pure` effect                                  |
| ------------------------------------------------------ | ------------------------------------------------ |
| `OPENCODE_CONFIG_CONTENT` (instructions, skills.paths) | **Survives**                                     |
| `OPENCODE_CONFIG_DIR` (config dir loading)             | **Survives**                                     |
| JS plugin loader                                       | **Disabled** (plugin file not loaded at runtime) |

**Conclusion:** `--pure` only voids the JS plugin file, not the env-var-based
config. `OPENCODE_CONFIG_CONTENT`'s `instructions` and `skills.paths` keys
are still read and merged by opencode even under `--pure`.

## Scope

1. ~~Empirically confirm whether `--pure` voids `OPENCODE_CONFIG_CONTENT` keys~~ ✅
2. Document the interaction in `docs/agent-hooks.md`
3. Confirm no editor surface exists for launcher-config warnings (docs-only)
4. Update other `docs/*.md` if relevant

## Design

### Documentation Changes

**`docs/agent-hooks.md`** — add after the opencode-MCP section
(~line 348, after `buildOpenCodeMcpConfig`), before the full-context
carryover section:

> **The `--pure` caveat:** opencode's `--pure` flag ("run without external
> plugins") disables the JS plugin loading mechanism. Mullion's
> `opencode-plugin.js` — which provides the hook forwarder, the
> `promote_to_worktree` tool, and all event forwarding — is loaded via that
> mechanism, so `--pure` voids it entirely. However,
> `OPENCODE_CONFIG_CONTENT` (instructions, skills.paths) and
> `OPENCODE_CONFIG_DIR` are env-var-based, not plugin-loaded; confirmed to
> survive `--pure`. Avoid `--pure` in launcher commands unless you
> deliberately want a stripped-down session without Mullion's hook
> integration.

### Launcher-Config Warning

No UI code changes. The `--pure` caveat in `docs/agent-hooks.md` serves as
the warning, matching #883's pattern for `--bare`.

## Scope Boundaries

**In scope:** documentation, caveat in agent-hooks.md
**Out of scope:** launcher-config warning UI, changes to opencode's `--pure`
behavior, changes to Mullion's plugin loading mechanism
