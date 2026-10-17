#!/usr/bin/env bash
# Runs the production stack on the server (ADRs 0018, 0019). The server holds a clone of the
# repository (public, so no token is needed) with infra/deploy/.env filled in.
#
#   ./tixora.sh tls-init         first time only: get the HTTPS certificate (nginx must be stopped)
#   ./tixora.sh deploy <tag>     check out the release, pull its images, start or update the stack
#   ./tixora.sh seed             add the coming week's shows now (the seeder does it daily anyway)
#   ./tixora.sh admin            create (or promote) the admin account; asks for email and password
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
    [[ $tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || {
      echo "refusing: '$tag' is not a release tag"
      exit 2
    }
    git fetch --tags --quiet origin
    git -c advice.detachedHead=false checkout --quiet "$tag"
    TAG="$tag" docker compose pull --quiet
    TAG="$tag" docker compose up -d --wait --wait-timeout 300 --remove-orphans
    # Record the running release, so later commands (seed, admin, a manual `docker compose up`)
    # use its images rather than :latest.
    if grep -q '^TAG=' .env; then sed -i "s/^TAG=.*/TAG=$tag/" .env; else echo "TAG=$tag" >>.env; fi
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
      # Whatever the CI key asked to run arrives here; deploy accepts it only if it is exactly a
      # release tag.
      deploy "${SSH_ORIGINAL_COMMAND:-}"
      ;;
    seed)
      docker compose run --rm --no-deps migrate node --import tsx apps/api/src/scripts/seed.ts
      ;;
    admin)
      # Asked for at a prompt, so the password stays out of shell history and the process list.
      local email password
      read -rp 'admin email: ' email
      read -rsp 'admin password (8+ characters): ' password
      echo
      ADMIN_EMAIL=$email ADMIN_PASSWORD=$password docker compose run --rm --no-deps \
        -e ADMIN_EMAIL -e ADMIN_PASSWORD migrate node --import tsx apps/api/src/scripts/create-admin.ts
      ;;
    ps) docker compose ps ;;
    logs) shift; docker compose logs -f --tail 100 "$@" ;;
    down) docker compose down ;;
    *)
      echo 'usage: ./tixora.sh tls-init | deploy <tag> | seed | admin | ps | logs [service] | down'
      exit 2
      ;;
  esac
}
main "$@"; exit $?
