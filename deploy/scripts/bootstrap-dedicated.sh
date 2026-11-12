#!/usr/bin/env bash
# Bootstraps a machine that was not created with user data (a Hetzner dedicated server after `installimage` with
# Ubuntu 24.04, or any VM installed by hand): renders deploy/cloud-init/eden.yaml.tftpl for its role and runs it
# with cloud-init's NoCloud source over SSH, so every machine is set up by the same file (docs/DEPLOY.md §2).
#
#   DEPLOY_KEY=~/.ssh/eden_deploy deploy/scripts/bootstrap-dedicated.sh root@203.0.113.10 single main \
#     git@github.com:Knihalani/Eden.git 198.51.100.7/32
#   (then: deploy/scripts/push-secrets.sh root@203.0.113.10 single secrets/single.env)
#
# The repository is private, so the box needs a credential to clone it, and to fetch at every upgrade.sh.
# DEPLOY_KEY=<path to a private key> names a read-only GitHub deploy key (docs/DEPLOY-QUICKSTART.md). Before cloud-init
# runs, it is installed as /root/.ssh/eden_deploy (0600) with a `Host github.com` entry in /root/.ssh/config, and
# github.com's ed25519 host key is scanned on the box into /root/.ssh/known_hosts once it matches the fingerprint
# GitHub publishes. Use the SSH URL with it. Without DEPLOY_KEY nothing is installed, as before: the URL must then be
# one the box can clone anonymously (a public mirror). The key travels over SSH only, never in user data, which the
# provider keeps and any process on the box can read. A machine made by deploy/tofu/* ran its cloud-init at boot
# without the key, so its clone failed: run this script on it with DEPLOY_KEY to install the key and run it again.
#
# A dedicated server has no cloud firewall: ufw from the cloud-init is its firewall, and for a cluster the nodes'
# private network is a Hetzner vSwitch (a VLAN; give each machine a 10.0.1.x address on it, docs/DEPLOY.md §9).
set -euo pipefail
usage="[DEPLOY_KEY=<key>] bootstrap-dedicated.sh <user@host> <single|node|router> <ref> <git url> <admin cidr> [private cidr]"
host=${1:?usage: $usage}
role=${2:?role}
ref=${3:?git ref}
url=${4:?git url}
admin=${5:?admin cidr (where SSH is allowed from)}
private=${6:-10.0.1.0/24}
here=$(cd "$(dirname "$0")" && pwd)
data=$(python3 -I "$here/render-cloud-init.py" --role "$role" --ref "$ref" --git-url "$url" --admin-cidr "$admin" \
  --private-cidr "$private")

if [ -n "${DEPLOY_KEY:-}" ]; then
  if [ ! -f "$DEPLOY_KEY" ] || [ ! -r "$DEPLOY_KEY" ]; then
    echo "bootstrap: DEPLOY_KEY=$DEPLOY_KEY is not a readable file" >&2
    exit 2
  fi
  command -v ssh-keygen >/dev/null || { echo "bootstrap: ssh-keygen is needed to check DEPLOY_KEY" >&2; exit 2; }
  # cloud-init clones with no one at the keyboard: a key with a passphrase would fail there, so refuse it here, and
  # say what ssh-keygen said (a key readable by others is refused too, for another reason).
  if ! why=$(ssh-keygen -y -P '' -f "$DEPLOY_KEY" 2>&1 >/dev/null); then
    echo "bootstrap: DEPLOY_KEY must be a private key without a passphrase (ssh-keygen: $why)" >&2
    exit 2
  fi
  case "$url" in
    git@github.com:* | ssh://git@github.com/*) ;;
    *) echo "bootstrap: warning: the deploy key is used by an SSH URL (git@github.com:...), not by $url" >&2 ;;
  esac
  # The key goes over stdin, so it is never on a command line. The Eden block goes first in the config (ssh takes
  # each option from the first block that sets it) and replaces the block of an earlier run. The host key is checked
  # against GitHub's published ed25519 fingerprint (docs.github.com, "GitHub's SSH key fingerprints") rather than
  # trusted on first scan. EDEN_SSH_DIR exists for scripts/deploy-kit.test.ts; ssh does not pass it, so it is unset.
  ssh "$host" '
    set -e
    d=${EDEN_SSH_DIR:-/root/.ssh}
    want=SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU
    umask 077
    mkdir -p "$d"
    # The host key first: on a mismatch nothing is installed (the key on stdin is never read).
    ssh-keyscan -t ed25519 github.com 2>/dev/null > "$d/github.tmp" || true
    fp=$(ssh-keygen -lf "$d/github.tmp" 2>/dev/null | awk "{print \$2}")
    if [ "$fp" != "$want" ]; then
      rm -f "$d/github.tmp"
      echo "bootstrap: github.com host key ${fp:-could not be scanned}, expected $want; nothing installed" >&2
      exit 3
    fi
    cat > "$d/eden_deploy.tmp"
    chmod 600 "$d/eden_deploy.tmp"
    mv "$d/eden_deploy.tmp" "$d/eden_deploy"
    touch "$d/config" "$d/known_hosts"
    # "Host *" closes the block, so global options an existing config starts with still apply to every host.
    {
      printf "# eden-deploy-key begin\nHost github.com\n  IdentityFile %s/eden_deploy\n  IdentitiesOnly yes\n" "$d"
      printf "Host *\n# eden-deploy-key end\n"
      sed "/^# eden-deploy-key begin\$/,/^# eden-deploy-key end\$/d" "$d/config"
    } > "$d/config.tmp"
    mv "$d/config.tmp" "$d/config"
    { grep -v "^github.com " "$d/known_hosts" || true; cat "$d/github.tmp"; } > "$d/known_hosts.tmp"
    mv "$d/known_hosts.tmp" "$d/known_hosts"
    rm -f "$d/github.tmp"
  ' < "$DEPLOY_KEY"
  echo "bootstrap: deploy key installed on $host"
fi

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
