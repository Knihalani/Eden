#!/usr/bin/env bash
# Bootstraps a machine that was not created with user data (a Hetzner dedicated server after `installimage` with
# Ubuntu 24.04, or any VM installed by hand): renders deploy/cloud-init/eden.yaml.tftpl for its role and runs it
# with cloud-init's NoCloud source over SSH, so every machine is set up by the same file (docs/DEPLOY.md §2).
#
#   deploy/scripts/bootstrap-dedicated.sh root@203.0.113.10 single main https://github.com/KaiavN/Eden.git 198.51.100.7/32
#   (then: deploy/scripts/push-secrets.sh root@203.0.113.10 single secrets/single.env)
#
# A dedicated server has no cloud firewall: ufw from the cloud-init is its firewall, and for a cluster the nodes'
# private network is a Hetzner vSwitch (a VLAN; give each machine a 10.0.1.x address on it, docs/DEPLOY.md §9).
set -euo pipefail
host=${1:?usage: bootstrap-dedicated.sh <user@host> <single|node|router> <git ref> <git url> <admin cidr> [private cidr]}
role=${2:?role}
ref=${3:?git ref}
url=${4:?git url}
admin=${5:?admin cidr (where SSH is allowed from)}
private=${6:-10.0.1.0/24}
here=$(cd "$(dirname "$0")" && pwd)
data=$(python3 -I "$here/render-cloud-init.py" --role "$role" --ref "$ref" --git-url "$url" --admin-cidr "$admin" \
  --private-cidr "$private")
# The rendered file over stdin into NoCloud's seed, then a fresh cloud-init run of every stage.
printf '%s\n' "$data" | ssh "$host" '
  set -e
  command -v cloud-init >/dev/null || (apt-get update -q && apt-get install -y -q cloud-init)
  mkdir -p /var/lib/cloud/seed/nocloud
  cat > /var/lib/cloud/seed/nocloud/user-data
  printf "instance-id: eden-%s\nlocal-hostname: %s\n" "$(hostname)" "$(hostname)" > /var/lib/cloud/seed/nocloud/meta-data
  cloud-init clean --logs
  cloud-init init --local && cloud-init init
  cloud-init modules --mode=config && cloud-init modules --mode=final
  cloud-init status --long
'
echo "bootstrapped $host as $role at $ref; next: push-secrets.sh $host <role dir> <env file>"
