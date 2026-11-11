#!/usr/bin/env bash
# Copies a role's .env to a machine over SSH (mode 600, root only) and starts Eden there (docs/DEPLOY.md §4).
# Secrets never travel in cloud-init user-data, a repository or an image.
#
#   deploy/scripts/push-secrets.sh root@203.0.113.10 single ./secrets/single.env
#   deploy/scripts/push-secrets.sh root@10.0.1.11 node ./secrets/node.env      (through a bastion: ssh -J ...)
set -euo pipefail
host=${1:?usage: push-secrets.sh <user@host> <single|node|cluster-router> <env file>}
role=${2:?role: single, node or cluster-router}
file=${3:?the .env file to install}
case "$role" in single | node | cluster-router) ;; *) echo "role must be single, node or cluster-router" >&2; exit 2 ;; esac
[ -f "$file" ] || { echo "no such file: $file" >&2; exit 2; }
# Refuse a file that still holds the example's placeholders.
if grep -q 'REPLACE' "$file"; then echo "$file still has REPLACE placeholders" >&2; exit 2; fi
dest=/opt/eden/deploy/compose/$role/.env
# The file goes over stdin, so it never sits in a temporary file or a process list on either side.
ssh "$host" "umask 077 && cat > '$dest.tmp' && chmod 600 '$dest.tmp' && mv '$dest.tmp' '$dest' && systemctl start eden"
echo "installed $dest on $host and started eden"
