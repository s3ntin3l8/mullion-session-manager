.DEFAULT_GOAL := help

.PHONY: help install install-hooks dev test test-backend test-coverage test-e2e lint typecheck format format-check build clean wt review

help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies
	npm ci

install-hooks: ## Install pre-commit hooks (requires pre-commit installed)
	pre-commit install
	pre-commit install --hook-type pre-push

dev: ## Start dev server
	npm run dev

test: ## Run tests (backend + frontend)
	npm run test:all

test-backend: ## Run backend tests only (fast inner loop)
	npm run test

test-coverage: ## Run tests with coverage (backend only)
	npm run test:coverage

test-e2e: ## Run the opt-in Phase 4 socket API e2e suite (real browser/sockets, not part of `make test`)
	npm run test:e2e

lint: ## Run linter (backend + frontend)
	npm run lint:all

typecheck: ## Run type checking (backend + frontend)
	npm run typecheck:all

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
	git fetch origin
	git worktree add .wt/$(name) -b $(name) origin/main
	cd .wt/$(name) && npm ci && npm --prefix frontend ci

review: ## Request a Hermes review on the current branch's PR
	gh pr comment --body "@s3ntin3l8-hermes Review"
