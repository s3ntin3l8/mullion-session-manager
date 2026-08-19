# Changelog

## [0.2.34](https://github.com/s3ntin3l8/mullion-session-manager/compare/v0.2.33...v0.2.34) (2026-08-19)


### Bug Fixes

* keep a small pane's terminal grid in sync with the clamped PTY size ([#708](https://github.com/s3ntin3l8/mullion-session-manager/issues/708)) ([d52362e](https://github.com/s3ntin3l8/mullion-session-manager/commit/d52362e3ae52a0e6c85f529654ca558763b1edc3))
* make the attention cue span the pane header and stop tab chrome overflowing ([#709](https://github.com/s3ntin3l8/mullion-session-manager/issues/709)) ([b944a3c](https://github.com/s3ntin3l8/mullion-session-manager/commit/b944a3c084ec8cb7eff351c3b7a8b5f9c141ac93))

## [0.2.33](https://github.com/s3ntin3l8/mullion-session-manager/compare/v0.2.32...v0.2.33) (2026-08-18)


### Bug Fixes

* add a newline key to the mobile terminal key bar ([#703](https://github.com/s3ntin3l8/mullion-session-manager/issues/703)) ([3d7de54](https://github.com/s3ntin3l8/mullion-session-manager/commit/3d7de548424291c08992b1bd9a0de883996cfd00))
* make the new-session palette usable with the keyboard open on mobile ([#705](https://github.com/s3ntin3l8/mullion-session-manager/issues/705)) ([e2ab24d](https://github.com/s3ntin3l8/mullion-session-manager/commit/e2ab24d4cdd7fd6dd567b4d196b4e1987b4caba4))
* make the terminal scrollable by touch on mobile ([#704](https://github.com/s3ntin3l8/mullion-session-manager/issues/704)) ([15ddac7](https://github.com/s3ntin3l8/mullion-session-manager/commit/15ddac72f7d4e48e6895e663d40d64815482d398))

## [0.2.32](https://github.com/s3ntin3l8/mullion-session-manager/compare/v0.2.31...v0.2.32) (2026-08-17)


### Features

* display task hierarchy (sub-issues) on the Tasks board ([#702](https://github.com/s3ntin3l8/mullion-session-manager/issues/702)) ([65c0b3d](https://github.com/s3ntin3l8/mullion-session-manager/commit/65c0b3dba33b76dbdf9aa62e9dc033558f01d5c6))


### Bug Fixes

* resolve stuck dependency badges, highlight blockers, fix Tasks nav trap ([#699](https://github.com/s3ntin3l8/mullion-session-manager/issues/699)) ([c8dc97d](https://github.com/s3ntin3l8/mullion-session-manager/commit/c8dc97d8556b28127dfb6daa25129f1620a23a9c))

## [0.2.31](https://github.com/s3ntin3l8/mullion-session-manager/compare/v0.2.30...v0.2.31) (2026-08-16)


### Features

* carry full opencode conversation history into a promoted worktree session ([#696](https://github.com/s3ntin3l8/mullion-session-manager/issues/696)) ([ada9812](https://github.com/s3ntin3l8/mullion-session-manager/commit/ada98128d25b7d6725cb73484f7c9f52fda1cb38))


### Bug Fixes

* default promote/launcher base-ref pickers to origin/&lt;default&gt;, not the current branch ([#695](https://github.com/s3ntin3l8/mullion-session-manager/issues/695)) ([ca545fb](https://github.com/s3ntin3l8/mullion-session-manager/commit/ca545fb018c9a7490d9b5dc6c7a72ca1b4169b8b))

## [0.2.30](https://github.com/s3ntin3l8/mullion-session-manager/compare/v0.2.29...v0.2.30) (2026-08-16)


### Bug Fixes

* anchor promote's worktree creation at the project root, not the source session's cwd ([#693](https://github.com/s3ntin3l8/mullion-session-manager/issues/693)) ([37dd0c1](https://github.com/s3ntin3l8/mullion-session-manager/commit/37dd0c1a79f42fde4137573190bdbce57d59ad88))

## [0.2.29](https://github.com/s3ntin3l8/mullion-session-manager/compare/v0.2.28...v0.2.29) (2026-08-15)


### Bug Fixes

* contain projects.test.ts's SocketAlreadyListeningError cascade ([#690](https://github.com/s3ntin3l8/mullion-session-manager/issues/690)) ([bdaaf20](https://github.com/s3ntin3l8/mullion-session-manager/commit/bdaaf203a13fe280fda30e4f9a2f2d07610c387f))
* defer TerminalPane's initial connect until the first post-layout measurement ([#689](https://github.com/s3ntin3l8/mullion-session-manager/issues/689)) ([2a3ce8f](https://github.com/s3ntin3l8/mullion-session-manager/commit/2a3ce8f70d0ec71068bf1c0ebfb6853c37deefd4))
* floor terminal geometry so a garbage-tiny resize can't kill a session ([#686](https://github.com/s3ntin3l8/mullion-session-manager/issues/686)) ([875dc26](https://github.com/s3ntin3l8/mullion-session-manager/commit/875dc26d08adc97ca13c6e436f4de73234227b30))
* submit promote's seed as opencode's first turn instead of silent context ([#688](https://github.com/s3ntin3l8/mullion-session-manager/issues/688)) ([fcb946c](https://github.com/s3ntin3l8/mullion-session-manager/commit/fcb946ced7de4e678ad3856f4dbdbf7612865fa6))

## [0.2.28](https://github.com/s3ntin3l8/mullion-session-manager/compare/v0.2.27...v0.2.28) (2026-08-14)


### Features

* dependency-aware task claiming ([#669](https://github.com/s3ntin3l8/mullion-session-manager/issues/669)) ([fa0db68](https://github.com/s3ntin3l8/mullion-session-manager/commit/fa0db6843623afe94d4ec858e0c8cf6a669ab565))
* fix kanban board layout bugs, add a project filter, and make Tasks a top-level destination ([#668](https://github.com/s3ntin3l8/mullion-session-manager/issues/668)) ([076524e](https://github.com/s3ntin3l8/mullion-session-manager/commit/076524e459e57d54138cf3a6d0d7a18215f6df59))
* refresh session status from the /ws/events push instead of only the 4s poll ([#682](https://github.com/s3ntin3l8/mullion-session-manager/issues/682)) ([4eb06ba](https://github.com/s3ntin3l8/mullion-session-manager/commit/4eb06bae158c5453c7fb0972d939f383b90ced66)), closes [#673](https://github.com/s3ntin3l8/mullion-session-manager/issues/673)
* surface blocked tasks on the board and push dependency updates ([#670](https://github.com/s3ntin3l8/mullion-session-manager/issues/670)) ([190e8df](https://github.com/s3ntin3l8/mullion-session-manager/commit/190e8df092b119e90ccc57e807d83e9a04f21afa))


### Bug Fixes

* createWorktree returns discriminated errors instead of bare null ([#683](https://github.com/s3ntin3l8/mullion-session-manager/issues/683)) ([ee57521](https://github.com/s3ntin3l8/mullion-session-manager/commit/ee5752142a3dc8e8ad36dd4187b6f7de61775bad))
* promote-to-worktree base ref, replacement handoff, and 429 storm ([#680](https://github.com/s3ntin3l8/mullion-session-manager/issues/680)) ([2b18b50](https://github.com/s3ntin3l8/mullion-session-manager/commit/2b18b5045490685bcd91566351522096b0fae84a))
* promote's seed prompt race and opencode delivery channel ([#678](https://github.com/s3ntin3l8/mullion-session-manager/issues/678)) ([#684](https://github.com/s3ntin3l8/mullion-session-manager/issues/684)) ([a28b754](https://github.com/s3ntin3l8/mullion-session-manager/commit/a28b7541515a27653efbc6c9879a757fdcab741e))
* recover from forward-auth session expiry instead of a stuck banner ([#672](https://github.com/s3ntin3l8/mullion-session-manager/issues/672)) ([fbc75ae](https://github.com/s3ntin3l8/mullion-session-manager/commit/fbc75ae4e90fff0c961b74041d96fab6a9662a94))
* stop needs_input from sticking on a working Claude Code session, and mislabelled plan/question dialogs ([#675](https://github.com/s3ntin3l8/mullion-session-manager/issues/675)) ([2f32beb](https://github.com/s3ntin3l8/mullion-session-manager/commit/2f32bebab442a4bdf61b90a329eb99875facf2f8))
* surface remote promote-resolve failures as warnings, not a bare 500 ([#685](https://github.com/s3ntin3l8/mullion-session-manager/issues/685)) ([ede5eaa](https://github.com/s3ntin3l8/mullion-session-manager/commit/ede5eaaa4c81b8b99cf9477fa9f55b37ac8308b7))
* use the live idle threshold for web-push status gating ([#681](https://github.com/s3ntin3l8/mullion-session-manager/issues/681)) ([2d09370](https://github.com/s3ntin3l8/mullion-session-manager/commit/2d093707b336f81c7f76c49aee7a86d824c85b32)), closes [#674](https://github.com/s3ntin3l8/mullion-session-manager/issues/674)

## [0.2.27](https://github.com/s3ntin3l8/mullion-session-manager/compare/v0.2.26...v0.2.27) (2026-08-13)


### Features

* 7.8: agent auto-update ([#652](https://github.com/s3ntin3l8/mullion-session-manager/issues/652)) ([4d507f8](https://github.com/s3ntin3l8/mullion-session-manager/commit/4d507f8f1169a697b5fa7aaa807b0aeb9f23b53a))
* add a mobile terminal key bar for Esc/Tab/Shift+Tab/Ctrl+C ([#616](https://github.com/s3ntin3l8/mullion-session-manager/issues/616)) ([9c0e3cc](https://github.com/s3ntin3l8/mullion-session-manager/commit/9c0e3ccbf9701b81f408c077ba844369ff99ad1c))
* add PWA install screenshots and README imagery ([#654](https://github.com/s3ntin3l8/mullion-session-manager/issues/654)) ([40e4717](https://github.com/s3ntin3l8/mullion-session-manager/commit/40e4717dbd7a10925596ae782174925e604864cc))
* add ui/Modal with focus trap, Escape, and ARIA; migrate PromoteDialog ([#642](https://github.com/s3ntin3l8/mullion-session-manager/issues/642)) ([a18d10b](https://github.com/s3ntin3l8/mullion-session-manager/commit/a18d10b0caf22dc6a964d35f66ad804e69310763))
* make Settings usable on mobile ([#621](https://github.com/s3ntin3l8/mullion-session-manager/issues/621)) ([0e6c735](https://github.com/s3ntin3l8/mullion-session-manager/commit/0e6c7351185bf3e4bab5e7c54fdf63f87603b331))
* reflow the mobile layout around the on-screen keyboard ([#615](https://github.com/s3ntin3l8/mullion-session-manager/issues/615)) ([9772598](https://github.com/s3ntin3l8/mullion-session-manager/commit/97725988620f0ebb35e6b15409177b1784d835af))
* require confirmation before creating a missing project directory ([#620](https://github.com/s3ntin3l8/mullion-session-manager/issues/620)) ([712e013](https://github.com/s3ntin3l8/mullion-session-manager/commit/712e013256b25820e902789cc97aa30dba20e256))


### Bug Fixes

* bind loopback by default, require explicit MULLION_TRUST_GATEWAY opt-out ([#611](https://github.com/s3ntin3l8/mullion-session-manager/issues/611)) ([341cd3f](https://github.com/s3ntin3l8/mullion-session-manager/commit/341cd3fdb5a353611ea0c619b62d0ffe2fcb753f))
* deduplicate mobile pane chrome and sidebar toggle ([#613](https://github.com/s3ntin3l8/mullion-session-manager/issues/613)) ([df785ad](https://github.com/s3ntin3l8/mullion-session-manager/commit/df785ade2351d3186157dfaef8a5cc3f9ba39ada))
* **deps:** override sharp to ^0.35.0 in the frontend workspace ([#601](https://github.com/s3ntin3l8/mullion-session-manager/issues/601)) ([fded9c4](https://github.com/s3ntin3l8/mullion-session-manager/commit/fded9c477a71fb0a508e9503e2a3f8988b23fef5))
* give every dockview panel heading a left inset, fix panel-body drift ([#650](https://github.com/s3ntin3l8/mullion-session-manager/issues/650)) ([49a4d5c](https://github.com/s3ntin3l8/mullion-session-manager/commit/49a4d5c48907b58c075cdfda263956dab112acfb))
* harden resolveWithinRoots and dock-config against pre-planted symlinks ([#612](https://github.com/s3ntin3l8/mullion-session-manager/issues/612)) ([c98d609](https://github.com/s3ntin3l8/mullion-session-manager/commit/c98d6091dd9ff7c543243c6269d153a211ca7f44))
* overhaul the kanban board's layout, mobile support, and drawer ([#610](https://github.com/s3ntin3l8/mullion-session-manager/issues/610)) ([f11c75d](https://github.com/s3ntin3l8/mullion-session-manager/commit/f11c75dda8cadd0a9645ef558d706c7184bec629))
* run make test/lint/typecheck across both workspaces, fix e2e worktree exclude gap ([#614](https://github.com/s3ntin3l8/mullion-session-manager/issues/614)) ([9dd49b5](https://github.com/s3ntin3l8/mullion-session-manager/commit/9dd49b56b4268fd7a8ced0a49e54a41fe5ef966d))

## [0.2.26](https://github.com/s3ntin3l8/mullion-session-manager/compare/v0.2.25...v0.2.26) (2026-08-10)


### Features

* add per-session cgroup process inventory ([#566](https://github.com/s3ntin3l8/mullion-session-manager/issues/566)) ([eb14e12](https://github.com/s3ntin3l8/mullion-session-manager/commit/eb14e1285428d16eba2010e408330be20e2089cc))
* add sidebar filtering, persisted collapse state, and virtualization ([#583](https://github.com/s3ntin3l8/mullion-session-manager/issues/583)) ([9e52b4b](https://github.com/s3ntin3l8/mullion-session-manager/commit/9e52b4b0f3c13ca1c2103412b32b9ad848b90ce8))
* add terminal scrollback search ([#578](https://github.com/s3ntin3l8/mullion-session-manager/issues/578)) ([84ceae0](https://github.com/s3ntin3l8/mullion-session-manager/commit/84ceae0808078a7f0116e6f5693de81d4f11a8e7))
* capture review findings and auto-return one round to the worker ([#580](https://github.com/s3ntin3l8/mullion-session-manager/issues/580)) ([909aaf9](https://github.com/s3ntin3l8/mullion-session-manager/commit/909aaf98f223802d32eddc96b7afbfb6f68e34e1))
* connection-time SSRF pinning for outbound host/preview connections (issue [#250](https://github.com/s3ntin3l8/mullion-session-manager/issues/250)) ([#567](https://github.com/s3ntin3l8/mullion-session-manager/issues/567)) ([fda6051](https://github.com/s3ntin3l8/mullion-session-manager/commit/fda60513c879d2f18101ab2339d77b40cfd2f129))
* make a project's dock config editable from the UI ([#586](https://github.com/s3ntin3l8/mullion-session-manager/issues/586)) ([919aa1c](https://github.com/s3ntin3l8/mullion-session-manager/commit/919aa1cde7a50b69eba8269b340765755a4f48be))
* open a draft PR when a task enters review ([#574](https://github.com/s3ntin3l8/mullion-session-manager/issues/574)) ([3420d9e](https://github.com/s3ntin3l8/mullion-session-manager/commit/3420d9eed7d6e3af87227d9f65a46328dab18bef))
* search sessions and workspaces from the command palette ([#581](https://github.com/s3ntin3l8/mullion-session-manager/issues/581)) ([3463bbc](https://github.com/s3ntin3l8/mullion-session-manager/commit/3463bbc6813a99089c761d4e162e226aad992f77))
* show PR and CI status on task cards ([#582](https://github.com/s3ntin3l8/mullion-session-manager/issues/582)) ([1497c7d](https://github.com/s3ntin3l8/mullion-session-manager/commit/1497c7d1f8af670c55426401c6a6f31f6a0ffde5))
* support dock preview worktrees on remote hosts ([0a39024](https://github.com/s3ntin3l8/mullion-session-manager/commit/0a3902432442003a743d41db01f828bd61a0dd04))
* Task Master support for remote-hosted projects ([36c54d3](https://github.com/s3ntin3l8/mullion-session-manager/commit/36c54d362269e2f7118770237c6e449ff90a4843)), closes [#484](https://github.com/s3ntin3l8/mullion-session-manager/issues/484)
* tell Task Master agents how the loop actually works ([#569](https://github.com/s3ntin3l8/mullion-session-manager/issues/569)) ([2cdfdc4](https://github.com/s3ntin3l8/mullion-session-manager/commit/2cdfdc456cd2e028068b8bd08b93f1853c52229e))


### Bug Fixes

* add keyboard accessibility and focus management to core controls ([#592](https://github.com/s3ntin3l8/mullion-session-manager/issues/592)) ([0773cca](https://github.com/s3ntin3l8/mullion-session-manager/commit/0773ccafdbe248627edc7bf501e02e89307e6bff))
* add timeouts, backpressure, and cleanup guards to git/PTY subprocess plumbing ([#587](https://github.com/s3ntin3l8/mullion-session-manager/issues/587)) ([c9fa821](https://github.com/s3ntin3l8/mullion-session-manager/commit/c9fa8214309a937dfcee3a4ada592fbff3c67eed))
* close CSRF gap, unify auth-token checks, and validate the encryption key length ([#570](https://github.com/s3ntin3l8/mullion-session-manager/issues/570)) ([a30d2ce](https://github.com/s3ntin3l8/mullion-session-manager/commit/a30d2ce17a72ee2a845410311ef198327816429c))
* correct dock worktree restart, GitPanel session open, and pane focus bugs ([#588](https://github.com/s3ntin3l8/mullion-session-manager/issues/588)) ([fbbd4a2](https://github.com/s3ntin3l8/mullion-session-manager/commit/fbbd4a26396a32b4538b242b89c15bc59aad3c29))
* don't open a panel when a task is claimed or retried manually ([#572](https://github.com/s3ntin3l8/mullion-session-manager/issues/572)) ([492d252](https://github.com/s3ntin3l8/mullion-session-manager/commit/492d252aa96835411c029792d49df8829a61ef7b))
* harden preview proxy header forwarding and webhook signature verification ([#575](https://github.com/s3ntin3l8/mullion-session-manager/issues/575)) ([43556df](https://github.com/s3ntin3l8/mullion-session-manager/commit/43556df13fa6bfa5e417cb99ed8a90cafe3b89c1))
* pre-trust a session's worktree so agy doesn't stall on a folder-trust prompt ([#573](https://github.com/s3ntin3l8/mullion-session-manager/issues/573)) ([81db934](https://github.com/s3ntin3l8/mullion-session-manager/commit/81db93481c6bc67f0652b566825f7d743ea57ae3))
* prevent env leakage, state loss, and orphaned sessions in the PTY lifecycle ([#584](https://github.com/s3ntin3l8/mullion-session-manager/issues/584)) ([ce203c6](https://github.com/s3ntin3l8/mullion-session-manager/commit/ce203c6a6914fda1e16b8663c11adb84580e8cbd))
* replace hardcoded /home/bjoern test path with a portable temp dir ([#585](https://github.com/s3ntin3l8/mullion-session-manager/issues/585)) ([7c289fb](https://github.com/s3ntin3l8/mullion-session-manager/commit/7c289fb9a7fa7b82f674c8a45aabe2fed2f743c1))


### Performance Improvements

* coalesce title_change events instead of persisting every OSC title update ([#593](https://github.com/s3ntin3l8/mullion-session-manager/issues/593)) ([c2f5213](https://github.com/s3ntin3l8/mullion-session-manager/commit/c2f5213ed2e79a360a4ac90f5619b70ffc036942))
* enable WAL mode, add missing indexes, compress static assets, and fix the sessions N+1 ([#591](https://github.com/s3ntin3l8/mullion-session-manager/issues/591)) ([7df0f06](https://github.com/s3ntin3l8/mullion-session-manager/commit/7df0f06c29e850afc3ecee1f0118fc9f4bbfbc39))
* replace whole-store subscriptions with selectors across the frontend ([#571](https://github.com/s3ntin3l8/mullion-session-manager/issues/571)) ([aefffc2](https://github.com/s3ntin3l8/mullion-session-manager/commit/aefffc2869c76041f2b4bbdebda4c8505337b02e))

## [0.2.25](https://github.com/s3ntin3l8/mullion-session-manager/compare/v0.2.24...v0.2.25) (2026-08-09)


### Features

* add per-session event retention cap (issue [#213](https://github.com/s3ntin3l8/mullion-session-manager/issues/213)'s max-events bound) ([#563](https://github.com/s3ntin3l8/mullion-session-manager/issues/563)) ([a97f487](https://github.com/s3ntin3l8/mullion-session-manager/commit/a97f4872dfd518d851dc73a2b6c4392f0edeb7e6))
* browse persisted session-event history in the timeline panel (issue [#213](https://github.com/s3ntin3l8/mullion-session-manager/issues/213), roadmap 4.7) ([#560](https://github.com/s3ntin3l8/mullion-session-manager/issues/560)) ([ecc4e0e](https://github.com/s3ntin3l8/mullion-session-manager/commit/ecc4e0e2f8b75f8f6549dd13d10cd92dd273f262))
* capture cross-host session events, closing the last gap in issue [#213](https://github.com/s3ntin3l8/mullion-session-manager/issues/213) ([#564](https://github.com/s3ntin3l8/mullion-session-manager/issues/564)) ([05b57f0](https://github.com/s3ntin3l8/mullion-session-manager/commit/05b57f00ad543724b859de7b086389fb9eb4bbd5))
* discover Docker Compose services in the Dock (issue [#73](https://github.com/s3ntin3l8/mullion-session-manager/issues/73)) ([#561](https://github.com/s3ntin3l8/mullion-session-manager/issues/561)) ([80dddfe](https://github.com/s3ntin3l8/mullion-session-manager/commit/80dddfee7b5f14389ff056d8238179b2db6f6487))

## [0.2.24](https://github.com/s3ntin3l8/mullion-session-manager/compare/v0.2.23...v0.2.24) (2026-08-08)


### Features

* add iOS home-screen splash screens and fix manifest auth ([#559](https://github.com/s3ntin3l8/mullion-session-manager/issues/559)) ([e7b1ac3](https://github.com/s3ntin3l8/mullion-session-manager/commit/e7b1ac31e9ebeec67523c3e953d7fc362bdc51f0))


### Bug Fixes

* use web-push's default export, not a named import ([#556](https://github.com/s3ntin3l8/mullion-session-manager/issues/556)) ([48ac8f2](https://github.com/s3ntin3l8/mullion-session-manager/commit/48ac8f2e85160b9e687965259208163cd8379956))

## [0.2.23](https://github.com/s3ntin3l8/mullion-session-manager/compare/v0.2.22...v0.2.23) (2026-08-08)


### Features

* add a service worker with auto-update ([#546](https://github.com/s3ntin3l8/mullion-session-manager/issues/546)) ([4c6b768](https://github.com/s3ntin3l8/mullion-session-manager/commit/4c6b768a8cdcfc3ae6f3e2092c32be0fcc83df16))
* add layout-compat shim for tasks panel removal ([#539](https://github.com/s3ntin3l8/mullion-session-manager/issues/539)) ([34c56b5](https://github.com/s3ntin3l8/mullion-session-manager/commit/34c56b5c912a42997c2ac40a7ab1357c7fc4de2d))
* complete the PWA manifest and iOS integration ([#542](https://github.com/s3ntin3l8/mullion-session-manager/issues/542)) ([8f869db](https://github.com/s3ntin3l8/mullion-session-manager/commit/8f869db4d06ddc7ee52397a02d32709d68414d62))
* deep-link to a session via a query param ([#548](https://github.com/s3ntin3l8/mullion-session-manager/issues/548)) ([83c926a](https://github.com/s3ntin3l8/mullion-session-manager/commit/83c926a835772b2e1027f746dce1cac54dc52c94))
* deliver session notifications via web push (backend) ([#550](https://github.com/s3ntin3l8/mullion-session-manager/issues/550)) ([b8a8d11](https://github.com/s3ntin3l8/mullion-session-manager/commit/b8a8d115b255a3bedc5df65d5e50bafbd5e7a13b))
* merge the Tasks panel into a unified Kanban board ([#545](https://github.com/s3ntin3l8/mullion-session-manager/issues/545)) ([2b9ea83](https://github.com/s3ntin3l8/mullion-session-manager/commit/2b9ea8370396dc630c801a2d3773afa330025469))
* open the session timeline from notification rows ([#541](https://github.com/s3ntin3l8/mullion-session-manager/issues/541)) ([a768640](https://github.com/s3ntin3l8/mullion-session-manager/commit/a768640246715a8870e4a1b962374ab3d3f19781))
* persist web push subscriptions and VAPID keys ([#549](https://github.com/s3ntin3l8/mullion-session-manager/issues/549)) ([a214490](https://github.com/s3ntin3l8/mullion-session-manager/commit/a214490a8151f981b5ac5d03be16df8817c9f01c))
* subscribe to web push and handle it in the service worker ([#555](https://github.com/s3ntin3l8/mullion-session-manager/issues/555)) ([ec1530e](https://github.com/s3ntin3l8/mullion-session-manager/commit/ec1530e354e04641713c985cd1708a1defea9793))


### Bug Fixes

* deliver Task Master prompts as agent argv, not a dead SessionStart seed ([#538](https://github.com/s3ntin3l8/mullion-session-manager/issues/538)) ([7c2c381](https://github.com/s3ntin3l8/mullion-session-manager/commit/7c2c38178b7c64541841450b7b4fb395f539caac))
* stop persisting dockview maximization so mobile stays single-pane ([#540](https://github.com/s3ntin3l8/mullion-session-manager/issues/540)) ([c65f5f8](https://github.com/s3ntin3l8/mullion-session-manager/commit/c65f5f89a07e7ec52ebefef88c9026ef818422f5))
* surface missing awaiting_question and background rows in Settings notifications ([#553](https://github.com/s3ntin3l8/mullion-session-manager/issues/553)) ([976724d](https://github.com/s3ntin3l8/mullion-session-manager/commit/976724dc6efbe7a7d63e295eae0cabf77539fb7a))

## [0.2.22](https://github.com/s3ntin3l8/mullion-session-manager/compare/v0.2.21...v0.2.22) (2026-08-07)


### Bug Fixes

* exempt POST /api/webhooks/github from authPlugin ([#534](https://github.com/s3ntin3l8/mullion-session-manager/issues/534)) ([e93ea21](https://github.com/s3ntin3l8/mullion-session-manager/commit/e93ea215ddd8f6118525b4a6095c2afc09169618))
* five /internal/* project routes crash on the agent (no app.db) ([#533](https://github.com/s3ntin3l8/mullion-session-manager/issues/533)) ([f06e138](https://github.com/s3ntin3l8/mullion-session-manager/commit/f06e138b662be0ea9a84039bfbe0a54380ae2a4a))
* remove unauthenticated /users route ([#535](https://github.com/s3ntin3l8/mullion-session-manager/issues/535)) ([9281c2f](https://github.com/s3ntin3l8/mullion-session-manager/commit/9281c2f8ef8ff0788b3ce76ed4480ac7dd8c0256))

## [0.2.21](https://github.com/s3ntin3l8/mullion-session-manager/compare/v0.2.20...v0.2.21) (2026-08-06)


### Features

* agent deployment automation (7.7, [#521](https://github.com/s3ntin3l8/mullion-session-manager/issues/521)) ([#529](https://github.com/s3ntin3l8/mullion-session-manager/issues/529)) ([c1101cb](https://github.com/s3ntin3l8/mullion-session-manager/commit/c1101cbb976ea822b8400768e2bb49101ceda6ca))
* agent-initiated registration & rotating session credentials (7.1, [#245](https://github.com/s3ntin3l8/mullion-session-manager/issues/245)) ([#528](https://github.com/s3ntin3l8/mullion-session-manager/issues/528)) ([bcf0a3e](https://github.com/s3ntin3l8/mullion-session-manager/commit/bcf0a3e5d1f0198d06450a47c457e20980486d00))
* GitHub App private-key rotation ([#519](https://github.com/s3ntin3l8/mullion-session-manager/issues/519)) ([dd19e42](https://github.com/s3ntin3l8/mullion-session-manager/commit/dd19e42257f7fe56d3b4e60dafd948f4da1b09a9))
* graceful agent deregistration on shutdown (7.3, [#248](https://github.com/s3ntin3l8/mullion-session-manager/issues/248)) ([#530](https://github.com/s3ntin3l8/mullion-session-manager/issues/530)) ([1d5d057](https://github.com/s3ntin3l8/mullion-session-manager/commit/1d5d05737b28ac01e36d80dac3ca474a1de598e0))
* heartbeat & agent health status for remote hosts (7.2, [#246](https://github.com/s3ntin3l8/mullion-session-manager/issues/246)) ([#524](https://github.com/s3ntin3l8/mullion-session-manager/issues/524)) ([335b49e](https://github.com/s3ntin3l8/mullion-session-manager/commit/335b49eaf68616d14314490ec42288ffaab0f2e3))
* HMAC-signed primary-&gt;agent requests (7.5, [#249](https://github.com/s3ntin3l8/mullion-session-manager/issues/249)) ([#531](https://github.com/s3ntin3l8/mullion-session-manager/issues/531)) ([19103f9](https://github.com/s3ntin3l8/mullion-session-manager/commit/19103f9622f4ee88d3274704d906600e7497d611))
* per-agent effective-config visibility (7.4, [#247](https://github.com/s3ntin3l8/mullion-session-manager/issues/247)) ([#527](https://github.com/s3ntin3l8/mullion-session-manager/issues/527)) ([20796f8](https://github.com/s3ntin3l8/mullion-session-manager/commit/20796f8fb8308c8f02693836d4c7ef44da6d2927))


### Bug Fixes

* guarantee webhook-registration test teardown and isolate its hooks.sock ([#526](https://github.com/s3ntin3l8/mullion-session-manager/issues/526)) ([9ca9254](https://github.com/s3ntin3l8/mullion-session-manager/commit/9ca9254abe8e500af6acea7e7c71c8b75d4fb6ca))

## [0.2.20](https://github.com/s3ntin3l8/mullion-session-manager/compare/v0.2.19...v0.2.20) (2026-08-06)


### Features

* finish GitHub App token coverage + visibility ([#489](https://github.com/s3ntin3l8/mullion-session-manager/issues/489)) ([#512](https://github.com/s3ntin3l8/mullion-session-manager/issues/512)) ([184fe74](https://github.com/s3ntin3l8/mullion-session-manager/commit/184fe74fa69a29649655fc0d2b0fb15c4a5691aa))
* GitHub App installation tokens for Task Master writes ([#489](https://github.com/s3ntin3l8/mullion-session-manager/issues/489)) ([#504](https://github.com/s3ntin3l8/mullion-session-manager/issues/504)) ([d04e68f](https://github.com/s3ntin3l8/mullion-session-manager/commit/d04e68ffc4645d29316b7d27a886f748d335a8f3))
* GitPanel branch + worktree management ([#442](https://github.com/s3ntin3l8/mullion-session-manager/issues/442)) ([#505](https://github.com/s3ntin3l8/mullion-session-manager/issues/505)) ([72008fd](https://github.com/s3ntin3l8/mullion-session-manager/commit/72008fdc8a3ca74eba79ea5dcf3999b55a6036ef))
* live task-transition events over /ws/tasks ([#488](https://github.com/s3ntin3l8/mullion-session-manager/issues/488)) ([#502](https://github.com/s3ntin3l8/mullion-session-manager/issues/502)) ([07cec40](https://github.com/s3ntin3l8/mullion-session-manager/commit/07cec4053835af46227a6a9dc9c5c84d951709d1))
* retry a failed task (resuming on its preserved branch) and give up on a reviewing one ([#496](https://github.com/s3ntin3l8/mullion-session-manager/issues/496)) ([3681a58](https://github.com/s3ntin3l8/mullion-session-manager/commit/3681a58ee864169e581c9bf6e2260e9aeb481208))
* Skills Manager enable/disable — Claude Code toggle + agy discovery (issue [#467](https://github.com/s3ntin3l8/mullion-session-manager/issues/467)) ([#499](https://github.com/s3ntin3l8/mullion-session-manager/issues/499)) ([ceb28b7](https://github.com/s3ntin3l8/mullion-session-manager/commit/ceb28b73cc0b9b9377d646d93e5738a8016cbd2c))
* Task Master safety envelope — Settings UI ([#480](https://github.com/s3ntin3l8/mullion-session-manager/issues/480)) ([78c997c](https://github.com/s3ntin3l8/mullion-session-manager/commit/78c997cb132ee5f7452d5d7f64f708886b5bb203))
* unlabel handling + live ingest events for webhook task sync ([#490](https://github.com/s3ntin3l8/mullion-session-manager/issues/490)a) ([#510](https://github.com/s3ntin3l8/mullion-session-manager/issues/510)) ([2596cb6](https://github.com/s3ntin3l8/mullion-session-manager/commit/2596cb6a19e2880f01c43807ad1cf947df42bd8f))
* visual git status in sidebar + behind-origin indicator ([#506](https://github.com/s3ntin3l8/mullion-session-manager/issues/506)) ([d9d0bd9](https://github.com/s3ntin3l8/mullion-session-manager/commit/d9d0bd935e17dd2929dd68c4a9479cbb7eb01732))
* webhook registration lifecycle for project add/update/delete ([#490](https://github.com/s3ntin3l8/mullion-session-manager/issues/490)b) ([#511](https://github.com/s3ntin3l8/mullion-session-manager/issues/511)) ([69b4f4a](https://github.com/s3ntin3l8/mullion-session-manager/commit/69b4f4a1e236ece16f39139917651d083d8cc3ba))
* webhook-driven task ingest ([#490](https://github.com/s3ntin3l8/mullion-session-manager/issues/490)) ([#503](https://github.com/s3ntin3l8/mullion-session-manager/issues/503)) ([51e3195](https://github.com/s3ntin3l8/mullion-session-manager/commit/51e31958e9436862af9e3d7bd181f500c75d39ed))


### Bug Fixes

* /ws/github subscribe handshake silently drops every subscription ([#515](https://github.com/s3ntin3l8/mullion-session-manager/issues/515)) ([58b0fb0](https://github.com/s3ntin3l8/mullion-session-manager/commit/58b0fb02299fb51013c850b8ddf6f2cb551f5c46))
* agent-rules.ts's opencode globalDir ignores XDG_CONFIG_HOME ([#500](https://github.com/s3ntin3l8/mullion-session-manager/issues/500)) ([bbf5f7d](https://github.com/s3ntin3l8/mullion-session-manager/commit/bbf5f7d564d984a42bd79990b8fa1b703acd0ee7)), closes [#470](https://github.com/s3ntin3l8/mullion-session-manager/issues/470)
* diff-stat summary in the reviewing issue comment ([#491](https://github.com/s3ntin3l8/mullion-session-manager/issues/491)) ([#501](https://github.com/s3ntin3l8/mullion-session-manager/issues/501)) ([90ae551](https://github.com/s3ntin3l8/mullion-session-manager/commit/90ae551be76eff28ec4a7eddfbf4719796e8608d))
* refuse to bind hooks/control sockets over a live listener ([#507](https://github.com/s3ntin3l8/mullion-session-manager/issues/507)) ([8408407](https://github.com/s3ntin3l8/mullion-session-manager/commit/8408407f4700baf657d596409914dce0d2e377e3))
* resolve an approve-retry 422 to the existing PR instead of failing ([#497](https://github.com/s3ntin3l8/mullion-session-manager/issues/497)) ([408905a](https://github.com/s3ntin3l8/mullion-session-manager/commit/408905ab4327417cc24f26d60b99676548b305de))
* surface GitHub sync failures on the task instead of logging silently ([#495](https://github.com/s3ntin3l8/mullion-session-manager/issues/495)) ([7580637](https://github.com/s3ntin3l8/mullion-session-manager/commit/7580637ee981e1ff05a0214d9424c667affe860b))
* warn and surface it when a review agent's adapter can't receive a seed ([#493](https://github.com/s3ntin3l8/mullion-session-manager/issues/493)) ([aa40625](https://github.com/s3ntin3l8/mullion-session-manager/commit/aa4062537e53e42043876efb69a73eb834517a1e))

## [0.2.19](https://github.com/s3ntin3l8/mullion-session-manager/compare/v0.2.18...v0.2.19) (2026-08-01)


### Features

* GitHub write client + issue state sync (6.4) ([#474](https://github.com/s3ntin3l8/mullion-session-manager/issues/474)) ([1dd6153](https://github.com/s3ntin3l8/mullion-session-manager/commit/1dd6153c0de4ad4a6663f07999ab07dac270b4bb))
* local task entity — optional issue link, board order, worktree tracking (6.9) ([#471](https://github.com/s3ntin3l8/mullion-session-manager/issues/471)) ([1b24c7e](https://github.com/s3ntin3l8/mullion-session-manager/commit/1b24c7ec1ed1a75d9799f5459952abd2be011f3f))
* task -&gt; PR promotion (6.7) ([#475](https://github.com/s3ntin3l8/mullion-session-manager/issues/475)) ([b1ad8e5](https://github.com/s3ntin3l8/mullion-session-manager/commit/b1ad8e5b9821fcf7936d61e763653eaae4d060af))
* task state machine, REST API, auto-claim + safety envelope (6.2) ([#473](https://github.com/s3ntin3l8/mullion-session-manager/issues/473)) ([9200a4b](https://github.com/s3ntin3l8/mullion-session-manager/commit/9200a4bbd375543020ebd7a4a7dede36b115b6c1))
* Tasks panel — task board, detail view, claim/approve/reject (6.5/[#218](https://github.com/s3ntin3l8/mullion-session-manager/issues/218)) ([#477](https://github.com/s3ntin3l8/mullion-session-manager/issues/477)) ([61fe38e](https://github.com/s3ntin3l8/mullion-session-manager/commit/61fe38e1a79e56c735e18705dbbf2356150d6dd5))
* worktree lifecycle — remote proxy, clean-check removal, pruneOrphans (6.8) ([#476](https://github.com/s3ntin3l8/mullion-session-manager/issues/476)) ([c8fc6f0](https://github.com/s3ntin3l8/mullion-session-manager/commit/c8fc6f05db42e2ac19281d7acf6a07d11e05bff1))

## [0.2.18](https://github.com/s3ntin3l8/mullion-session-manager/compare/v0.2.17...v0.2.18) (2026-08-01)


### Features

* Agent Rules Editor — visual editor for CLAUDE.md/AGENTS.md/GEMINI.md ([#458](https://github.com/s3ntin3l8/mullion-session-manager/issues/458)) ([a872ce1](https://github.com/s3ntin3l8/mullion-session-manager/commit/a872ce1081b6242a84fbc4e63d62d67a2387fb07))
* extend agent-guide auto-inject to opencode ([#457](https://github.com/s3ntin3l8/mullion-session-manager/issues/457)) ([c7f5ace](https://github.com/s3ntin3l8/mullion-session-manager/commit/c7f5ace29120690ee7eababe7825a223f01a1ca9))
* extend SessionStart agent-guide auto-inject to agy ([#456](https://github.com/s3ntin3l8/mullion-session-manager/issues/456)) ([bf45a82](https://github.com/s3ntin3l8/mullion-session-manager/commit/bf45a82c72b5e3b1d722352e7b6825bc4cd06e7c))
* extend SessionStart agent-guide auto-inject to Codex ([#455](https://github.com/s3ntin3l8/mullion-session-manager/issues/455)) ([74280a2](https://github.com/s3ntin3l8/mullion-session-manager/commit/74280a2bcbb138364e922919166bad62404dfb44))
* Skills Manager enable/disable — Codex + opencode (issue [#463](https://github.com/s3ntin3l8/mullion-session-manager/issues/463)) ([#469](https://github.com/s3ntin3l8/mullion-session-manager/issues/469)) ([c7a63e2](https://github.com/s3ntin3l8/mullion-session-manager/commit/c7a63e25954288727b1ddf23b05ad6b086ee49c4))
* Visual Skills Manager — discovery slice (issue [#432](https://github.com/s3ntin3l8/mullion-session-manager/issues/432)) ([#459](https://github.com/s3ntin3l8/mullion-session-manager/issues/459)) ([a2bcec7](https://github.com/s3ntin3l8/mullion-session-manager/commit/a2bcec75b5da19d2bc5959d0f21b1a83324b06f3))


### Bug Fixes

* don't latch "finished" while background work is outstanding ([#453](https://github.com/s3ntin3l8/mullion-session-manager/issues/453)) ([0d974e6](https://github.com/s3ntin3l8/mullion-session-manager/commit/0d974e670c4fc34a26ec228465ccb72121b7eba0))
* prune stale Codex hook groups across Mullion releases ([#464](https://github.com/s3ntin3l8/mullion-session-manager/issues/464)) ([4c24357](https://github.com/s3ntin3l8/mullion-session-manager/commit/4c2435754c70e41a020e176679c3305e4ae020af))
* remove agy's dead SessionEnd hook registration ([#465](https://github.com/s3ntin3l8/mullion-session-manager/issues/465)) ([5cf554b](https://github.com/s3ntin3l8/mullion-session-manager/commit/5cf554bf38018fd96e4de7ee5c8eaf7d0424ebd2))
* stop dropping sibling messages ahead of a blocking hook reply ([#466](https://github.com/s3ntin3l8/mullion-session-manager/issues/466)) ([326b359](https://github.com/s3ntin3l8/mullion-session-manager/commit/326b359ac9b0a61724c966218cef89e23ad70f53))

## [0.2.17](https://github.com/s3ntin3l8/mullion-session-manager/compare/v0.2.16...v0.2.17) (2026-07-31)


### Features

* add Settings UI for auto-open child panels and per-parent child cap ([#450](https://github.com/s3ntin3l8/mullion-session-manager/issues/450)) ([21d9081](https://github.com/s3ntin3l8/mullion-session-manager/commit/21d9081a2eca04d1cd3fe2db51d3c3ee1f0d8a96))
* opt-in Ctrl+V paste and Ctrl+C copy chords in the terminal ([#443](https://github.com/s3ntin3l8/mullion-session-manager/issues/443)) ([34e6712](https://github.com/s3ntin3l8/mullion-session-manager/commit/34e67123676193413c15fd1d09b103f4e251be2f))
* settings UI for session event persistence + retention ([#445](https://github.com/s3ntin3l8/mullion-session-manager/issues/445)) ([#452](https://github.com/s3ntin3l8/mullion-session-manager/issues/452)) ([af9497a](https://github.com/s3ntin3l8/mullion-session-manager/commit/af9497aa92591d16401aaedf466add02eede18ab))

## [0.2.16](https://github.com/s3ntin3l8/mullion-session-manager/compare/v0.2.15...v0.2.16) (2026-07-30)


### Features

* add GET /api/previews list-all route, previews.list op, list_previews MCP tool, mullion preview list ([#418](https://github.com/s3ntin3l8/mullion-session-manager/issues/418)) ([5b13d7d](https://github.com/s3ntin3l8/mullion-session-manager/commit/5b13d7dbb4c1520832824436b12ec1cdfeeae312))
* add mullion agent guide doc with SessionStart auto-inject (issue [#405](https://github.com/s3ntin3l8/mullion-session-manager/issues/405)) ([#419](https://github.com/s3ntin3l8/mullion-session-manager/issues/419)) ([8c15e8b](https://github.com/s3ntin3l8/mullion-session-manager/commit/8c15e8bc15341bf683848edec90f77a83ab9b93c))
* add mullion CLI over the control socket ([#402](https://github.com/s3ntin3l8/mullion-session-manager/issues/402)) ([2bf04cb](https://github.com/s3ntin3l8/mullion-session-manager/commit/2bf04cb6ab2e7a32f46d65b8cc352c9fac2ad000))
* agent-attribution envelope for subagent hooks, delete fork/join ([#416](https://github.com/s3ntin3l8/mullion-session-manager/issues/416)) ([1712103](https://github.com/s3ntin3l8/mullion-session-manager/commit/171210329ddcf2ca4446a32ccceb77a212e4d3b3))
* auto-detect dev servers in plain sessions and offer to wire up the preview (issue [#404](https://github.com/s3ntin3l8/mullion-session-manager/issues/404)) ([#422](https://github.com/s3ntin3l8/mullion-session-manager/issues/422)) ([3c60c66](https://github.com/s3ntin3l8/mullion-session-manager/commit/3c60c66332085b3c740f0603d4662a74578e2acb))
* browser actions over the control socket ([#189](https://github.com/s3ntin3l8/mullion-session-manager/issues/189)) ([#401](https://github.com/s3ntin3l8/mullion-session-manager/issues/401)) ([6b85b4d](https://github.com/s3ntin3l8/mullion-session-manager/commit/6b85b4d05ed836ec0d0435ef1f98685ab166768c))
* browser download management (issue [#381](https://github.com/s3ntin3l8/mullion-session-manager/issues/381)) ([#434](https://github.com/s3ntin3l8/mullion-session-manager/issues/434)) ([a21393a](https://github.com/s3ntin3l8/mullion-session-manager/commit/a21393a9b3e27f1148f35350b70b02227d8ff2a5))
* browser frame/iframe support via a frame field (issue [#382](https://github.com/s3ntin3l8/mullion-session-manager/issues/382)) ([#429](https://github.com/s3ntin3l8/mullion-session-manager/issues/429)) ([2770d3c](https://github.com/s3ntin3l8/mullion-session-manager/commit/2770d3ca8aa3f939c11df43d5c8e30c3b823c9cd))
* hierarchical sidebar + child-panel layout (issues [#195](https://github.com/s3ntin3l8/mullion-session-manager/issues/195), [#194](https://github.com/s3ntin3l8/mullion-session-manager/issues/194)) ([#430](https://github.com/s3ntin3l8/mullion-session-manager/issues/430)) ([1896b4a](https://github.com/s3ntin3l8/mullion-session-manager/commit/1896b4a7d4c0b9a010f0029176e862eba752d118))
* mullion MCP session/project/preview tools ([#406](https://github.com/s3ntin3l8/mullion-session-manager/issues/406)) ([aec8e33](https://github.com/s3ntin3l8/mullion-session-manager/commit/aec8e332c42626cf27b92ad2fdbf56057e4483bd))
* notification events over the control socket ([#188](https://github.com/s3ntin3l8/mullion-session-manager/issues/188)) ([#400](https://github.com/s3ntin3l8/mullion-session-manager/issues/400)) ([6b65304](https://github.com/s3ntin3l8/mullion-session-manager/commit/6b653048e97b0227bfdb72f65ab34376e60e6667))
* package and document the mullion CLI ([#403](https://github.com/s3ntin3l8/mullion-session-manager/issues/403)) ([90f5f70](https://github.com/s3ntin3l8/mullion-session-manager/commit/90f5f702586ea247c9eb99853becc0f4f1683eba))
* parentSessionId session lineage + agent-spawned child sessions (issue [#193](https://github.com/s3ntin3l8/mullion-session-manager/issues/193), 5.3b) ([#426](https://github.com/s3ntin3l8/mullion-session-manager/issues/426)) ([90c0e71](https://github.com/s3ntin3l8/mullion-session-manager/commit/90c0e715f3eb4a45f08170c220ff16b02b3f0666))
* per-child session control + Phase 5 wrap-up (issue [#196](https://github.com/s3ntin3l8/mullion-session-manager/issues/196), 5.6) ([#435](https://github.com/s3ntin3l8/mullion-session-manager/issues/435)) ([8e8215f](https://github.com/s3ntin3l8/mullion-session-manager/commit/8e8215f53442483d5cc6057076eead2d8a43d667))
* persistent session event history — storage, retention, and query surface (issue [#213](https://github.com/s3ntin3l8/mullion-session-manager/issues/213), 4.7) ([#421](https://github.com/s3ntin3l8/mullion-session-manager/issues/421)) ([cfed4ce](https://github.com/s3ntin3l8/mullion-session-manager/commit/cfed4ce8160def683c620e828cb552f39f4488db))
* preview-host auth token (issue [#383](https://github.com/s3ntin3l8/mullion-session-manager/issues/383)) ([#427](https://github.com/s3ntin3l8/mullion-session-manager/issues/427)) ([1bc1b54](https://github.com/s3ntin3l8/mullion-session-manager/commit/1bc1b5448fd1a3ef2597abb4db78f471edafe29f))
* PTY I/O over the control socket ([#186](https://github.com/s3ntin3l8/mullion-session-manager/issues/186)) ([#399](https://github.com/s3ntin3l8/mullion-session-manager/issues/399)) ([c9065a3](https://github.com/s3ntin3l8/mullion-session-manager/commit/c9065a3ad53e338c585e0456a1c2ebafd974bbc8))
* session lifecycle over the control socket (4.3) ([#398](https://github.com/s3ntin3l8/mullion-session-manager/issues/398)) ([b88bdd6](https://github.com/s3ntin3l8/mullion-session-manager/commit/b88bdd6130be2b0801a7c2adf45d146208592d43))
* subagent registry, additive to subagentCount ([#417](https://github.com/s3ntin3l8/mullion-session-manager/issues/417)) ([5ef34f4](https://github.com/s3ntin3l8/mullion-session-manager/commit/5ef34f4345dfa8af0cf9eec1e4637ad6b4fa430b))
* subagent rows in sidebar + timeline grouping by subagent ([#425](https://github.com/s3ntin3l8/mullion-session-manager/issues/425)) ([7496227](https://github.com/s3ntin3l8/mullion-session-manager/commit/74962273cef55ce92be81c064ad34a3c3a3ab372))
* Unix control socket transport (4.1) ([#396](https://github.com/s3ntin3l8/mullion-session-manager/issues/396)) ([2c4acad](https://github.com/s3ntin3l8/mullion-session-manager/commit/2c4acad741d180a2150915b0bc0651890813919e))


### Bug Fixes

* MCP browser_action hook path missing fill/snapshot/eval/screenshot ([#424](https://github.com/s3ntin3l8/mullion-session-manager/issues/424)) ([04873a2](https://github.com/s3ntin3l8/mullion-session-manager/commit/04873a2b66837d731e29f67c02c2a2e5b5900bae))
* mullion CLI browser validation gaps and resolveAndAttach sessionId guard ([#411](https://github.com/s3ntin3l8/mullion-session-manager/issues/411)) ([80b908e](https://github.com/s3ntin3l8/mullion-session-manager/commit/80b908eb35a2cb714d63b34a6ce64933ebc0ed53))

## [0.2.15](https://github.com/s3ntin3l8/mullion-session-manager/compare/v0.2.14...v0.2.15) (2026-07-28)


### Features

* agent browser automation API, MCP tools, and console access ([#379](https://github.com/s3ntin3l8/mullion-session-manager/issues/379)) ([d2e5313](https://github.com/s3ntin3l8/mullion-session-manager/commit/d2e5313ac07c31675fc38f985a9e96de64ad8d3e))
* iframe browser reliability, layout persistence, labels, and follow-agent URL sync ([#380](https://github.com/s3ntin3l8/mullion-session-manager/issues/380)) ([632acfd](https://github.com/s3ntin3l8/mullion-session-manager/commit/632acfd21a0ece5bd6ffb6f93745e8fa09c9eca5))


### Bug Fixes

* auto-redirect sessionsDir to short /tmp/ path when socket path exceeds 100 bytes ([1958957](https://github.com/s3ntin3l8/mullion-session-manager/commit/1958957632fd214b01df835ad2e6a29ab4181386))
* make browser-cookie-import decryption-skip test deterministic ([4b7e3c0](https://github.com/s3ntin3l8/mullion-session-manager/commit/4b7e3c05c8025c869c41e37f0d0566cad335ec26))
* unwrap jobs array + redirect sessionsDir when socket path exceeds 108 byte limit ([79b565c](https://github.com/s3ntin3l8/mullion-session-manager/commit/79b565c3d1984067f58638bd203f435f5fc54f91))
* unwrap jobs array + redirect sessionsDir when socket path exceeds 108 byte limit ([79b565c](https://github.com/s3ntin3l8/mullion-session-manager/commit/79b565c3d1984067f58638bd203f435f5fc54f91))
* unwrap jobs array in /actions/:runId/jobs response ([d17fbbc](https://github.com/s3ntin3l8/mullion-session-manager/commit/d17fbbc0372310c3f4b6fffd193c7a9bfb6159d4))

## [0.2.14](https://github.com/s3ntin3l8/mullion-session-manager/compare/v0.2.13...v0.2.14) (2026-07-27)


### Features

* GitHub integration Phase 2 — webhooks, adaptive poller, job-level detail, inline logs ([1e82428](https://github.com/s3ntin3l8/mullion-session-manager/commit/1e824280dc14c1a6c16ed034f4c2dae4944262b5))


### Bug Fixes

* Ctrl+C in dock monitor terminals should copy, not send SIGINT ([6a71183](https://github.com/s3ntin3l8/mullion-session-manager/commit/6a711837ff7ff0262fcf1effb86a938782c83f14))

## [0.2.13](https://github.com/s3ntin3l8/mullion-session-manager/compare/v0.2.12...v0.2.13) (2026-07-27)


### Features

* auto-derive diff base ref via base=AUTO sentinel, add test coverage ([27e0505](https://github.com/s3ntin3l8/mullion-session-manager/commit/27e050561e47a89724184c078a27cfba153c058a))
* render per-file unified diff when clicking sidebar file-change chip ([#262](https://github.com/s3ntin3l8/mullion-session-manager/issues/262)) ([0981b6e](https://github.com/s3ntin3l8/mullion-session-manager/commit/0981b6edf7d84f6ad6928e2d9c736e770a4f6b5d))


### Bug Fixes

* restore CustomSelect portal theme classes and fix scroll-close ([#373](https://github.com/s3ntin3l8/mullion-session-manager/issues/373)) ([321b6db](https://github.com/s3ntin3l8/mullion-session-manager/commit/321b6db96a86a0ed7abb04b57ecfa93a92168845))

## [0.2.12](https://github.com/s3ntin3l8/mullion-session-manager/compare/v0.2.11...v0.2.12) (2026-07-27)


### Features

* background git auto-fetch with per-project toggle ([#369](https://github.com/s3ntin3l8/mullion-session-manager/issues/369)) ([#372](https://github.com/s3ntin3l8/mullion-session-manager/issues/372)) ([b1e543d](https://github.com/s3ntin3l8/mullion-session-manager/commit/b1e543d5fd8b7c612245293011403bf499480467))
* wire opencode v2 events (question/permission/todo/session_diff) into Mullion's session status ([45d2cc0](https://github.com/s3ntin3l8/mullion-session-manager/commit/45d2cc02610ddea6f8857f104f39cf72cb164ae5))


### Bug Fixes

* portal CustomSelect dropdown to body and integrate dev server URL into monitor header ([7e09d40](https://github.com/s3ntin3l8/mullion-session-manager/commit/7e09d40e1167ec1949808b85307cd0d2d8154254))

## [0.2.11](https://github.com/s3ntin3l8/mullion-session-manager/compare/v0.2.10...v0.2.11) (2026-07-26)


### Features

* add inline rename to sidebar session rows ([#364](https://github.com/s3ntin3l8/mullion-session-manager/issues/364)) ([5575f06](https://github.com/s3ntin3l8/mullion-session-manager/commit/5575f06eeea1f466ca57ed89771a765de542d9ab))
* add staleness sweep for blocked/busy session statuses in reconciler ([#320](https://github.com/s3ntin3l8/mullion-session-manager/issues/320)) ([#349](https://github.com/s3ntin3l8/mullion-session-manager/issues/349)) ([b4f69b9](https://github.com/s3ntin3l8/mullion-session-manager/commit/b4f69b91d77025e5c2ad82bbc815d7c9fde9f074))
* Chrome-like browser toolbar, auto-prepend scheme, and favorites in external mode ([#333](https://github.com/s3ntin3l8/mullion-session-manager/issues/333)) ([85ad1ab](https://github.com/s3ntin3l8/mullion-session-manager/commit/85ad1ab6e3d928c14ad10d9a8b8d71cb85542f21))
* consume agent hook-capability map in UI ([#319](https://github.com/s3ntin3l8/mullion-session-manager/issues/319)) ([#348](https://github.com/s3ntin3l8/mullion-session-manager/issues/348)) ([19a3b7b](https://github.com/s3ntin3l8/mullion-session-manager/commit/19a3b7b8009fb74a8ff80b842d2d31b9450a9b9d))
* desktop notifications for backgrounded dockview panes ([#322](https://github.com/s3ntin3l8/mullion-session-manager/issues/322)) ([#356](https://github.com/s3ntin3l8/mullion-session-manager/issues/356)) ([6f25d8c](https://github.com/s3ntin3l8/mullion-session-manager/commit/6f25d8c164f7101117d0acc5a2e226afc7ed93c5))
* per-status notification matrix in Settings ([#318](https://github.com/s3ntin3l8/mullion-session-manager/issues/318)) ([#354](https://github.com/s3ntin3l8/mullion-session-manager/issues/354)) ([6ca1fd7](https://github.com/s3ntin3l8/mullion-session-manager/commit/6ca1fd7abe4d6fba3122f10f68d7b3e2677292db))
* replace native selects with CustomSelect component ([#359](https://github.com/s3ntin3l8/mullion-session-manager/issues/359)) ([e46af99](https://github.com/s3ntin3l8/mullion-session-manager/commit/e46af99d04d0d2de5ab7b734dfe2ddd35e57c5b4))
* wire agy and opencode remaining hook surfaces ([#321](https://github.com/s3ntin3l8/mullion-session-manager/issues/321)) ([#355](https://github.com/s3ntin3l8/mullion-session-manager/issues/355)) ([7fd21ce](https://github.com/s3ntin3l8/mullion-session-manager/commit/7fd21ce144f1a26cc6e2218733bbd6a8f9fb4e6d))


### Bug Fixes

* align Launchers & agents settings table into a shared grid ([#362](https://github.com/s3ntin3l8/mullion-session-manager/issues/362)) ([7869d71](https://github.com/s3ntin3l8/mullion-session-manager/commit/7869d71db595b7d0c82f27c65332c817230d7bfb))
* detect worktree branch for opencode sessions via tool.execute.after hook ([#367](https://github.com/s3ntin3l8/mullion-session-manager/issues/367)) ([b3f48a3](https://github.com/s3ntin3l8/mullion-session-manager/commit/b3f48a3d40b27d540260a4ef3b18f78f8acecaa7))
* persist rich session state across backend restart and detect stale hook sets ([#323](https://github.com/s3ntin3l8/mullion-session-manager/issues/323)) ([#350](https://github.com/s3ntin3l8/mullion-session-manager/issues/350)) ([574f472](https://github.com/s3ntin3l8/mullion-session-manager/commit/574f472f37987e119eaff3dbb29944ad4efb8a33))
* prevent layout shift when skip-permissions toggle appears in CommandPalette ([#360](https://github.com/s3ntin3l8/mullion-session-manager/issues/360)) ([2f11730](https://github.com/s3ntin3l8/mullion-session-manager/commit/2f11730edfaabe52a49fbbf903c2eb3492b9d852))
* print explicit allow decision for agy PreToolUse non-gate path ([#366](https://github.com/s3ntin3l8/mullion-session-manager/issues/366)) ([8619182](https://github.com/s3ntin3l8/mullion-session-manager/commit/8619182b4e0a6363417c188ab78052b771553aab))
* resolve stale session status for opencode and claude code ([1a39522](https://github.com/s3ntin3l8/mullion-session-manager/commit/1a39522002c5b89a95a15f763e7fd000c5ead7ca))
* resolve stale session status for opencode and claude code ([c5b0314](https://github.com/s3ntin3l8/mullion-session-manager/commit/c5b0314fec4fed4f1d56b0f6047535c7efa1f53e))
* resolve stale session status for opencode and claude code ([#363](https://github.com/s3ntin3l8/mullion-session-manager/issues/363)) ([1a39522](https://github.com/s3ntin3l8/mullion-session-manager/commit/1a39522002c5b89a95a15f763e7fd000c5ead7ca))
* surface matched adapter emits on session for accurate capability lookup ([#351](https://github.com/s3ntin3l8/mullion-session-manager/issues/351)) ([#353](https://github.com/s3ntin3l8/mullion-session-manager/issues/353)) ([0c7258b](https://github.com/s3ntin3l8/mullion-session-manager/commit/0c7258b0c1b8d474a9b6d60e184da15860fa1153))

## [0.2.10](https://github.com/s3ntin3l8/mullion-session-manager/compare/v0.2.9...v0.2.10) (2026-07-26)


### Features

* add Finished column to Kanban board distinct from Needs Attention ([#337](https://github.com/s3ntin3l8/mullion-session-manager/issues/337)) ([8b48a95](https://github.com/s3ntin3l8/mullion-session-manager/commit/8b48a95210ee891b5170d2e6296121e760d2a7e7))
* dock branch selector with preview worktree + live sync ([#341](https://github.com/s3ntin3l8/mullion-session-manager/issues/341)) ([91aa83c](https://github.com/s3ntin3l8/mullion-session-manager/commit/91aa83cb58c8828f013d19875c60ca540fa4c7a9))


### Bug Fixes

* close worktree branch detection gaps for opencode sessions and relative paths ([#343](https://github.com/s3ntin3l8/mullion-session-manager/issues/343)) ([e62ffdd](https://github.com/s3ntin3l8/mullion-session-manager/commit/e62ffdd5fabd05d3bb14755a6ba719535f9eb7dc))
* make launcher permissions toggle universal with per-agent badges ([022677d](https://github.com/s3ntin3l8/mullion-session-manager/commit/022677d5b9ec3f8b8abda92bc92e3e77ead5a194))
* resolve brace-expansion DoS (CVE-2026-14257) ([23ed92f](https://github.com/s3ntin3l8/mullion-session-manager/commit/23ed92f0de805f45ae1078def8c962ac7ab9f53e))
* session statuses must survive a glance and clear when answered ([#346](https://github.com/s3ntin3l8/mullion-session-manager/issues/346)) ([c359220](https://github.com/s3ntin3l8/mullion-session-manager/commit/c35922066dc8513d43265416449cbda5f2a435e2))

## [0.2.9](https://github.com/s3ntin3l8/mullion-session-manager/compare/v0.2.8...v0.2.9) (2026-07-25)


### Features

* add worktree/branch selector to dock monitor launcher ([7bbbafb](https://github.com/s3ntin3l8/mullion-session-manager/commit/7bbbafbd06a5dbc127c02740674876efe9747259))
* open GitPanel and GitHubPanel as float by default when tiled panels exist ([#336](https://github.com/s3ntin3l8/mullion-session-manager/issues/336)) ([d75345c](https://github.com/s3ntin3l8/mullion-session-manager/commit/d75345cb10f3dca0669f7b831f039b11bd18f8e5))


### Bug Fixes

* address review feedback on worktree selector ([6c619fb](https://github.com/s3ntin3l8/mullion-session-manager/commit/6c619fbe588923b414ea0f371b474cab934ae944))
* close worktree/branch detection gaps for chained commands and stale cwd ([#335](https://github.com/s3ntin3l8/mullion-session-manager/issues/335)) ([6e7f21e](https://github.com/s3ntin3l8/mullion-session-manager/commit/6e7f21e88702a7215bda1c0e5ac9afd7690b0e3b))
* persist hook tokens so hooks survive a Mullion restart ([#328](https://github.com/s3ntin3l8/mullion-session-manager/issues/328)) ([20ca99f](https://github.com/s3ntin3l8/mullion-session-manager/commit/20ca99fad656c0db60a7af6e41cc8800c0b5ef06))
* **preview:** stop leaking forwarded headers to previewed dev servers ([#324](https://github.com/s3ntin3l8/mullion-session-manager/issues/324)) ([ed802b2](https://github.com/s3ntin3l8/mullion-session-manager/commit/ed802b263a8b69bfef78a6028376083857e28a5b))
* sidebar status label overflow and invisible panel-body click highlight ([#329](https://github.com/s3ntin3l8/mullion-session-manager/issues/329)) ([c495d3f](https://github.com/s3ntin3l8/mullion-session-manager/commit/c495d3fe1548348969ceff4ad48d1b32cda62c8f))
* stop dock terminals from corrupting other panes' WebGL glyphs ([#325](https://github.com/s3ntin3l8/mullion-session-manager/issues/325)) ([e137683](https://github.com/s3ntin3l8/mullion-session-manager/commit/e137683e353be3bfa21f0b48d1633ee63f68d91f))
* stop transient tool failures from masking live status prompts ([#327](https://github.com/s3ntin3l8/mullion-session-manager/issues/327)) ([bff86c7](https://github.com/s3ntin3l8/mullion-session-manager/commit/bff86c7b84f17f8161dec3025bd2b172546c9508))

## [0.2.8](https://github.com/s3ntin3l8/mullion-session-manager/compare/v0.2.7...v0.2.8) (2026-07-25)


### Features

* extend surfaced session statuses beyond idle/working/needs-input/exited ([#316](https://github.com/s3ntin3l8/mullion-session-manager/issues/316)) ([f6f69c1](https://github.com/s3ntin3l8/mullion-session-manager/commit/f6f69c1e2487731210df688c8a46a2557b1b7ecb))

## [0.2.7](https://github.com/s3ntin3l8/mullion-session-manager/compare/v0.2.6...v0.2.7) (2026-07-25)


### Features

* add skip-permissions launcher option ([a439fcd](https://github.com/s3ntin3l8/mullion-session-manager/commit/a439fcda08f493bc433cdfba4b475c1e9691d909))
* session highlight and workspace switching on sidebar click ([48750df](https://github.com/s3ntin3l8/mullion-session-manager/commit/48750df5ef745269a7729901d49893eee2b1b50d))


### Bug Fixes

* make agy PreToolUse review gate opt-in behind MULLION_REVIEW_GATE_ENABLED ([#311](https://github.com/s3ntin3l8/mullion-session-manager/issues/311)) ([09dcc6e](https://github.com/s3ntin3l8/mullion-session-manager/commit/09dcc6e94a7c550c87c7273c27e45e3102934710)), closes [#264](https://github.com/s3ntin3l8/mullion-session-manager/issues/264)
* restore per-session git branch/PR detection dropped by a rebase ([#314](https://github.com/s3ntin3l8/mullion-session-manager/issues/314)) ([f66a231](https://github.com/s3ntin3l8/mullion-session-manager/commit/f66a23117ed3ac5872b02c9ba75b53fe441976e7))

## [0.2.6](https://github.com/s3ntin3l8/mullion-session-manager/compare/v0.2.5...v0.2.6) (2026-07-24)


### Bug Fixes

* force TERM=xterm-256color in session shells (agy loses colors) ([c38bab8](https://github.com/s3ntin3l8/mullion-session-manager/commit/c38bab89ab4c8ab1d6a48fb01d40644a67ab2f5c))

## [0.2.5](https://github.com/s3ntin3l8/mullion-session-manager/compare/v0.2.4...v0.2.5) (2026-07-24)


### Features

* agent browser automation API (3.5) ([33213ed](https://github.com/s3ntin3l8/mullion-session-manager/commit/33213ede5a6275bef5424d2b865fe812bc5b39ea))
* BrowserPane dockview component (3.3) ([4f87e2d](https://github.com/s3ntin3l8/mullion-session-manager/commit/4f87e2d37d42b01860b8e075de41b4140165b518)), closes [#181](https://github.com/s3ntin3l8/mullion-session-manager/issues/181)
* cookie/session import (3.6) ([#302](https://github.com/s3ntin3l8/mullion-session-manager/issues/302)) ([f37f88b](https://github.com/s3ntin3l8/mullion-session-manager/commit/f37f88b9f7b158ad00154effcb7a22f9a73435bc))
* deterministic hook signal detection for Claude Code sessions ([e225f58](https://github.com/s3ntin3l8/mullion-session-manager/commit/e225f58e03f60fd464b78de5d33277323710ac43))
* deterministic hook signal detection for Codex and agy sessions ([#301](https://github.com/s3ntin3l8/mullion-session-manager/issues/301)) ([4e715af](https://github.com/s3ntin3l8/mullion-session-manager/commit/4e715afbc3328620d3cf7f08da7b2355975cdae1))
* hook-based git branch and worktree detection for all agents ([#299](https://github.com/s3ntin3l8/mullion-session-manager/issues/299)) ([a225574](https://github.com/s3ntin3l8/mullion-session-manager/commit/a2255744c0731f026aecdc1a0776d817741218a2))
* map opencode permission.updated and session.error to dedicated protocol kinds ([#303](https://github.com/s3ntin3l8/mullion-session-manager/issues/303)) ([079b16e](https://github.com/s3ntin3l8/mullion-session-manager/commit/079b16ed9e050af11caeb142bbbef4f628f8e2cf))
* Playwright browser manager (3.1) ([a6f4120](https://github.com/s3ntin3l8/mullion-session-manager/commit/a6f41208c66ba4a6cbb4e46da77e1b289abfd83d))
* promote_to_worktree MCP config for AGY adapter (issue [#253](https://github.com/s3ntin3l8/mullion-session-manager/issues/253)) ([2df4d7c](https://github.com/s3ntin3l8/mullion-session-manager/commit/2df4d7c7f61e1bf71dd4f0d84bd100fd8a980773))
* promote_to_worktree tool for OpenCode plugin ([#286](https://github.com/s3ntin3l8/mullion-session-manager/issues/286)) ([93f70db](https://github.com/s3ntin3l8/mullion-session-manager/commit/93f70db9d08245fae1cebc76f6fbeb425536869b))
* session-to-browser binding (3.4) ([e80ead7](https://github.com/s3ntin3l8/mullion-session-manager/commit/e80ead7b1dde89709e510bb6802c2f90d04a25ce))
* WebSocket browser frame streaming (3.2) ([1d2da4a](https://github.com/s3ntin3l8/mullion-session-manager/commit/1d2da4a2df0230d99d7f326847d5989b217a3d40))


### Bug Fixes

* worktree branch selector layout and terminal overflow menu promote action ([#294](https://github.com/s3ntin3l8/mullion-session-manager/issues/294)) ([cad9016](https://github.com/s3ntin3l8/mullion-session-manager/commit/cad90163e98a91e5e11939bb336a51ca9350d8fa))

## [0.2.4](https://github.com/s3ntin3l8/mullion-session-manager/compare/v0.2.3...v0.2.4) (2026-07-24)


### Features

* agent spawner — worktree isolation + claim endpoint (2.5.2) ([#280](https://github.com/s3ntin3l8/mullion-session-manager/issues/280)) ([ff6cc50](https://github.com/s3ntin3l8/mullion-session-manager/commit/ff6cc5036e70a1661b95e8fee7f1db680cb352b4))
* interactive worktree isolation — launcher toggle + promote-to-worktree ([#277](https://github.com/s3ntin3l8/mullion-session-manager/issues/277)) ([66c2461](https://github.com/s3ntin3l8/mullion-session-manager/commit/66c2461a321060583313be0911b878b02d20c83c))
* manual claim UI in existing sidebar (2.5.3) ([#281](https://github.com/s3ntin3l8/mullion-session-manager/issues/281)) ([a27c280](https://github.com/s3ntin3l8/mullion-session-manager/commit/a27c280fc308936678f6650c54d0eaee246b8481))
* surface pending Codex hook-trust in the UI ([#284](https://github.com/s3ntin3l8/mullion-session-manager/issues/284)) ([9d2ebe8](https://github.com/s3ntin3l8/mullion-session-manager/commit/9d2ebe8d1d6e8308cbe390b19a6fe509db4a590c))
* task watcher — minimal GitHub-labeled-issue poller (2.5.1) ([#279](https://github.com/s3ntin3l8/mullion-session-manager/issues/279)) ([a6a280c](https://github.com/s3ntin3l8/mullion-session-manager/commit/a6a280c376f7b1c34fb4d800b595f7aba139d4fb))


### Bug Fixes

* harden attention hooks — output-immune permission flags, codex trust fallback, opencode notification parity ([#285](https://github.com/s3ntin3l8/mullion-session-manager/issues/285)) ([22daaab](https://github.com/s3ntin3l8/mullion-session-manager/commit/22daaab5ad7bfdd3598c7897dcf3012765415418))

## [0.2.3](https://github.com/s3ntin3l8/mullion-session-manager/compare/v0.2.2...v0.2.3) (2026-07-24)


### Bug Fixes

* attention flag survives workspace reopen, drive it off agent hooks not byte-guessing ([#275](https://github.com/s3ntin3l8/mullion-session-manager/issues/275)) ([dc8552c](https://github.com/s3ntin3l8/mullion-session-manager/commit/dc8552cf1a94f2b1a8cf77d7991417c04c592681))
* show a session's live git worktree in the sidebar ([#276](https://github.com/s3ntin3l8/mullion-session-manager/issues/276)) ([492e1b9](https://github.com/s3ntin3l8/mullion-session-manager/commit/492e1b9d01353ea4ddf5d9001ae3bb8683165edb))
* stop opencode's plugin loader from crashing on startup ([#272](https://github.com/s3ntin3l8/mullion-session-manager/issues/272)) ([563c4e7](https://github.com/s3ntin3l8/mullion-session-manager/commit/563c4e78036b10cd0122457a454db91aad23ea8e))
* trim Kanban exited column, add Idle column, fix overlay bleed-through ([#274](https://github.com/s3ntin3l8/mullion-session-manager/issues/274)) ([9956d4f](https://github.com/s3ntin3l8/mullion-session-manager/commit/9956d4f2feedf7d54418153c6e47644c672aa9f0))

## [0.2.2](https://github.com/s3ntin3l8/mullion-session-manager/compare/v0.2.1...v0.2.2) (2026-07-24)


### Bug Fixes

* resolve systemd unit at runtime for self-update, rename unit to mullion.service ([#267](https://github.com/s3ntin3l8/mullion-session-manager/issues/267)) ([07c0047](https://github.com/s3ntin3l8/mullion-session-manager/commit/07c0047bada9ac96fc5ac99aca19e90bfdcf3094))

## [0.2.1](https://github.com/s3ntin3l8/mullion-session-manager/compare/v0.2.0...v0.2.1) (2026-07-24)


### Features

* agent hook socket + MULLION_HOOK_SOCKET env injection ([#254](https://github.com/s3ntin3l8/mullion-session-manager/issues/254)) ([374f5ba](https://github.com/s3ntin3l8/mullion-session-manager/commit/374f5ba79af7b80580923490d947ec280169a7a9))
* agy (Antigravity CLI) hook integration ([#261](https://github.com/s3ntin3l8/mullion-session-manager/issues/261)) ([d4ca331](https://github.com/s3ntin3l8/mullion-session-manager/commit/d4ca331f50cf2cca5ceb9161a29d530f8d954d29))
* Claude Code hook integration + agent hook adapter framework ([#257](https://github.com/s3ntin3l8/mullion-session-manager/issues/257)) ([6f81ad6](https://github.com/s3ntin3l8/mullion-session-manager/commit/6f81ad65741f3a316c6a36b7f20d33b72f443f79))
* Codex hook integration ([#260](https://github.com/s3ntin3l8/mullion-session-manager/issues/260)) ([240bc8b](https://github.com/s3ntin3l8/mullion-session-manager/commit/240bc8ba007d84a4ff93d0c6588fb1c52bb8c0a8))
* desktop notifications via Browser Notification API ([#170](https://github.com/s3ntin3l8/mullion-session-manager/issues/170)) ([#240](https://github.com/s3ntin3l8/mullion-session-manager/issues/240)) ([561b9c1](https://github.com/s3ntin3l8/mullion-session-manager/commit/561b9c14d47565ed31372528e0b4144d11e1691d))
* file-change events in the sidebar ([#263](https://github.com/s3ntin3l8/mullion-session-manager/issues/263)) ([65b99f3](https://github.com/s3ntin3l8/mullion-session-manager/commit/65b99f32cb6704a0bd46ce5e6f97a86d61e32068))
* hook JSON protocol and validation ([#255](https://github.com/s3ntin3l8/mullion-session-manager/issues/255)) ([96e421f](https://github.com/s3ntin3l8/mullion-session-manager/commit/96e421f06c9e7a79faab691521c608df9bbbf43f))
* Kanban board view ([#211](https://github.com/s3ntin3l8/mullion-session-manager/issues/211)) ([#242](https://github.com/s3ntin3l8/mullion-session-manager/issues/242)) ([b50293c](https://github.com/s3ntin3l8/mullion-session-manager/commit/b50293c5131032843375dc3a6b8f6dd13b941cd6))
* minimal review gate ([#178](https://github.com/s3ntin3l8/mullion-session-manager/issues/178)) ([#265](https://github.com/s3ntin3l8/mullion-session-manager/issues/265)) ([ee526e3](https://github.com/s3ntin3l8/mullion-session-manager/commit/ee526e300a6260edf2bbe16edb3a4c0cf9165345))
* notification event model ([#166](https://github.com/s3ntin3l8/mullion-session-manager/issues/166)) ([#234](https://github.com/s3ntin3l8/mullion-session-manager/issues/234)) ([2dae69b](https://github.com/s3ntin3l8/mullion-session-manager/commit/2dae69b472c3bb923437598f8a096e10eefb889d))
* OpenCode hook integration (plugin adapter) ([#258](https://github.com/s3ntin3l8/mullion-session-manager/issues/258)) ([00add92](https://github.com/s3ntin3l8/mullion-session-manager/commit/00add92142e86a11b70a266dc117a89d854305ba))
* per-PR CI/CD status for remote-hosted projects ([#222](https://github.com/s3ntin3l8/mullion-session-manager/issues/222)) ([#244](https://github.com/s3ntin3l8/mullion-session-manager/issues/244)) ([a4d10e7](https://github.com/s3ntin3l8/mullion-session-manager/commit/a4d10e73f86c3d3f79b428154ddbf2011f265ff6))
* per-PR CI/CD status with server-side polling ([#102](https://github.com/s3ntin3l8/mullion-session-manager/issues/102)) ([#223](https://github.com/s3ntin3l8/mullion-session-manager/issues/223)) ([1fda65d](https://github.com/s3ntin3l8/mullion-session-manager/commit/1fda65d5fc2a8c8c049609553d1717de2daea174))
* per-session status line in sidebar ([#167](https://github.com/s3ntin3l8/mullion-session-manager/issues/167)) ([#236](https://github.com/s3ntin3l8/mullion-session-manager/issues/236)) ([b2c8c09](https://github.com/s3ntin3l8/mullion-session-manager/commit/b2c8c0964b3e8a5ccf0671b1b3d59bbbbb4bdb20))
* route hook messages into the notification event model ([#256](https://github.com/s3ntin3l8/mullion-session-manager/issues/256)) ([2c60184](https://github.com/s3ntin3l8/mullion-session-manager/commit/2c60184c4a19b25a3663ab90755ea584c4edb377))
* session tab notification badges + attention visuals ([#168](https://github.com/s3ntin3l8/mullion-session-manager/issues/168), [#98](https://github.com/s3ntin3l8/mullion-session-manager/issues/98)) ([#237](https://github.com/s3ntin3l8/mullion-session-manager/issues/237)) ([9f6cf4c](https://github.com/s3ntin3l8/mullion-session-manager/commit/9f6cf4cd6c4fb7fa1433e911446a0dcafbdcb7d2))
* session timeline panel ([#212](https://github.com/s3ntin3l8/mullion-session-manager/issues/212)) ([#266](https://github.com/s3ntin3l8/mullion-session-manager/issues/266)) ([85f1220](https://github.com/s3ntin3l8/mullion-session-manager/commit/85f12209f293252c395634123aaea05fbc42b9a0))
* sidebar session row redesign ([#202](https://github.com/s3ntin3l8/mullion-session-manager/issues/202)) ([#241](https://github.com/s3ntin3l8/mullion-session-manager/issues/241)) ([8347d49](https://github.com/s3ntin3l8/mullion-session-manager/commit/8347d49428f9ff8f2e3d8c3c552025e5b7649f7e))
* upgrade notification panel to event feed ([#169](https://github.com/s3ntin3l8/mullion-session-manager/issues/169)) ([#239](https://github.com/s3ntin3l8/mullion-session-manager/issues/239)) ([47dc424](https://github.com/s3ntin3l8/mullion-session-manager/commit/47dc4245012ebbd6b6a1eabc2f7e905be620cd13))


### Bug Fixes

* attention-clear heuristics + detection improvements ([#171](https://github.com/s3ntin3l8/mullion-session-manager/issues/171), [#98](https://github.com/s3ntin3l8/mullion-session-manager/issues/98)) ([#235](https://github.com/s3ntin3l8/mullion-session-manager/issues/235)) ([2faedad](https://github.com/s3ntin3l8/mullion-session-manager/commit/2faedad34434d0f7dc519d7207409ef21e6210cc))
* modal overlays constrained to sidebar ([#201](https://github.com/s3ntin3l8/mullion-session-manager/issues/201)) ([#238](https://github.com/s3ntin3l8/mullion-session-manager/issues/238)) ([09047e9](https://github.com/s3ntin3l8/mullion-session-manager/commit/09047e958331ef5ce6a98b90090f5b56ca0d597b))
* pre-fill project root in create modal and mkdir project dir on create/edit ([#243](https://github.com/s3ntin3l8/mullion-session-manager/issues/243)) ([20a8bff](https://github.com/s3ntin3l8/mullion-session-manager/commit/20a8bff995209a29103b2aa07d72de312614c97e))

## [0.2.0](https://github.com/s3ntin3l8/mullion-session-manager/compare/v0.1.13...v0.2.0) (2026-07-22)


### ⚠ BREAKING CHANGES

* every TESSERA_* environment variable is renamed to MULLION_* (TESSERA_ROLE, TESSERA_SESSION_SECRET, TESSERA_AGENT_TOKEN, TESSERA_AUTH_TOKEN, TESSERA_OIDC_ISSUER, TESSERA_OIDC_CLIENT_ID, TESSERA_OIDC_CLIENT_SECRET, TESSERA_OIDC_REDIRECT_URI, TESSERA_HOME, TESSERA_UPDATE_REPO). Any deployed host must update its .env to the new names before upgrading, or the app silently falls back to defaults (role=primary, all secrets empty) rather than failing to boot. The release tarball asset name also changed (tessera-*.tgz -> mullion-*.tgz); a host on its bundled (pre-rename) self-update.sh will fail one self-update cycle at the transition release — re-run deploy/install.sh manually for that release instead.

### Features

* rename Tessera to Mullion ([#208](https://github.com/s3ntin3l8/mullion-session-manager/issues/208)) ([f6c437b](https://github.com/s3ntin3l8/mullion-session-manager/commit/f6c437b8cbed5c37c3906f957b176b8731ed0d24))

## [0.1.13](https://github.com/s3ntin3l8/tessera-session-manager/compare/v0.1.12...v0.1.13) (2026-07-22)


### Features

* batch git-status endpoint to avoid per-project rate limiting ([#203](https://github.com/s3ntin3l8/tessera-session-manager/issues/203)) ([29a02ce](https://github.com/s3ntin3l8/tessera-session-manager/commit/29a02ce72fc2fcdb618b0efecc0f179dc4eb89b7))


### Bug Fixes

* honor OSC 52 clipboard writes from terminal programs ([#206](https://github.com/s3ntin3l8/tessera-session-manager/issues/206)) ([cc6d492](https://github.com/s3ntin3l8/tessera-session-manager/commit/cc6d4928fa3b090b00d5883bc356eb49bc335dc8))
* recognize alt-screen/mouse-mode escape sequences split across PTY reads ([#207](https://github.com/s3ntin3l8/tessera-session-manager/issues/207)) ([979b3b0](https://github.com/s3ntin3l8/tessera-session-manager/commit/979b3b0f382ce7ddf5aafb38cbb2fbcf56b4cf13))
* sanitize leaked GIT_* env vars in git-invoking code and tests ([#205](https://github.com/s3ntin3l8/tessera-session-manager/issues/205)) ([8d03d73](https://github.com/s3ntin3l8/tessera-session-manager/commit/8d03d733ba9be030c468ede06fe52e9754ddcbdf))

## [0.1.12](https://github.com/s3ntin3l8/tessera-session-manager/compare/v0.1.11...v0.1.12) (2026-07-22)


### Features

* show local branches and worktrees in the git panel ([#165](https://github.com/s3ntin3l8/tessera-session-manager/issues/165)) ([6a1ed55](https://github.com/s3ntin3l8/tessera-session-manager/commit/6a1ed552651237a6f1ae9e6927ca605090f3d95f))


### Bug Fixes

* distinguish transient git-status failures from durable non-repo ([#164](https://github.com/s3ntin3l8/tessera-session-manager/issues/164)) ([cc0b016](https://github.com/s3ntin3l8/tessera-session-manager/commit/cc0b016212bd72c74e2059500e3780bb64e21f13))

## [0.1.11](https://github.com/s3ntin3l8/tessera-session-manager/compare/v0.1.10...v0.1.11) (2026-07-22)


### Bug Fixes

* don't cache null git-status results, preventing transient failure amplification ([#160](https://github.com/s3ntin3l8/tessera-session-manager/issues/160)) ([9658adb](https://github.com/s3ntin3l8/tessera-session-manager/commit/9658adb3f2a956a2162ee39e037db86129b31a83))

## [0.1.10](https://github.com/s3ntin3l8/tessera-session-manager/compare/v0.1.9...v0.1.10) (2026-07-22)


### Bug Fixes

* restore mouse-tracking mode on scrollback replay ([#158](https://github.com/s3ntin3l8/tessera-session-manager/issues/158)) ([5ac1707](https://github.com/s3ntin3l8/tessera-session-manager/commit/5ac17075024d881c69326d04df5d24d1ee88bbe9))

## [0.1.9](https://github.com/s3ntin3l8/tessera-session-manager/compare/v0.1.8...v0.1.9) (2026-07-22)


### Features

* git status panel, sidebar badges, and branch labels ([#149](https://github.com/s3ntin3l8/tessera-session-manager/issues/149)) ([be889b3](https://github.com/s3ntin3l8/tessera-session-manager/commit/be889b390fde19435f8a96bf90679650ac493eb1))
* git worktree mode for isolated parallel sessions ([#152](https://github.com/s3ntin3l8/tessera-session-manager/issues/152)) ([7588085](https://github.com/s3ntin3l8/tessera-session-manager/commit/7588085da363b4927e455aa5dba6e649fb12c094))
* make sidebar size customizable via drag-to-resize ([#147](https://github.com/s3ntin3l8/tessera-session-manager/issues/147)) ([988b441](https://github.com/s3ntin3l8/tessera-session-manager/commit/988b441940d39d7e5ed5260e9ac01f76b096d1a1))
* saved URLs per project — quick-access bookmarks in the built-in browser ([#109](https://github.com/s3ntin3l8/tessera-session-manager/issues/109)) ([#153](https://github.com/s3ntin3l8/tessera-session-manager/issues/153)) ([ce207d1](https://github.com/s3ntin3l8/tessera-session-manager/commit/ce207d1d7d3ed892997a86eee000c1cd1963ff26))
* sidebar shows OSC title with agent logo, tooltip on hover ([#148](https://github.com/s3ntin3l8/tessera-session-manager/issues/148)) ([ac81827](https://github.com/s3ntin3l8/tessera-session-manager/commit/ac81827a48596092b793699a9262f0b2f1288188))


### Bug Fixes

* bind vite dev server to 0.0.0.0 instead of localhost (avoids ipv6-only binding) ([#154](https://github.com/s3ntin3l8/tessera-session-manager/issues/154)) ([2948081](https://github.com/s3ntin3l8/tessera-session-manager/commit/2948081f50b5e3685dab4d19cdb9914f9fe18221))
* dock first panel, fix drag-to-pane, theme-align floating chrome ([#121](https://github.com/s3ntin3l8/tessera-session-manager/issues/121)) ([#145](https://github.com/s3ntin3l8/tessera-session-manager/issues/145)) ([dd30ce5](https://github.com/s3ntin3l8/tessera-session-manager/commit/dd30ce5c69b947ead76b9972340afa9e7f3f0006))

## [0.1.8](https://github.com/s3ntin3l8/tessera-session-manager/compare/v0.1.7...v0.1.8) (2026-07-21)


### Features

* add agent icons to settings/sidebar/tabs and toggleable agent visibility ([#86](https://github.com/s3ntin3l8/tessera-session-manager/issues/86)) ([#143](https://github.com/s3ntin3l8/tessera-session-manager/issues/143)) ([989457a](https://github.com/s3ntin3l8/tessera-session-manager/commit/989457a3a9d79a7928775ca92008f50c74adb4f6))
* add configurable pane padding around terminal content ([#91](https://github.com/s3ntin3l8/tessera-session-manager/issues/91)) ([#128](https://github.com/s3ntin3l8/tessera-session-manager/issues/128)) ([3855a36](https://github.com/s3ntin3l8/tessera-session-manager/commit/3855a3631ac43951ca41475d873566f895aba32f))
* surface update notifications on main screen ([#84](https://github.com/s3ntin3l8/tessera-session-manager/issues/84)) ([#144](https://github.com/s3ntin3l8/tessera-session-manager/issues/144)) ([2c711b2](https://github.com/s3ntin3l8/tessera-session-manager/commit/2c711b2675010d9cd5a3f86774342e8953071d12))


### Bug Fixes

* answer OSC 10/11/12 color queries and advertise truecolor ([#91](https://github.com/s3ntin3l8/tessera-session-manager/issues/91)) ([#125](https://github.com/s3ntin3l8/tessera-session-manager/issues/125)) ([f5207ae](https://github.com/s3ntin3l8/tessera-session-manager/commit/f5207aeda9eb0323ae2bc0d35d0c4f354267d13a))
* compress narrow multi-tab dockview groups instead of scrolling ([#136](https://github.com/s3ntin3l8/tessera-session-manager/issues/136)) ([5fd4114](https://github.com/s3ntin3l8/tessera-session-manager/commit/5fd41142df0283b7e588ffeffc3fc129eee58141))
* darken bright ANSI colors and resolve brightWhite to fg in light mode ([#131](https://github.com/s3ntin3l8/tessera-session-manager/issues/131)) ([9330563](https://github.com/s3ntin3l8/tessera-session-manager/commit/933056318c9e02dc248157468e2df8090ba1ee31))
* fall back to DOM renderer on WebGL context loss ([#135](https://github.com/s3ntin3l8/tessera-session-manager/issues/135)) ([fe3b6ab](https://github.com/s3ntin3l8/tessera-session-manager/commit/fe3b6abb3864fa82bb4db6a9c7b1e504aaa25a23))
* force full terminal repaint when a new panel is added ([#124](https://github.com/s3ntin3l8/tessera-session-manager/issues/124)) ([3b65ca6](https://github.com/s3ntin3l8/tessera-session-manager/commit/3b65ca6ac53c5d9bc0628053c94b4d6bcf09c58a))
* guard auto-review job from dependabot-triggered runs ([#141](https://github.com/s3ntin3l8/tessera-session-manager/issues/141)) ([96ab114](https://github.com/s3ntin3l8/tessera-session-manager/commit/96ab11445f322359737bc17337fa2d4d474a37eb))
* make dockview panel chrome follow the active terminal color scheme ([#133](https://github.com/s3ntin3l8/tessera-session-manager/issues/133)) ([3ea586b](https://github.com/s3ntin3l8/tessera-session-manager/commit/3ea586ba2e006aeb02a8bb282c74466c684d2ab9))
* notify opencode of theme changes via DEC 997 sequence ([#127](https://github.com/s3ntin3l8/tessera-session-manager/issues/127)) ([35b500a](https://github.com/s3ntin3l8/tessera-session-manager/commit/35b500a971afe27b3948a246929a324dac1fbb2c))
* pin shell-quote to patched 1.9.0+ via npm override ([#138](https://github.com/s3ntin3l8/tessera-session-manager/issues/138)) ([50a0bd1](https://github.com/s3ntin3l8/tessera-session-manager/commit/50a0bd14cb3aa5b1bc7d56052927f7cc000eec81))
* serialize nudgeRedraw() cycles to close a scrollback-suppression race ([#129](https://github.com/s3ntin3l8/tessera-session-manager/issues/129)) ([63354e4](https://github.com/s3ntin3l8/tessera-session-manager/commit/63354e489f86165f51147291d1462a43359f8bba))
* shrink toolbar-lead and drop divider when sidebar collapsed ([#90](https://github.com/s3ntin3l8/tessera-session-manager/issues/90)) ([#142](https://github.com/s3ntin3l8/tessera-session-manager/issues/142)) ([df59b12](https://github.com/s3ntin3l8/tessera-session-manager/commit/df59b12ec3c897d76c4bd00e1bddefad9e0f889b))
* stop treating keystroke echo as activity (partial [#97](https://github.com/s3ntin3l8/tessera-session-manager/issues/97)) ([#140](https://github.com/s3ntin3l8/tessera-session-manager/issues/140)) ([8f1352f](https://github.com/s3ntin3l8/tessera-session-manager/commit/8f1352f3ec4ea266cf91ad3539ac735f090f7542))
* use GitHub releases list endpoint and show check staleness ([#130](https://github.com/s3ntin3l8/tessera-session-manager/issues/130)) ([1df99e9](https://github.com/s3ntin3l8/tessera-session-manager/commit/1df99e9852b4d7bb98cfd326cebae30c015dcbf4))
* vertically align split-right/split-down buttons with tab close/overflow buttons ([#139](https://github.com/s3ntin3l8/tessera-session-manager/issues/139)) ([a29f6f6](https://github.com/s3ntin3l8/tessera-session-manager/commit/a29f6f6eb300abe453bb80a6c4a3c330d6457fb3))

## [0.1.7](https://github.com/s3ntin3l8/tessera-session-manager/compare/v0.1.6...v0.1.7) (2026-07-20)


### Features

* floating peek for cross-workspace sessions + sidebar drag-to-dock ([#78](https://github.com/s3ntin3l8/tessera-session-manager/issues/78)) ([48bf185](https://github.com/s3ntin3l8/tessera-session-manager/commit/48bf18534053646fb8f39f32378c6dd9dca48fb3))
* paste/attach images into terminal sessions ([#106](https://github.com/s3ntin3l8/tessera-session-manager/issues/106)) ([59e28ed](https://github.com/s3ntin3l8/tessera-session-manager/commit/59e28eda1b937808fd8205a3d94b1ca8ff7c851f))


### Bug Fixes

* block script-executing iframe schemes and harden log sanitization ([#111](https://github.com/s3ntin3l8/tessera-session-manager/issues/111)) ([8edb9cf](https://github.com/s3ntin3l8/tessera-session-manager/commit/8edb9cf55d4c4f1149e80a7b1fe2c92dbfb16a94))
* bypass update-check cache on manual re-check, reduce TTL to 1h ([#62](https://github.com/s3ntin3l8/tessera-session-manager/issues/62)) ([ca0e581](https://github.com/s3ntin3l8/tessera-session-manager/commit/ca0e5810093b0f2631e87358f115d447ba9ee075))
* correct terminal status detection false positives ([#74](https://github.com/s3ntin3l8/tessera-session-manager/issues/74)) ([74f4028](https://github.com/s3ntin3l8/tessera-session-manager/commit/74f402815e9d1d22dc3a214bb1797878a06ec4ad))
* default DiscoverProjects panel to collapsed state ([#116](https://github.com/s3ntin3l8/tessera-session-manager/issues/116)) ([7d051fa](https://github.com/s3ntin3l8/tessera-session-manager/commit/7d051fa2f2170bfa920c6dd5e60501299434fe27))
* deterministic terminal scrollback replay and stop nudge-repaint eviction ([#92](https://github.com/s3ntin3l8/tessera-session-manager/issues/92)) ([0837f89](https://github.com/s3ntin3l8/tessera-session-manager/commit/0837f89cf11270f5cef6e6619d3a9d2b92b4803b))
* force terminal repaint on reattach to a live session ([#65](https://github.com/s3ntin3l8/tessera-session-manager/issues/65)) ([5d5a90b](https://github.com/s3ntin3l8/tessera-session-manager/commit/5d5a90b887bee4697d22c7b2b3327a42e02d639d))
* hide xterm.js's empty legacy scrollbar overlay ([#117](https://github.com/s3ntin3l8/tessera-session-manager/issues/117)) ([8603db2](https://github.com/s3ntin3l8/tessera-session-manager/commit/8603db29991d7319019eaa11e797920ff39a4240))
* isolate terminal sessions and dev boot from inherited Tessera env ([#77](https://github.com/s3ntin3l8/tessera-session-manager/issues/77)) ([3e56c4c](https://github.com/s3ntin3l8/tessera-session-manager/commit/3e56c4c9c228beb9cbab4aa01dc275521238257a))
* isolate test env from dev shell variable leakage ([#82](https://github.com/s3ntin3l8/tessera-session-manager/issues/82)) ([eae15bf](https://github.com/s3ntin3l8/tessera-session-manager/commit/eae15bfa93661bfe28d82c830fdf0944496081ba))
* NODE_ENV leak breaking frontend vitest + inert pre-commit/pre-push hooks ([#115](https://github.com/s3ntin3l8/tessera-session-manager/issues/115)) ([c26c00d](https://github.com/s3ntin3l8/tessera-session-manager/commit/c26c00d8c19a69f30de05a64fd5e0541a957902a))
* prevent killed session panels from reappearing after workspace switch ([#81](https://github.com/s3ntin3l8/tessera-session-manager/issues/81)) ([d0fde53](https://github.com/s3ntin3l8/tessera-session-manager/commit/d0fde538100b05149fea6d502cf82f70e47953b7))
* push OSC color sequences on theme toggle for terminal-aware CLI tools ([#80](https://github.com/s3ntin3l8/tessera-session-manager/issues/80)) ([6b182ca](https://github.com/s3ntin3l8/tessera-session-manager/commit/6b182ca5098b2e7d50bdff2e1d366c2d57db18cd))
* restore Vite dev Fast-Refresh preamble under leaked NODE_ENV ([#105](https://github.com/s3ntin3l8/tessera-session-manager/issues/105)) ([#118](https://github.com/s3ntin3l8/tessera-session-manager/issues/118)) ([b0802f4](https://github.com/s3ntin3l8/tessera-session-manager/commit/b0802f4c7719f84b9ce4087bf7337fa671e36011))
* settings scheme preview reflects active theme ([#79](https://github.com/s3ntin3l8/tessera-session-manager/issues/79)) ([c34f80b](https://github.com/s3ntin3l8/tessera-session-manager/commit/c34f80baca57c622e55f7f86f0c2a2e75ad322e6))
* show remove button for exited sessions in sidebar ([#63](https://github.com/s3ntin3l8/tessera-session-manager/issues/63)) ([3d43964](https://github.com/s3ntin3l8/tessera-session-manager/commit/3d4396487e9bd9d8811f270afd256d74e94f845c))
* track running program in tab title via xterm onTitleChange ([#75](https://github.com/s3ntin3l8/tessera-session-manager/issues/75)) ([c579ad3](https://github.com/s3ntin3l8/tessera-session-manager/commit/c579ad3c1cd5320f641ac0e842c4e430a08bcb3b))
* update local workspaces state after saveWorkspaceLayout ([#113](https://github.com/s3ntin3l8/tessera-session-manager/issues/113)) ([05ab8ac](https://github.com/s3ntin3l8/tessera-session-manager/commit/05ab8ac3e19bd8a3927a109727bc3ed43593644d))

## [0.1.6](https://github.com/s3ntin3l8/tessera-session-manager/compare/v0.1.5...v0.1.6) (2026-07-20)


### Features

* native OIDC login ([#30](https://github.com/s3ntin3l8/tessera-session-manager/issues/30)) sharing Phase 1's session cookie ([#59](https://github.com/s3ntin3l8/tessera-session-manager/issues/59)) ([9595c4c](https://github.com/s3ntin3l8/tessera-session-manager/commit/9595c4cc8490ebaf71a2b6d3d75aa57f489be87e))
* optional in-process auth — shared-token gate + session cookie ([#19](https://github.com/s3ntin3l8/tessera-session-manager/issues/19)) ([#57](https://github.com/s3ntin3l8/tessera-session-manager/issues/57)) ([df376b8](https://github.com/s3ntin3l8/tessera-session-manager/commit/df376b899814f1203063d3dc6fdbf2f2a0339fc2))


### Bug Fixes

* sync terminal color scheme with app theme on toggle ([c108502](https://github.com/s3ntin3l8/tessera-session-manager/commit/c1085026c103d37321e59700827438c7259c5425))

## [0.1.5](https://github.com/s3ntin3l8/tessera-session-manager/compare/v0.1.4...v0.1.5) (2026-07-19)


### Features

* add agent internal API for multi-host sessions (issue [#26](https://github.com/s3ntin3l8/tessera-session-manager/issues/26), phase 2/N) ([#33](https://github.com/s3ntin3l8/tessera-session-manager/issues/33)) ([cecfb13](https://github.com/s3ntin3l8/tessera-session-manager/commit/cecfb13f40d7e428a027ba0d0f75bac82773ea55))
* add CI/CD Actions workflow status (issue [#27](https://github.com/s3ntin3l8/tessera-session-manager/issues/27), phase 5/N) ([#42](https://github.com/s3ntin3l8/tessera-session-manager/issues/42)) ([c185c6b](https://github.com/s3ntin3l8/tessera-session-manager/commit/c185c6b63fdb31f180aca21281f83975a537e4c9))
* add frontend host management for multi-host sessions ([#35](https://github.com/s3ntin3l8/tessera-session-manager/issues/35)) ([0bea94f](https://github.com/s3ntin3l8/tessera-session-manager/commit/0bea94f851f572689d9bf687051b5ea34f2cfc72))
* add GitHub Dock widget, panel, and + menu entry (issue [#27](https://github.com/s3ntin3l8/tessera-session-manager/issues/27), phase 3/N) ([#40](https://github.com/s3ntin3l8/tessera-session-manager/issues/40)) ([6bbd10e](https://github.com/s3ntin3l8/tessera-session-manager/commit/6bbd10e74c820ae8c7d583ae591cf6a0d2600655))
* add GitHub integration credential storage + Settings UI (issue [#27](https://github.com/s3ntin3l8/tessera-session-manager/issues/27), phase 1/N) ([#38](https://github.com/s3ntin3l8/tessera-session-manager/issues/38)) ([b2eb833](https://github.com/s3ntin3l8/tessera-session-manager/commit/b2eb83374c67ba302b56725b8b03b2492b19b2da))
* add GitHub OAuth device flow (issue [#27](https://github.com/s3ntin3l8/tessera-session-manager/issues/27), phase 4/N) ([#41](https://github.com/s3ntin3l8/tessera-session-manager/issues/41)) ([96bab0a](https://github.com/s3ntin3l8/tessera-session-manager/commit/96bab0aa877e21d9b1c213a8ee616ebffd8b34f4))
* add multi-host role scaffolding for sessions (issue [#26](https://github.com/s3ntin3l8/tessera-session-manager/issues/26), phase 1/N) ([d79e253](https://github.com/s3ntin3l8/tessera-session-manager/commit/d79e253dde5dab8f3f336a6a945cfb038d9fc2df))
* add owner/repo derivation + per-project GitHub status API (issue [#27](https://github.com/s3ntin3l8/tessera-session-manager/issues/27), phase 2/N) ([#39](https://github.com/s3ntin3l8/tessera-session-manager/issues/39)) ([5d1d191](https://github.com/s3ntin3l8/tessera-session-manager/commit/5d1d191a4bae944ca6edfb304c557f90de5568ef))
* add primary-side host routing/proxy for multi-host sessions (issue [#26](https://github.com/s3ntin3l8/tessera-session-manager/issues/26), phase 3/N) ([#34](https://github.com/s3ntin3l8/tessera-session-manager/issues/34)) ([5dfc263](https://github.com/s3ntin3l8/tessera-session-manager/commit/5dfc2634b0259ab1cbb7af5aae8298dfbddf0774))
* browser pane panel, triggers, dev-URL config UI (issue [#28](https://github.com/s3ntin3l8/tessera-session-manager/issues/28), phase 4/N) ([#46](https://github.com/s3ntin3l8/tessera-session-manager/issues/46)) ([a5a164b](https://github.com/s3ntin3l8/tessera-session-manager/commit/a5a164bc2ae5f588c26b5833c0a61f28d8e225be))
* dev-server port auto-discovery (issue [#28](https://github.com/s3ntin3l8/tessera-session-manager/issues/28), phase 7/N) ([#49](https://github.com/s3ntin3l8/tessera-session-manager/issues/49)) ([f1a2544](https://github.com/s3ntin3l8/tessera-session-manager/commit/f1a2544111bb685aab974f1aa070e6ab843a45c1))
* direct-embed browser pane fallback when PREVIEW_BASE_HOST is unset ([#52](https://github.com/s3ntin3l8/tessera-session-manager/issues/52)) ([9ec27b7](https://github.com/s3ntin3l8/tessera-session-manager/commit/9ec27b72132f2703ea1a4ef2a5275c38e31fb240))
* external-URL previews with SSRF guards (issue [#28](https://github.com/s3ntin3l8/tessera-session-manager/issues/28), phase 5/N) ([#47](https://github.com/s3ntin3l8/tessera-session-manager/issues/47)) ([22d4029](https://github.com/s3ntin3l8/tessera-session-manager/commit/22d40290743fdcd3ec041b86668a8533a48a0b1d))
* HMR websocket proxying for browser panes (issue [#28](https://github.com/s3ntin3l8/tessera-session-manager/issues/28), phase 3/N) ([#45](https://github.com/s3ntin3l8/tessera-session-manager/issues/45)) ([92d0c73](https://github.com/s3ntin3l8/tessera-session-manager/commit/92d0c73d38e7dee1f9c87d92e74d942ff0d01ad2))
* multi-host two-hop preview + wildcard deploy templates (issue [#28](https://github.com/s3ntin3l8/tessera-session-manager/issues/28), phase 6/N) ([#48](https://github.com/s3ntin3l8/tessera-session-manager/issues/48)) ([70dbeef](https://github.com/s3ntin3l8/tessera-session-manager/commit/70dbeef525d848cc9220f5a063d0e2b7f2bd88cf))
* preview config, slug registry, base-host wiring (issue [#28](https://github.com/s3ntin3l8/tessera-session-manager/issues/28), phase 1/N) ([#43](https://github.com/s3ntin3l8/tessera-session-manager/issues/43)) ([5960d8b](https://github.com/s3ntin3l8/tessera-session-manager/commit/5960d8b407b5ea1b6ab8d7d1492c159b7a35cf97))
* resizeable, per-workspace split-column dock ([#53](https://github.com/s3ntin3l8/tessera-session-manager/issues/53)) ([f8a9fcd](https://github.com/s3ntin3l8/tessera-session-manager/commit/f8a9fcdc6e8752efce479007c99fb88ed4667718))
* subdomain HTTP reverse proxy for local dev servers (issue [#28](https://github.com/s3ntin3l8/tessera-session-manager/issues/28), phase 2/N) ([#44](https://github.com/s3ntin3l8/tessera-session-manager/issues/44)) ([346136e](https://github.com/s3ntin3l8/tessera-session-manager/commit/346136e0d3994e79274d5ffd3ac70ff69d83a9e0))
* versioned-release prod deploy + in-app auto-update ([#54](https://github.com/s3ntin3l8/tessera-session-manager/issues/54)) ([9886e2d](https://github.com/s3ntin3l8/tessera-session-manager/commit/9886e2de7f49da0a0fd7e341548c5fb6e97951da))

## [0.1.4](https://github.com/s3ntin3l8/tessera-session-manager/compare/v0.1.3...v0.1.4) (2026-07-17)


### Features

* brand as Tessera ([79d1251](https://github.com/s3ntin3l8/tessera-session-manager/commit/79d125111244f3981cedc49dcaa14e5a82a7f19c))
* **ci:** add Claude Code GitHub Workflow ([#16](https://github.com/s3ntin3l8/tessera-session-manager/issues/16)) ([8f9479e](https://github.com/s3ntin3l8/tessera-session-manager/commit/8f9479ed8f0fabbe01a82b9f652b7d323d906248))
* **ci:** add on-demand [@mention](https://github.com/mention) review alongside auto-review ([#15](https://github.com/s3ntin3l8/tessera-session-manager/issues/15)) ([ef78d1e](https://github.com/s3ntin3l8/tessera-session-manager/commit/ef78d1e5ac33496ab123b3fed777e1ac64308744))
* **ci:** auto-review PRs with Hermes bot ([#12](https://github.com/s3ntin3l8/tessera-session-manager/issues/12)) ([28ebf6e](https://github.com/s3ntin3l8/tessera-session-manager/commit/28ebf6ea8f3ca31c4d748d976c232ea26d8f09ae))
* make the toolbar notification bell interactive ([#20](https://github.com/s3ntin3l8/tessera-session-manager/issues/20)) ([b544f01](https://github.com/s3ntin3l8/tessera-session-manager/commit/b544f017d672d30ff32967393341b8d3d98fb684))
* restore quick trash/rename actions and tidy the projects tree ([#25](https://github.com/s3ntin3l8/tessera-session-manager/issues/25)) ([eaf4eb5](https://github.com/s3ntin3l8/tessera-session-manager/commit/eaf4eb5bad89221c9a5d1e3dac95364610d53cff))
* rework settings page with server-persisted preferences ([#13](https://github.com/s3ntin3l8/tessera-session-manager/issues/13)) ([a1b4ed6](https://github.com/s3ntin3l8/tessera-session-manager/commit/a1b4ed688832f5d471bb6241eb30fccf90543d8b))


### Bug Fixes

* **ci:** auto-review only on PR open, not every push ([#17](https://github.com/s3ntin3l8/tessera-session-manager/issues/17)) ([e74a968](https://github.com/s3ntin3l8/tessera-session-manager/commit/e74a968097f23f0786e29b1f0414638a77dbb5ef))
* **ci:** correct claude_args flag name (--allowedTools) ([#18](https://github.com/s3ntin3l8/tessera-session-manager/issues/18)) ([fc98bab](https://github.com/s3ntin3l8/tessera-session-manager/commit/fc98bab2382caf54a6e46a7c20e0edf33d9d0544))
* **ci:** restrict Hermes on-demand review to trusted commenters ([#21](https://github.com/s3ntin3l8/tessera-session-manager/issues/21)) ([7e65308](https://github.com/s3ntin3l8/tessera-session-manager/commit/7e65308c1b3f64ed750597fdd2a5f766d499e2cb))

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
