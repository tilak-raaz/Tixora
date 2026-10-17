#!/usr/bin/env bash
# Checks the production config before it reaches the server (ADR 0018): the compose file resolves
# with every required setting, and nginx accepts the HTTPS config (with a throwaway certificate).
# Run by `make deploy-check` and in CI.
set -euo pipefail
cd "$(dirname "$0")/.."

echo '1/3 server helper parses'
bash -n deploy/tixora.sh

echo '2/3 compose file'
# The example's empty secrets would (rightly) fail the required-setting checks; fill them for this.
env_file=$(mktemp)
trap 'rm -f "$env_file"' EXIT
sed -e 's/^POSTGRES_PASSWORD=$/POSTGRES_PASSWORD=check/' \
    -e 's/^BETTER_AUTH_SECRET=$/BETTER_AUTH_SECRET=check-only-secret-at-least-32-characters/' \
    -e 's/^RESEND_API_KEY=$/RESEND_API_KEY=re_check/' \
    deploy/.env.example > "$env_file"
docker compose --env-file "$env_file" -f deploy/docker-compose.yml config --quiet

echo '3/3 nginx config'
docker run --rm -e DOMAIN=tixora.example.test \
  -v "$PWD/nginx:/etc/nginx/bmt:ro" \
  -v "$PWD/deploy/nginx.conf.template:/etc/nginx/bmt-prod/nginx.conf.template:ro" \
  nginx:1.28-alpine sh -c '
    set -e
    apk add --no-cache openssl >/dev/null
    mkdir -p /etc/letsencrypt/live/$DOMAIN /var/www/certbot
    openssl req -x509 -nodes -newkey rsa:2048 -days 1 -subj "/CN=$DOMAIN" \
      -keyout /etc/letsencrypt/live/$DOMAIN/privkey.pem \
      -out /etc/letsencrypt/live/$DOMAIN/fullchain.pem 2>/dev/null
    envsubst "\${DOMAIN}" < /etc/nginx/bmt-prod/nginx.conf.template > /etc/nginx/nginx.conf
    nginx -t'
echo 'production config OK'
