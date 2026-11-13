#!/usr/bin/env bash
# Starts an Uptime Kuma image on a fresh SQLite database and checks that it works, for the
# Fork Sync workflow: the server finishes starting and stays up, it serves the frontend,
# socket.io answers, and the admin can log in. This catches breakage that merges cleanly
# but fails at runtime, like a require() of a file that upstream deleted.
#
# Usage: smoke-test.sh <image>
set -euo pipefail

image=${1:?Usage: smoke-test.sh <image>}
name=fork-sync-smoke-test
port=${PORT:-3001}
url=http://127.0.0.1:$port
username=smoketest
password=$(openssl rand -hex 16)

# fail <message>: prints the message and the server log, and exits
fail() {
    echo "::error::$1" >&2
    echo "--- server log ---"
    docker logs "$name" 2>&1 | tail -n 100
    exit 1
}

docker rm --force "$name" > /dev/null 2>&1 || true
trap 'docker rm --force "$name" > /dev/null 2>&1 || true' EXIT
docker run --detach --name "$name" --publish "127.0.0.1:$port:3001" \
    --env UPTIME_KUMA_DB_TYPE=sqlite \
    --env UK_INITIAL_ADMIN_USERNAME="$username" --env UK_INITIAL_ADMIN_PASSWORD="$password" \
    "$image" > /dev/null

# The first start creates the database, and the server only listens once it is ready
for ((seconds = 0; ; seconds++)); do
    [[ $(docker inspect --format '{{.State.Running}}' "$name") == true ]] || fail "The server exited while starting"
    curl --silent --fail --output /dev/null "$url/api/auth/ok" && break
    ((seconds < 180)) || fail "The server didn't answer within 3 minutes"
    sleep 1
done
echo "The server answered after ${seconds}s"

# check <description> <text the response must contain> <curl arguments...>
check() {
    local description=$1 expected=$2 response
    shift 2
    response=$(curl --silent --show-error --fail "$@") || fail "$description: the request failed"
    [[ $response == *"$expected"* ]] || fail "$description: the response doesn't contain $expected"
    echo "ok: $description"
}
check "The main server is up, not the database setup page" '"needSetup":false' "$url/setup-database-info"
check "The frontend is served" '<div id="app">' "$url/dashboard"
check "socket.io answers" '"sid"' "$url/socket.io/?EIO=4&transport=polling"
check "The admin can log in" '"token"' --header "Content-Type: application/json" \
    --data "{\"username\":\"$username\",\"password\":\"$password\"}" "$url/api/auth/sign-in/username"

# Monitors and background jobs start after the server listens, so check that it stays up
sleep 5
[[ $(docker inspect --format '{{.State.Running}}' "$name") == true ]] || fail "The server exited after starting"
echo "Smoke test passed"
