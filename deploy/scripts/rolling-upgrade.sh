#!/usr/bin/env bash
# Upgrades every node of a cluster with no user unserved for longer than a rebalance (docs/DEPLOY.md §11). For each
# node in turn: take it out of the router's nodes file (a planned rebalance: it releases its users into the store,
# about 1/n of all users move to the others), upgrade it, put it back (they move back the same way), then the next.
#
#   deploy/scripts/rolling-upgrade.sh root@router1 /opt/eden/deploy/compose/cluster-router/nodes v2026.11.12 \
#     n1=root@10.0.1.11 n2=root@10.0.1.12 n3=root@10.0.1.13
# (node hosts as the router reaches them over SSH: through the router as a jump host, ssh -J, if they are private.)
set -euo pipefail
router=${1:?usage: rolling-upgrade.sh <router ssh> <nodes file on the router> <git ref> id=ssh ...}
nodes_file=${2:?nodes file}
ref=${3:?git ref}
shift 3
full=$(ssh "$router" "cat '$nodes_file'")
set_nodes() {
  # The router re-reads the file on change and on SIGHUP; rebalances run one at a time.
  printf '%s\n' "$1" | ssh "$router" "cat > '$nodes_file.tmp' && mv '$nodes_file.tmp' '$nodes_file' && \
    cd \$(dirname '$nodes_file') && docker compose kill -s HUP router >/dev/null"
}
wait_rebalanced() {
  # Each rebalance logs one "eden cluster:" line; give it the router's own bound (60 s) at most.
  sleep 3
  ssh "$router" "cd \$(dirname '$nodes_file') && timeout 60 sh -c \
    'until docker compose logs --since 10s router | grep -q \"eden cluster:\"; do sleep 1; done'" || true
}
for pair in "$@"; do
  id=${pair%%=*}
  host=${pair#*=}
  echo "== $id: out of the cluster"
  set_nodes "$(printf '%s\n' "$full" | grep -v "^$id=")"
  wait_rebalanced
  echo "== $id: upgrading"
  ssh "$host" "/opt/eden/deploy/scripts/upgrade.sh /opt/eden/deploy/compose/node '$ref'"
  echo "== $id: back in"
  set_nodes "$full"
  wait_rebalanced
done
echo "rolling upgrade to $ref done"
