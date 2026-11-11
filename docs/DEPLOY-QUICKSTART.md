# Deploy quickstart: one box, then three

Every command below is meant to be pasted as it stands, after you set the variables at the top of each part. The
why behind each step is in [DEPLOY.md](DEPLOY.md); the kit is in `deploy/`. Prices and stock change: check at
signup. Nothing here was run against a real provider by the session that wrote it; the kit's validation is
DEPLOY.md §12.

## Before you start (once, on your own machine)

You need: `git`, `ssh` with a key, `openssl`, `python3`, [Bun](https://bun.sh) 1.4+, a domain whose DNS you
control, and one Ubuntu 24.04 server you can SSH into as root (a Hetzner dedicated server after `installimage`, an
Oracle A1 instance, or any VPS with 2+ cores and 8+ GB).

```bash
git clone https://github.com/KaiavN/Eden.git && cd Eden
mkdir -p secrets && chmod 700 secrets      # .env files live here; never commit them
```

## Part 1: one box (about 15 minutes)

```bash
# 1. Your values.
SERVER=203.0.113.10                         # the server's public IP
DOMAIN=eden.example.com                     # its DNS A record must point at SERVER (do it now)
EMAIL=ops@example.com                       # for Let's Encrypt
ADMIN=$(curl -s https://api.ipify.org)/32   # where SSH will be allowed from (this machine)
REF=main                                    # the git tag or branch to run

# 2. Set the machine up (Docker, firewall, upgrades, Eden's code and its systemd unit). Skip on an Oracle instance
#    created with deploy/tofu/oci, which did this through its user data.
deploy/scripts/bootstrap-dedicated.sh root@$SERVER single $REF https://github.com/KaiavN/Eden.git $ADMIN

# 3. Secrets: a tenant key, the persistence key (make it once; keep a copy in your password manager). Eden refuses
#    to start if the key opens none of the users it persisted (a mistyped key, D1071); EDEN_PERSIST_DISCARD=1 for
#    one start discards them on purpose (a rotated key).
cp deploy/compose/single/.env.example secrets/single.env
sed -i "s|^EDEN_DOMAIN=.*|EDEN_DOMAIN=$DOMAIN|; s|^ACME_EMAIL=.*|ACME_EMAIL=$EMAIL|" secrets/single.env
sed -i "s|^EDEN_API_KEYS=.*|EDEN_API_KEYS=acme:$(openssl rand -hex 24)|" secrets/single.env
sed -i "s|^EDEN_PERSIST_KEY=.*|EDEN_PERSIST_KEY=$(openssl rand -hex 32)|" secrets/single.env
chmod 600 secrets/single.env

# 4. Install them and start Eden (it builds the image on the box: a few minutes the first time).
deploy/scripts/push-secrets.sh root@$SERVER single secrets/single.env

# 5. Check: readiness, 30 events, metrics. Caddy needs a minute for the certificate.
EDEN_API_KEY=$(grep '^EDEN_API_KEYS=' secrets/single.env | cut -d: -f2) bun deploy/scripts/cluster-smoke.ts https://$DOMAIN
```

Your agent now calls `https://$DOMAIN` with `Authorization: Bearer <the key after acme:>` (docs/INTEGRATION.md).
Backups run daily on the box (`/var/backups/eden`); point monitoring at it with `deploy/monitoring/` (DEPLOY.md §8).

**Upgrade later:** `ssh root@$SERVER /opt/eden/deploy/scripts/upgrade.sh /opt/eden/deploy/compose/single $REF`
(requests are held, not failed, during the restart).

## Part 2: three nodes behind a cluster router

When one box is past about 75% memory at its daily peak (DEPLOY.md §10). Three node machines (the old box can be
one: it re-reads its users' sources once, since a node starts from the shared store), one small router machine,
a private network between them, and an S3-compatible bucket.

```bash
# 1. Your values. Private addresses on the network between the machines (a Hetzner vSwitch for dedicated servers,
#    the VCN subnet on Oracle).
N1=203.0.113.11; N2=203.0.113.12; N3=203.0.113.13; ROUTER=203.0.113.20    # public IPs, for SSH
P1=10.0.1.11; P2=10.0.1.12; P3=10.0.1.13                                  # private IPs
DOMAIN=eden.example.com; EMAIL=ops@example.com; ADMIN=$(curl -s https://api.ipify.org)/32; REF=main
URL=https://github.com/KaiavN/Eden.git
# The store: a bucket (say eden-frozen) and an access key scoped to it, made in the provider's console, with a
# lifecycle rule deleting objects under frozen/ after 8 days. Hetzner Object Storage (no request fees):
S3_ENDPOINT=https://fsn1.your-objectstorage.com; S3_REGION=fsn1; S3_KEY=...; S3_SECRET=...

# 2. Set the machines up.
for host in $N1 $N2 $N3; do deploy/scripts/bootstrap-dedicated.sh root@$host node $REF $URL $ADMIN 10.0.1.0/24; done
deploy/scripts/bootstrap-dedicated.sh root@$ROUTER router $REF $URL $ADMIN

# 3. One set of secrets for every node (the same tenant, persistence and cluster keys everywhere). Reuse the single
#    box's EDEN_API_KEYS and EDEN_PERSIST_KEY if it becomes a node, so tenants keep their key.
API_KEYS=$(sed -n 's/^EDEN_API_KEYS=//p' secrets/single.env 2>/dev/null || true)
API_KEYS=${API_KEYS:-acme:$(openssl rand -hex 24)}
PERSIST_KEY=$(sed -n 's/^EDEN_PERSIST_KEY=//p' secrets/single.env 2>/dev/null || true)
PERSIST_KEY=${PERSIST_KEY:-$(openssl rand -hex 32)}
CLUSTER_KEY=$(openssl rand -hex 24)
for i in 1 2 3; do
  p=$(eval echo \$P$i)
  cat > secrets/node$i.env <<EOF
PRIVATE_IP=$p
EDEN_API_KEYS=$API_KEYS
EDEN_PERSIST_KEY=$PERSIST_KEY
EDEN_CLUSTER_KEY=$CLUSTER_KEY
EDEN_CLUSTER_SIZE=3
EDEN_PERSIST_STORE=s3://eden-frozen/frozen/
EDEN_S3_ENDPOINT=$S3_ENDPOINT
EDEN_S3_REGION=$S3_REGION
EDEN_S3_ACCESS_KEY_ID=$S3_KEY
EDEN_S3_SECRET_ACCESS_KEY=$S3_SECRET
EOF
  chmod 600 secrets/node$i.env
done
cat > secrets/router.env <<EOF
EDEN_DOMAIN=$DOMAIN
ACME_EMAIL=$EMAIL
EDEN_API_KEYS=$API_KEYS
EDEN_CLUSTER_KEY=$CLUSTER_KEY
EOF
chmod 600 secrets/router.env
printf 'n1=http://%s:8790\nn2=http://%s:8790\nn3=http://%s:8790\n' $P1 $P2 $P3 > secrets/nodes

# 4. Start the nodes, then the router (it reads the nodes file; DNS for DOMAIN now points at ROUTER).
deploy/scripts/push-secrets.sh root@$N1 node secrets/node1.env
deploy/scripts/push-secrets.sh root@$N2 node secrets/node2.env
deploy/scripts/push-secrets.sh root@$N3 node secrets/node3.env
scp secrets/nodes root@$ROUTER:/opt/eden/deploy/compose/cluster-router/nodes
deploy/scripts/push-secrets.sh root@$ROUTER cluster-router secrets/router.env

# 5. Check through the router: "cluster nodes up 3".
EDEN_API_KEY=$(echo "$API_KEYS" | cut -d: -f2 | cut -d, -f1) bun deploy/scripts/cluster-smoke.ts https://$DOMAIN
```

**Add a fourth node later:** bootstrap it (`… node …`), push a `node4.env` like the others with `PRIVATE_IP` set,
then `echo "n4=http://10.0.1.14:8790" | ssh root@$ROUTER 'cat >> /opt/eden/deploy/compose/cluster-router/nodes'`:
the router releases about a quarter of the users to it, no restart. Set `EDEN_CLUSTER_SIZE=4` on every node at its
next upgrade. **Upgrade a cluster:** `deploy/scripts/rolling-upgrade.sh` (DEPLOY.md §11).

**On Oracle instead** of dedicated servers: `cd deploy/tofu/oci && cp terraform.tfvars.example terraform.tfvars`,
edit it (`node_count = 3`, `router_count = 1`), `tofu init && tofu apply`, then steps 3-5 with the IPs it prints
(`tofu output`); skip step 2 (the instances ran the cloud-init at boot). Oracle Object Storage's S3 endpoint is
`https://<namespace>.compat.objectstorage.<region>.oraclecloud.com` with a Customer Secret Key.
