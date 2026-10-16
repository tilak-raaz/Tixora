COMPOSE = docker compose -f infra/docker-compose.yml
# The full stack (ADR 0014): the app in containers behind nginx. DEMO=1 adds fake payments.
STACK = $(COMPOSE) $(if $(DEMO),-f infra/docker-compose.demo.yml,) --profile full

.DEFAULT_GOAL := help
.PHONY: help up down reset logs ps psql redis-cli migrate create-admin seed bench replay-dlq dev-api dev-worker dev-web build-web stack stack-seed stack-down stack-logs stack-ps stack-warm stack-e2e test test-unit test-integration e2e lint typecheck format check

help: ## List available targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

up: ## Start Postgres, Redis and Mailpit and wait until healthy
	$(COMPOSE) up -d --wait

down: ## Stop the containers, the full stack's too (data is kept)
	$(COMPOSE) --profile full down

reset: ## Stop the containers and delete all local data
	$(COMPOSE) --profile full down -v

logs: ## Follow container logs
	$(COMPOSE) logs -f

ps: ## Show container status
	$(COMPOSE) ps

psql: ## Open psql against the local database
	$(COMPOSE) exec postgres psql -U bmt -d bmt

redis-cli: ## Open redis-cli against the local Redis
	$(COMPOSE) exec redis redis-cli

migrate: ## Apply pending database migrations
	npm run migrate

create-admin: ## Create or promote the admin account from ADMIN_* in .env
	npm run create-admin

seed: ## Load a demo city, theatres, movies and a week of shows (runs once)
	npm run seed

bench: ## Benchmark the seat-hold strategies; writes docs/benchmarks/ (needs make up)
	npm run bench
	npx prettier --write docs/benchmarks

replay-dlq: ## List and replay a queue's failed jobs: make replay-dlq QUEUE=email [DRY=1]
	npm run replay-dlq -- --queue $(QUEUE) $(if $(DRY),--dry-run,)

dev-api: ## Run the API with reload
	npm run dev:api

dev-worker: ## Run the worker with reload
	npm run dev:worker

dev-web: ## Run the Next.js app with reload (http://localhost:3000; needs dev-api)
	npm run dev:web

build-web: ## Production build of the Next.js app
	npm run build:web

stack: ## Build and start the full stack behind nginx at http://localhost:8080 (DEMO=1: fake payments)
	$(STACK) up -d --build --wait --wait-timeout 300

stack-seed: ## Seed the demo catalog from inside the stack (does nothing if already seeded)
	$(STACK) run --rm --no-deps migrate node --import tsx apps/api/src/scripts/seed.ts

stack-down: ## Stop and remove the stack's app containers (Postgres, Redis and their data stay)
	$(STACK) rm --stop --force api worker web nginx migrate

stack-logs: ## Follow the stack's logs (nginx's show which replica answered each request)
	$(STACK) logs -f api worker web nginx

stack-ps: ## Show the stack's containers and their health
	$(STACK) ps

stack-warm: ## Wait until the stack answers at normal speed, not just healthy (before tests and load runs)
	infra/scripts/warm-up.sh http://localhost:8080

stack-e2e: ## Playwright through nginx: starts the stack with fake payments and rate limits off
	RATE_LIMIT_ENABLED=false $(MAKE) stack DEMO=1
	$(MAKE) stack-seed DEMO=1
	$(MAKE) stack-warm
	E2E_BASE_URL=http://localhost:8080 npm run e2e

test: ## Run all tests (integration tests start their own containers)
	npm test

test-unit: ## Run unit tests only
	npm run test:unit

test-integration: ## Run integration tests only
	npm run test:integration

e2e: ## Browser tests with Playwright: web + API on ports 3100/4100, fake payments (needs make up migrate seed)
	npm run e2e

lint: ## Lint the whole repo
	npm run lint

typecheck: ## Typecheck every workspace
	npm run typecheck

format: ## Format the whole repo
	npm run format

check: lint typecheck test build-web ## Everything CI runs
