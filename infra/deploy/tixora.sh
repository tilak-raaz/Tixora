#!/usr/bin/env bash
# Runs the production stack on the server (ADRs 0018, 0019). The server holds a clone of the
# repository (public, so no token is needed) with infra/deploy/.env filled in.
#
#   ./tixora.sh tls-init         first time only: get the HTTPS certificate (nginx must be stopped)
#   ./tixora.sh deploy <tag>     check out the release, pull its images, start or update the stack
#   ./tixora.sh seed             add the coming week's shows now (the seeder does it daily anyway)
#   ./tixora.sh ps | logs [svc] | down
#   ./tixora.sh ci-deploy        only for the CI deploy key (forced in authorized_keys); the tag
#                                CI sends arrives in SSH_ORIGINAL_COMMAND
#
# The whole script is one function, read in full before it runs: `deploy` checks out a new
# version of this very file, and bash would otherwise read the rest from the new version.
main() {
  set -euo pipefail
  cd "$(dirname "$0")"
  [ -f .env ] || { echo 'infra/deploy/.env is missing: cp .env.example .env and fill it in'; exit 1; }
  setting() { grep -E "^$1=" .env | tail -n 1 | cut -d= -f2-; }

  deploy() {
    local tag=$1
    git fetch --tags --quiet origin
    git -c advice.detachedHead=false checkout --quiet "$tag"
    TAG="$tag" docker compose pull --quiet
    TAG="$tag" docker compose up -d --wait --wait-timeout 300 --remove-orphans
    docker image prune -f >/dev/null
    echo "$tag is live"
  }

  case "${1:-}" in
    tls-init)
      local domain email
      domain=$(setting DOMAIN)
      email=$(setting ACME_EMAIL)
      [ -n "$domain" ] && [ -n "$email" ] || { echo 'set DOMAIN and ACME_EMAIL in .env'; exit 1; }
      # Let's Encrypt checks the domain on port 80, so nothing else may be listening there.
      docker compose stop nginx 2>/dev/null || true
      docker compose run --rm --no-deps -p 80:80 --entrypoint certbot certbot \
        certonly --standalone -d "$domain" -m "$email" --agree-tos --no-eff-email -n
      echo "certificate ready for $domain; now: ./tixora.sh deploy <tag>"
      ;;
    deploy)
      deploy "${2:?usage: ./tixora.sh deploy <tag>, e.g. v1.0.0}"
      ;;
    ci-deploy)
      # Whatever the CI key asked to run is only accepted if it is exactly a release tag.
      local tag=${SSH_ORIGINAL_COMMAND:-}
      [[ $tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || {
        echo "refusing: '$tag' is not a release tag"
        exit 2
      }
      deploy "$tag"
      ;;
    seed)
      docker compose run --rm --no-deps migrate node --import tsx apps/api/src/scripts/seed.ts
      ;;
    ps) docker compose ps ;;
    logs) shift; docker compose logs -f --tail 100 "$@" ;;
    down) docker compose down ;;
    *)
      echo 'usage: ./tixora.sh tls-init | deploy <tag> | seed | ps | logs [service] | down'
      exit 2
      ;;
  esac
}
main "$@"; exit $?
