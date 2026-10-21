# CLAUDE.md — Mullion

<!-- mullion:pointer:start -->

@AGENTS.md

The line above is a Claude Code import, not a link: it expands AGENTS.md into
this session's context at launch. AGENTS.md is this repo's single source of
truth for agent instructions (issue #942); Claude Code does not read it on
its own, so this import is what delivers it.

<!-- mullion:pointer:end -->

## Claude Code only

- The self-review pass AGENTS.md asks for is `/code-review` in Claude Code.
  `.claude/skills/mullion-review-invariants/SKILL.md` carries this repo's
  invariants in mechanically-checkable form.
- Architecture: [`docs/architecture.md`](docs/architecture.md) ·
  CI/CD: [`docs/ci-cd.md`](docs/ci-cd.md) ·
  Contributing: [`CONTRIBUTING.md`](CONTRIBUTING.md)
