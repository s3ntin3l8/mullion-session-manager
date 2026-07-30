.DEFAULT_GOAL := help

.PHONY: help install install-hooks dev test test-coverage test-e2e lint typecheck format format-check build clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies
	npm ci

install-hooks: ## Install pre-commit hooks (requires pre-commit installed)
	pre-commit install
	pre-commit install --hook-type pre-push

dev: ## Start dev server
	npm run dev

test: ## Run tests
	npm run test

test-coverage: ## Run tests with coverage
	npm run test:coverage

test-e2e: ## Run the opt-in Phase 4 socket API e2e suite (real browser/sockets, not part of `make test`)
	npm run test:e2e

lint: ## Run linter
	npm run lint

typecheck: ## Run type checking
	npm run typecheck

format: ## Format code with Prettier
	npm run format

format-check: ## Check formatting with Prettier (pre-push gate)
	npm run format:check

build: ## Production build
	npm run build

clean: ## Remove node_modules and caches
	rm -rf node_modules dist coverage .vitest-cache
