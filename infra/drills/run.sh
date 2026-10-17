#!/usr/bin/env bash
# Failure drills (ADR 0017): break one part of the running full stack while steady traffic flows,
# put it back, and report what users saw. Each drill passes or fails on what the probe checks.
#
#   infra/drills/run.sh replica [kill|stop]   an API replica dies (SIGKILL; Docker restarts it) or
#                                             is stopped (SIGTERM; started again at 35 s)
#   infra/drills/run.sh redis                 Redis down for 30 s
#   infra/drills/run.sh postgres              Postgres restarts
#   infra/drills/run.sh worker                a worker is killed while confirmation emails go out
#
# Needs the full stack (make stack DEMO=1); the worker drill needs DEMO=1 for fake payments.
set -euo pipefail
cd "$(dirname "$0")/../.."

drill="${1:?usage: infra/drills/run.sh replica|redis|postgres|worker}"
COMPOSE="docker compose -f infra/docker-compose.yml"
TRAFFIC=bmt-drill-traffic
LOGS_PID=
T0=$(date +%s)

say() { printf '\n>>> %s  %s\n\n' "$(date +%H:%M:%S)" "$*"; }

# Puts back whatever the drill broke, however the script ends (including Ctrl-C).
restore() { :; }
on_exit() {
  restore
  [ -n "$LOGS_PID" ] && kill "$LOGS_PID" 2>/dev/null || true
  docker rm -f "$TRAFFIC" >/dev/null 2>&1 || true
}
trap on_exit EXIT

# Starts the traffic container (a script from infra/drills) in the background, shows its output,
# and waits until it prints a line starting with `marker`. Sets T0 to that moment.
start_traffic() {
  local script=$1 marker=$2
  shift 2
  docker rm -f "$TRAFFIC" >/dev/null 2>&1 || true
  $COMPOSE --profile load run -d --no-deps --name "$TRAFFIC" "$@" drill node "/drills/$script" \
    >/dev/null
  docker logs -f "$TRAFFIC" &
  LOGS_PID=$!
  until docker logs "$TRAFFIC" 2>&1 | grep -q "^$marker"; do
    if [ "$(docker inspect -f '{{.State.Running}}' "$TRAFFIC" 2>/dev/null)" != true ]; then
      finish
    fi
    sleep 0.5
  done
  T0=$(date +%s)
}

# Crashes the Node process inside a container with SIGKILL, as an out-of-memory kill or a fatal bug
# would. Docker sees the container exit on its own and its restart policy applies; `docker kill`
# would count as a deliberate stop and leave it down.
crash() {
  docker exec "$1" node -e "
    const fs = require('fs');
    for (const pid of fs.readdirSync('/proc').filter((d) => /^\\d+\$/.test(d))) {
      const cmd = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8');
      if (cmd.includes('$2') && Number(pid) !== process.pid) process.kill(Number(pid), 'SIGKILL');
    }" || true
}

# Prints when a container reports healthy again, in seconds after T0 (in the background).
report_healthy() {
  (
    sleep 1
    until [ "$(docker inspect -f '{{.State.Health.Status}}' "$1" 2>/dev/null)" = healthy ]; do
      sleep 0.5
    done
    say "t=$(($(date +%s) - T0))s  $1 is healthy again"
  ) &
}

# Sleeps until `seconds` after T0.
at() {
  local now=$(($(date +%s) - T0))
  if [ "$1" -gt "$now" ]; then sleep $(($1 - now)); fi
}

# Waits for the traffic to finish, puts things back, and exits with its verdict.
finish() {
  local code
  code=$(docker wait "$TRAFFIC")
  wait "$LOGS_PID" 2>/dev/null || true
  LOGS_PID=
  restore
  say "drill '$drill' finished: $([ "$code" = 0 ] && echo PASS || echo FAIL)"
  exit "$code"
}

case "$drill" in
  replica)
    mode="${2:-kill}"
    target=$(docker ps --filter 'name=^bmt-api-' --format '{{.Names}}' | sort | sed -n 2p)
    [ -n "$target" ] || { echo 'need at least 2 API replicas running (make stack)'; exit 1; }
    restore() { docker start "$target" >/dev/null 2>&1 || true; }
    start_traffic probe.mjs ready -e DURATION=60
    at 15
    if [ "$mode" = stop ]; then
      say "t=15s  docker stop $target   (SIGTERM: stops taking requests, drains, exits)"
      docker stop -t 20 "$target" >/dev/null
      at 35
      say "t=35s  docker start $target"
      docker start "$target" >/dev/null
    else
      say "t=15s  SIGKILL to the API process in $target   (a crash: gone mid-request; Docker restarts it)"
      crash "$target" server.ts
    fi
    report_healthy "$target"
    finish
    ;;
  redis)
    restore() { docker start bmt-redis-1 >/dev/null 2>&1 || true; }
    start_traffic probe.mjs ready -e DURATION=75
    at 15
    say 't=15s  docker stop bmt-redis-1   (Redis down)'
    docker stop bmt-redis-1 >/dev/null
    at 45
    say 't=45s  docker start bmt-redis-1'
    docker start bmt-redis-1 >/dev/null
    finish
    ;;
  postgres)
    restore() { docker start bmt-postgres-1 >/dev/null 2>&1 || true; }
    start_traffic probe.mjs ready -e DURATION=60
    at 15
    say 't=15s  docker restart bmt-postgres-1   (stop, then start)'
    docker restart -t 10 bmt-postgres-1 >/dev/null
    say "t=$(($(date +%s) - T0))s  postgres is back"
    finish
    ;;
  worker)
    # The restart policy would bring the worker straight back; this drill keeps it down to show
    # that the other worker takes over its jobs.
    restore() {
      docker update --restart unless-stopped bmt-worker-1 >/dev/null 2>&1 || true
      docker start bmt-worker-1 >/dev/null 2>&1 || true
    }
    [ "$(docker inspect -f '{{.State.Running}}' bmt-worker-2 2>/dev/null)" = true ] ||
      { echo 'bmt-worker-2 is not running; start the stack first (make stack DEMO=1)'; exit 1; }
    start_traffic emails.mjs paid -e "BOOKINGS=${BOOKINGS:-20}"
    docker update --restart no bmt-worker-1 >/dev/null
    sleep 2
    say 'docker kill bmt-worker-1   (SIGKILL while the confirmation emails go out; kept down)'
    docker kill bmt-worker-1 >/dev/null
    finish
    ;;
  *)
    echo "unknown drill: $drill (replica, redis, postgres, worker)"
    exit 2
    ;;
esac
