.DEFAULT_GOAL := help

.PHONY: help install install-hooks dev demo screenshots screenshots-landing test test-backend test-coverage test-patch-coverage test-e2e verify-ui verify-dockview-restore lint typecheck typecheck-test format format-check build clean wt check-scope-leaks git-safe git-doctor

help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies
	npm ci

install-hooks: ## Install pre-commit hooks (requires pre-commit installed)
	pre-commit install
	pre-commit install --hook-type pre-push

dev: ## Start dev server
	npm run dev

demo: ## Throwaway isolated demo (scratch DB/sessions/HOME, clean env, loopback ports); Ctrl-C deletes it
	node scripts/demo/instance.mjs

screenshots: ## Regenerate README + PWA manifest screenshots from an isolated demo instance
	node scripts/capture-screenshots.mjs

screenshots-landing: ## Landing-page stills + terminal loop into OUT (default ./landing-shots); loop needs ffmpeg
	node scripts/capture-screenshots.mjs --profile landing --out "$(or $(OUT),landing-shots)"

test: ## Run tests (backend + frontend)
	npm run test:all

test-backend: ## Run backend tests only (fast inner loop)
	npm run test

test-coverage: ## Run tests with coverage (backend only)
	npm run test:coverage

test-patch-coverage: ## Verify >=75% patch coverage on changes against origin/main
	npm run test:patch-coverage

test-e2e: ## Run the opt-in Phase 4 socket API e2e suite (real browser/sockets, not part of `make test`)
	npm run test:e2e

verify-ui: ## Verify the UI/UX audit's runtime checks in a real browser (needs Playwright's Chromium; not part of `make test`)
	node scripts/verify-ui-runtime.mjs

verify-dockview-restore: ## Verify the dockview workspace-restore path in a real browser (issue #1903; needs Playwright's Chromium)
	node scripts/verify-dockview-restore.mjs

check-scope-leaks: ## Scan crs-session-* systemd scopes for leaks (issue #1137; standalone, not part of `make test`/lint)
	npm run check:scope-leaks

lint: ## Run linter (backend + frontend)
	npm run lint:all

typecheck: ## Run type checking (backend + frontend, incl. the test tree)
	npm run typecheck:all

# The backend's TEST tree, typechecked — issue #1860.
#
# tsconfig.test.json (the main tsconfig.json is untouched, so src/'s own
# typecheck means exactly what it meant) covers test/**, which the main
# config never did: it includes only src/**, and vitest strips types
# without checking them. A dangling type reference in a test file
# therefore failed SILENTLY.
#
# Three settings in it are load-bearing:
#
#   types: ["node", "vitest/globals"] — a `types` array REPLACES the
#     default (every installed @types package), so @types/node has to be
#     named or the sources lose it; and vitest.config.ts sets
#     `globals: true`, so the tests use describe/it/afterEach without
#     importing them.
#
#   allowJs (WITHOUT checkJs) — the .mjs modules are typed by INFERENCE
#     from their own source, which is what turned 30 "could not find a
#     declaration file" errors and many implicit-anys into errors that are
#     HONEST. The .mjs sources themselves are not checked: making them
#     type-clean is a different project.
#
#   NO "DOM" lib — the tests want the DOM's RequestInfo, but the DOM lib
#     would ALSO change RequestInit, BodyInit and ReadableStream for
#     src/ — and those files are CLEAN under the main config (which has no
#     DOM lib), so adding it there breaks src/ rather than fixing the
#     tests. The ONE type the tests are missing is declared in
#     test/types/dom-shims.d.ts instead (the DOM's own definition).
#
# Its include list also covers scripts/**/*.ts, which the MAIN config does
# not: the main one typechecks exactly one script (drizzle.config.ts) plus
# the ssh-agent filter generator, while the test tree exercises the demo
# scripts and the repo's own check scripts — so they come along here, where
# their types are actually checked.
typecheck-test: ## Type check the backend's TEST tree alone (issue #1860)
	npm run typecheck:test

format: ## Format code with Prettier
	npm run format

format-check: ## Check formatting with Prettier (pre-push gate)
	npm run format:check

build: ## Production build
	npm run build

clean: ## Remove node_modules and caches
	rm -rf node_modules dist coverage .vitest-cache

wt: ## Create a developer worktree off origin/main: make wt name=<slug>
	@if [ -z "$(name)" ]; then echo "Usage: make wt name=<slug>"; exit 1; fi
	@echo "$(name)" | grep -Eq '^[a-zA-Z0-9._-]+$$' || \
		(echo "Invalid name '$(name)': use only letters, digits, '.', '_', '-'."; exit 1)
	@case "$(name)" in main|master) echo "Refusing name '$(name)': would create a worktree" \
		"whose branch is immediately unusable (no-commit-to-branch blocks it, and a" \
		"local '$(name)' ref may not already exist to catch this via the branch check" \
		"below)."; exit 1 ;; esac
	@if [ -e ".wt/$(name)" ]; then echo ".wt/$(name) already exists."; exit 1; fi
	@if git show-ref --verify --quiet "refs/heads/$(name)"; then \
		echo "Branch '$(name)' already exists."; exit 1; \
	fi
	@$(MAKE) --no-print-directory git-safe
	git fetch origin
	git worktree add .wt/$(name) -b $(name) origin/main
	cd .wt/$(name) && npm ci && npm --prefix frontend ci

git-safe: ## Make this clone safe for concurrent agents (turns git's auto-gc off; issue #1836)
	node scripts/git-safe-clone.mjs

git-doctor: ## Report git object damage in a clone; APPLY=1 repairs it, DIR=<path> names another clone
	node --import tsx scripts/git-doctor.mjs $(if $(filter 1 yes true,$(APPLY)),--apply) $(if $(filter 1 yes true,$(FORCE)),--force) $(if $(DIR),$(DIR),.)
