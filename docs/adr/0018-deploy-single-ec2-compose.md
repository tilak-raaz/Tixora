# 0018. Deployment: one EC2 instance running the compose stack, images from GHCR, HTTPS by Let's Encrypt

- Status: Accepted
- Date: 2026-10-17

## Context

M7 runs the whole system as containers behind nginx (ADR 0014) and measured it on a laptop
(ADRs 0016, 0017). M8 puts it on the internet at `https://tixora.tilakraaz.cloud` so anyone can
browse, sign up and book with test payments. The budget is AWS free-plan credits, and the system
is a demonstration, not a business: no real money moves and losing the data loses nothing that
cannot be seeded again.

## Decision

**One EC2 `t3.small` (2 vCPU, 2 GB, plus 2 GB swap) runs `infra/deploy/docker-compose.yml`:** the
same services as the local stack, with Postgres and Redis as containers on the instance and named
volumes on its disk. API replicas and workers are settings (`API_REPLICAS`, default 3;
`WORKER_REPLICAS`, default 2) so the instance can be resized without editing files.

**The server never builds.** CI builds the server and web images on a release tag and pushes them
to GHCR (`ghcr.io/tilak-raaz/tixora-server`, `tixora-web`), tagged with the release. The server
holds a clone of the repository (public, so no token) for the compose file, nginx config and
`tixora.sh`, and `./tixora.sh deploy <tag>` checks out that tag, pulls its images and runs
`docker compose up --wait`. Building Next.js on a 2 GB machine would be slow and could exhaust its
memory; pulling also means the code that runs is exactly the code CI tested.

**HTTPS with Let's Encrypt.** nginx is the only service with published ports (80 and 443). Port 80
answers the ACME challenge and redirects everything else to HTTPS. The first certificate is
issued once with certbot standalone (`./tixora.sh tls-init`, nginx stopped); after that a certbot
container tries renewal twice a day over the webroot, and nginx reloads every 12 hours to pick up
a renewed certificate. TLS 1.2 and 1.3 only, HTTP/2, HSTS. The routes are shared with the local
stack (`infra/nginx/routes.conf`), so production routing is what `make stack-e2e` tested.

**Secrets live only on the server**, in `infra/deploy/.env` (git-ignored; `.env.example` lists every
setting). Compose refuses to start without the required ones.

**Real email, test payments.** Workers send through Resend from the `tilakraaz.cloud` domain.
Payments use Razorpay in test mode: the real gateway code path, the real webhook, no real money.

**The schedule refreshes itself.** `seed.ts` now tops up: on an existing database it adds shows for
the coming week (skipping times already taken), so a `seeder` service runs it once a day and the
site never runs out of shows.

**No database backups, by decision.** Everything in the database is demo data: seedable catalogue,
test-mode bookings and throwaway accounts. A backup job, its storage and its restore drill would
cost more to build and keep working than the data is worth. If that changes, the runbook has an
optional step to take daily EBS snapshots of the instance's disk with Data Lifecycle Manager: no
code, a few cents a month.

**The load tests are not rerun on the server.** M7's numbers (ADR 0016, `docs/benchmarks/m7-load.md`)
were measured on a laptop with more cores. A t3.small's CPU credits would shape any result, and
the point of M8 is a working deployment, not a second benchmark.

`make deploy-check` (also in CI) checks the production compose file resolves with every required
setting and that nginx accepts the HTTPS config with a throwaway certificate.

## Consequences

- One machine is one failure domain: if the instance or its disk dies, the site is down until a
  new instance is set up from the runbook and reseeded. Replicas still cover a crashed process,
  as the M7 drills showed, but not a crashed host.
- Deploys restart containers in place, so a deploy can drop the requests and seat streams in
  flight (viewers reconnect, ADR 0017). Zero-downtime deploys would need a second host or
  blue-green; not worth it here.
- Postgres, Redis, five Node processes and nginx share 2 GB. Swap absorbs spikes; if memory is
  short in practice, lower the replica counts before upgrading the instance.
- There is no metrics server: `/metrics` exists on every process (ADR 0015) but nothing scrapes it
  in production. `docker compose logs` and the JSON access logs are the observability.
- Moving to managed Postgres (RDS) or a container service later changes settings, not code: every
  service already takes its connections from the environment.
