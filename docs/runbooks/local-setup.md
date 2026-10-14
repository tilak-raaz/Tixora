# Local setup

## Prerequisites

- Node.js 24 (`nvm install && nvm use` reads `.nvmrc`)
- Docker Desktop, running
- `make` (preinstalled on macOS)

## First run

```bash
cp .env.example .env
npm install          # also installs the git hooks (needs `git init` first)
make up              # Postgres :5432, Redis :6379, Mailpit UI :8025
make migrate
make dev-api         # in one terminal
make dev-worker      # in another
curl localhost:4000/readyz
```

## Everyday commands

| Command                 | What it does                                |
| ----------------------- | ------------------------------------------- |
| `make up` / `make down` | Start or stop the containers (data is kept) |
| `make reset`            | Delete all local data and start clean       |
| `make psql`             | psql shell on the local database            |
| `make redis-cli`        | redis-cli on the local Redis                |
| `make test`             | Unit + integration tests                    |
| `make check`            | Lint, typecheck and all tests, like CI      |

## Adding a migration

1. Create `db/migrations/NNNN_short_description.sql` with the next number.
2. Run `make migrate`.
3. Never edit a migration after it has been applied anywhere; add a new one. The runner refuses
   to start if an applied file's checksum changes.

## Troubleshooting

- **Port 5432 or 6379 already in use:** another Postgres or Redis is running (for example an old
  project container). Find it with `docker ps` and stop it, or change the host port in
  `infra/docker-compose.yml` and in `.env`.
- **Integration tests hang at start:** Docker Desktop is not running, or images are still
  downloading on the first run.
- **`Invalid environment configuration`:** a variable in `.env` is missing or malformed; the
  message lists each one.
