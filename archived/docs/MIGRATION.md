# Database migrations

Eden uses **Alembic** for Postgres schema migrations. This doc covers the
day-to-day workflow + recovery procedures.

## TL;DR

```bash
# Apply all pending migrations
alembic upgrade head

# Roll back the most recent migration
alembic downgrade -1

# Generate a new migration from a model change
alembic revision --autogenerate -m "add foo column to bar"

# See the current head
alembic heads
```

## Conventions

* **One concern per migration.** Multi-table changes belong in separate
  revisions so a partial failure doesn't break the chain.
* **Idempotent DDL.** Use `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX
  CONCURRENTLY IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`. The migration
  must succeed on a DB that's already at this revision (re-running the
  same upgrade).
* **No data migrations in structural migrations.** If you need to
  backfill a column, ship a follow-up data migration so the chain stays
  reorderable.
* **Backwards-compatible.** A new column with a default is fine. A
  `NOT NULL` without a default is NOT fine (breaks the running app).
* **Long migrations** (>1 min) on prod-sized tables: use
  `CREATE INDEX CONCURRENTLY` (must run outside a transaction — see
  `op.execute("COMMIT")` first).

## Pre-commit checklist

Before opening a PR with a migration:

1. Run `alembic upgrade head` on a fresh DB — does it apply clean?
2. Run `alembic downgrade -1` — does it roll back clean?
3. Run `alembic upgrade head` again — does it re-apply clean?
4. Run the test suite — does anything assume the old schema?
5. Check `alembic heads` — is there a chain fork? (If yes, merge heads.)

## Recovery

### Stamping a drifted DB

If the alembic_version table is at a wrong revision (e.g. a manual SQL
patch was applied):

```bash
# Find the correct head
alembic heads
# Stamp without running the migration
alembic stamp <revision>
```

### Rebuilding from scratch

```bash
# Drop and recreate
dropdb eden
createdb eden
alembic upgrade head
```

### Production rollback

See `docs/runbooks/migration-rollback.md` for the full procedure. TL;DR:

1. Notify on-call.
2. Run `alembic downgrade -1` (or to a specific revision).
3. Verify with smoke tests.
4. If downgrade is destructive (column drop), restore from backup
   instead.
