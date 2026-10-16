#!/usr/bin/env bash
# Waits until the stack answers at its normal speed, not just "healthy": right after a rebuild,
# the machine is still busy (image export, a seed run, a browser starting) and requests can take
# seconds. Tests and load runs start only after five rounds in a row come back fast.
#
#   infra/scripts/warm-up.sh [base-url]        default http://localhost:8080
#   WARM_LIMIT_S=0.5 WARM_TIMEOUT_S=120        slowest acceptable response, and how long to wait
set -euo pipefail

base_url="${1:-http://localhost:8080}"
limit_s="${WARM_LIMIT_S:-0.5}"
deadline=$((SECONDS + ${WARM_TIMEOUT_S:-120}))
paths=(/api/auth/get-session /api/v1/cities / /signup)
streak=0

while ((streak < 5)); do
  if ((SECONDS > deadline)); then
    echo "warm-up: $base_url still slow or failing after ${WARM_TIMEOUT_S:-120}s" >&2
    exit 1
  fi
  fast=1
  for path in "${paths[@]}"; do
    result=$(curl -s -o /dev/null -w '%{http_code} %{time_total}' "$base_url$path" || echo '000 99')
    code=${result%% *}
    seconds=${result##* }
    if [[ $code != 200 ]] || awk -v s="$seconds" -v l="$limit_s" 'BEGIN { exit !(s > l) }'; then
      fast=0
    fi
  done
  if ((fast)); then
    streak=$((streak + 1))
  else
    streak=0
    sleep 1
  fi
done

echo "warm-up: $base_url answers normally"
