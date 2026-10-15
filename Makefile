COMPOSE = docker compose -f infra/docker-compose.yml

.DEFAULT_GOAL := help
.PHONY: help up down reset logs ps psql redis-cli migrate create-admin seed bench dev-api dev-worker test test-unit test-integration lint typecheck format check

help: ## List available targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

up: ## Start Postgres, Redis and Mailpit and wait until healthy
	$(COMPOSE) up -d --wait

down: ## Stop the containers (data is kept)
	$(COMPOSE) down

reset: ## Stop the containers and delete all local data
	$(COMPOSE) down -v

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

dev-api: ## Run the API with reload
	npm run dev:api

dev-worker: ## Run the worker with reload
	npm run dev:worker

test: ## Run all tests (integration tests start their own containers)
	npm test

test-unit: ## Run unit tests only
	npm run test:unit

test-integration: ## Run integration tests only
	npm run test:integration

lint: ## Lint the whole repo
	npm run lint

typecheck: ## Typecheck every workspace
	npm run typecheck

format: ## Format the whole repo
	npm run format

check: lint typecheck test ## Everything CI runs
