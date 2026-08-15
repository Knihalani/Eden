# Typesense + ClickHouse externalization (SOTA Wave 9)

## Typesense

Prefer a managed Typesense Cloud (or self-hosted) cluster outside the
API/worker pods.

### Helm

```yaml
externalTypesense:
  host: "xxx.a1.typesense.net"
  port: "443"
  protocol: "https"
typesense:
  enabled: false
secrets:
  create: true
  typesenseApiKey: "<admin key>"
image:
  digest: "sha256:..."   # pin API image in prod
```

Env injected into API + worker:

* `TYPESENSE_ENABLED=true`
* `TYPESENSE_HOST` / `TYPESENSE_PORT` / `TYPESENSE_PROTOCOL`
* `TYPESENSE_API_KEY` from chart Secret

### Northflank

Set `TYPESENSE_ENABLED=true` and provision secrets `TYPESENSE_HOST` +
`TYPESENSE_API_KEY`. Do not point at localhost.

### Lag metric

`eden_search_index_lag_seconds` is **event age** at index time
(`now - event.timestamp`), not RPC duration.

## ClickHouse

```yaml
externalClickhouse: "http://user:pass@ch.example.com:8123"
clickhouse:
  enabled: false
```

Materialized views maintained by `ClickHouseSink`:

* `drift_hourly` / `drift_hourly_mv`
* `experiment_daily` / `experiment_daily_mv`
* `home_kpi_daily` / `home_kpi_daily_mv` (W9)

## Migrate smoke

Helm pre-install/upgrade Job runs `run_alembic_upgrade_head()`.
Local check:

```bash
alembic -c src/eden/db_migrations/alembic.ini heads | wc -l   # must be 1
```
