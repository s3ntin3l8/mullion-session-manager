# Changelog

## [0.1.3](https://github.com/s3ntin3l8/claude-remote-session/compare/v0.1.2...v0.1.3) (2026-07-16)


### Features

* add pi coding agent support with official logo ([bdd2350](https://github.com/s3ntin3l8/claude-remote-session/commit/bdd235045a8b90719c8ce73c993d38518ef1dab6))
* backend support for the UI redesign (server-info, project edit, group color) ([b37a4ce](https://github.com/s3ntin3l8/claude-remote-session/commit/b37a4ceba2cfbf89148111c5c9b16f0825ad41aa))
* design tokens/theming + API/store plumbing for the UI redesign ([15948c3](https://github.com/s3ntin3l8/claude-remote-session/commit/15948c3e22fc9202985c6c0295e9ef5b4bcee862))
* frontend redesign foundation — fonts, icons, vitest, reorder logic ([13b0eda](https://github.com/s3ntin3l8/claude-remote-session/commit/13b0eda402affceb729aee12c85530df02c40d66))
* inline "New workspace" input in place of the button ([cf07656](https://github.com/s3ntin3l8/claude-remote-session/commit/cf0765671c74c7fd06a5b44b5e31f8e000ac5b65))
* pane chrome, split actions, connection/failure states, app wiring ([8c15dd0](https://github.com/s3ntin3l8/claude-remote-session/commit/8c15dd053c0825c07f0b33e974c3f71927f70c56))
* show official CLI logos in the session launcher ([0da413f](https://github.com/s3ntin3l8/claude-remote-session/commit/0da413fbc8c66f8cf68443123ae6e5b492425445))
* sidebar redesign — groups, status badges, discovery, dock, drag-and-drop ([5de60e5](https://github.com/s3ntin3l8/claude-remote-session/commit/5de60e59489db0f25a2e9ed9b68c4021124a1bba))
* toolbar, settings, command palette, and shared modal components ([2f81f4c](https://github.com/s3ntin3l8/claude-remote-session/commit/2f81f4ccb676da0e199952aa752d230cb3c70780))


### Bug Fixes

* batch of small UX/correctness fixes across sidebar, sessions, theming ([be14879](https://github.com/s3ntin3l8/claude-remote-session/commit/be14879cae0fb39653434cd81f7aba41adfaa7a9))
* workspace drag-to-reorder cancelling instantly for ungrouped items ([3e73061](https://github.com/s3ntin3l8/claude-remote-session/commit/3e730618f78f5fb077ccf96a4403e7ce60630f9a))

## [0.1.2](https://github.com/s3ntin3l8/claude-remote-session/compare/v0.1.1...v0.1.2) (2026-07-12)


### Features

* retroactive changelog entry for discovery/launchers/groups/dock/status plumbing ([bf2eb58](https://github.com/s3ntin3l8/claude-remote-session/commit/bf2eb5870c1d84f4a60b0f14b32dabea63b891cc))


### Bug Fixes

* correct invalid identify tags in .pre-commit-config.yaml ([#3](https://github.com/s3ntin3l8/claude-remote-session/issues/3)) ([cc93c58](https://github.com/s3ntin3l8/claude-remote-session/commit/cc93c586b74199185632fc799dcdb066d5c07f76))

## [0.1.1](https://github.com/s3ntin3l8/claude-remote-session/compare/v0.1.0...v0.1.1) (2026-07-12)


### Features

* M1 vertical slice — dtach terminal bridge, verified GO ([554af52](https://github.com/s3ntin3l8/claude-remote-session/commit/554af5273c571def19f34c100ceb50267857a994))
* M2 multi-session backend — Drizzle registry + REST API, verified GO ([e9ec984](https://github.com/s3ntin3l8/claude-remote-session/commit/e9ec984d81fd2010a5c36bdf20ce12a5f01e07a1))
* M3 tiled frontend — Vite/React/dockview dashboard, verified GO ([b2d5540](https://github.com/s3ntin3l8/claude-remote-session/commit/b2d554022ad0a8a024b416646b5000e47e72632d))
* M4 deployment prep — Dockerfile fix, static serving, drafted deploy configs ([48427fc](https://github.com/s3ntin3l8/claude-remote-session/commit/48427fc9d7a3307ed808381943cbc997c5046d2f))
* M5 polish — reconnect/backpressure, key conflicts, mobile layout, coverage floor ([0199c5c](https://github.com/s3ntin3l8/claude-remote-session/commit/0199c5c497a1ffff0cdd791c98c7da774086209c))
* named workspaces — persistent, switchable dockview layouts (cmux gap [#1](https://github.com/s3ntin3l8/claude-remote-session/issues/1)) ([b9158f4](https://github.com/s3ntin3l8/claude-remote-session/commit/b9158f450abc96fe8e888bfb70144bbe84033705))


### Bug Fixes

* allowlist secrets: inherit false positives, enable strict detect-secrets ([fbf51b5](https://github.com/s3ntin3l8/claude-remote-session/commit/fbf51b5dd070831d168607499a5211268a58f512))
* attribute LICENSE copyright to Björn Hansen, not the s3ntin3l8 handle ([92039de](https://github.com/s3ntin3l8/claude-remote-session/commit/92039de19fa11b18cb7c5218746b8ec56a5325fc))
* emit raw json coverage report for Codecov ingestion ([3321b93](https://github.com/s3ntin3l8/claude-remote-session/commit/3321b935218dce4581ec50f3d30bfd21b2af5d64))
* override esbuild to 0.28.1 to close two moderate advisories ([0f0378f](https://github.com/s3ntin3l8/claude-remote-session/commit/0f0378f39116430c2ce1cce2f951017370be07d9))
* use mkdtempSync for test temp dirs, closing CodeQL alert [#1](https://github.com/s3ntin3l8/claude-remote-session/issues/1) ([efc5b62](https://github.com/s3ntin3l8/claude-remote-session/commit/efc5b62fbb10d40f0a1830555ffc0ecaaa6f0c04))

## Changelog

All notable changes to this project will be documented here by
[Release Please](https://github.com/googleapis/release-please), driven by
[Conventional Commits](https://www.conventionalcommits.org/).
