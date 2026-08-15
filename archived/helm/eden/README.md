# Eden Helm chart

> Self-hosted deployment of the Eden platform (closes §6.6).

## One-command deploy

```bash
helm repo add eden https://charts.edenobservability.com  # when the chart is published
helm install eden eden/eden \
  --set image.tag=0.1.0 \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=eden.example.com
```

For a dev cluster (kind/minikube), the defaults work as-is:

```bash
helm install eden ./helm/eden --dependency-update
kubectl port-forward svc/eden-eden-api 8000:8000
```

## Pluggable backends

The chart ships Postgres, Redis, and Qdrant by default. To
externalise any of them, set the matching `external*` value
and disable the in-chart service:

```yaml
externalPostgres: "postgresql://user:pw@db.example.com:5432/eden"
postgres:
  enabled: false
```

The same pattern works for Redis, ClickHouse, Qdrant, and Typesense
(`externalTypesense.host`). See
[docs/ops/typesense-clickhouse-external.md](../../docs/ops/typesense-clickhouse-external.md).

### Workers / HPA / PDB / Secrets (W9)

* `worker-deployment.yaml` — `python -m eden.workers.main`
* `api-hpa.yaml` — CPU HPA when `api.hpa.enabled`
* `pdb.yaml` — PDBs for API + worker
* `secrets.yaml` — optional in-chart Secret (`secrets.create`)
* Image digest pin via `image.digest` (preferred over `tag` in prod)

## SSO-ready

```yaml
sso:
  oidcIssuer: "https://accounts.google.com"
  samlMetadataUrl: "https://samltest.id/saml/idp"
```

The backend reads these as `EDEN_SSO_OIDC_ISSUER` and
`EDEN_SSO_SAML_METADATA_URL` at startup.

## Observability

Set `monitoring.prometheus.remoteWriteUrl` to your Grafana
Cloud / managed Prometheus endpoint. The API will export
`/metrics` in Prometheus text format.

## Discord + support webhooks

```yaml
discord:
  webhookUrlSecret: eden-discord-webhook  # k8s Secret with key 'url'
support:
  webhookUrl: https://hooks.zendesk.com/...
```

## What this chart does NOT do

* **Data residency** (§6.5) — that requires regional Postgres
  + ClickHouse deployments, which are out of scope for this
  chart. Operators should pick a region when launching and
  pin their data layer to it.
* **Backups** — operators are expected to wire their own
  Postgres + S3 backup. The `dr_drill.sh` script in
  `scripts/` exercises the restore path.
* **Disaster recovery** — see `docs/runbooks/disaster-recovery-drill.md`.
