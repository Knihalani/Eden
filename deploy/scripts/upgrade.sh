#!/usr/bin/env bash
# Upgrades one machine to a git ref with the least downtime one box allows (docs/DEPLOY.md §11):
# 1. fetch and build the new image while the old one serves (minutes, no downtime);
# 2. restart: Eden drains (in-flight requests finish, live users are written, D994), the new one starts and reads
#    users back from disk on first use. Caddy holds requests meanwhile (lb_try_duration), so callers see a slower
#    answer, not an error; measured restart of the container: docs/DEPLOY.md §11.
# In a cluster, run it on one node at a time (deploy/scripts/rolling-upgrade.sh drains each first).
#
#   deploy/scripts/upgrade.sh /opt/eden/deploy/compose/single v2026.11.12
set -euo pipefail
dir=${1:?usage: upgrade.sh <compose dir> <git ref>}
ref=${2:?the git tag or branch to run}
repo=$(git -C "$dir" rev-parse --show-toplevel)
git -C "$repo" fetch --depth 1 origin "$ref"
git -C "$repo" checkout --detach FETCH_HEAD
cd "$dir"
export EDEN_VERSION=$ref
docker compose build
t0=$(date +%s)
docker compose up -d --remove-orphans
for _ in $(seq 1 120); do
  if docker compose ps --format '{{.Health}}' | grep -qv healthy; then sleep 1; else break; fi
done
docker compose ps
echo "upgrade: now at $ref ($(git -C "$repo" rev-parse --short HEAD)); restart took $(($(date +%s) - t0)) s"
