"""Alembic's bookkeeping table, widened to fit this project's revision ids.

Alembic creates ``alembic_version.version_num`` as ``VARCHAR(32)``
(``alembic/ddl/impl.py``, ``DefaultImpl.version_table_impl``). This project
names revisions after what they do rather than with a hash, and two of them
are longer than that::

    118_improvement_plans_closed_status     35 characters
    124_missing_columns_both_sides_assume   37 characters

So ``alembic upgrade head`` against a **fresh** database ran revision 118's
DDL and then died recording it::

    sqlalchemy.exc.DataError: (psycopg2.errors.StringDataRightTruncation)
    value too long for type character varying(32)
    [SQL: UPDATE alembic_version SET version_num='118_improvement_plans_closed_status' ...]

Reproduced end to end against a throwaway Postgres 16 before writing this
module. Existing databases were unaffected -- theirs were created back when
every id still fit, and Postgres does not retroactively shrink a column -- so
the failure only ever appeared on a new volume: a new environment, a
restored-from-empty disaster-recovery drill, or CI's "Apply migrations" step.

**Widening is the safe direction.** The alternative -- renaming the two long
revisions -- rewrites every ``down_revision`` pointer that references them,
the corresponding rows in ``docs/ops/migration-matrix.md``, and the value
already stored in ``alembic_version`` on every deployed database. A renamed
revision that some database has already recorded makes that database
unresolvable ("Can't locate revision identified by ..."). The column width is
the only part of this that is not load-bearing history.

Two mechanisms, because there are two populations:

* :func:`use_wide_version_table` overrides the documented ``version_table_impl``
  hook so alembic creates the column wide in the first place. This is what
  fixes a **fresh** database. (It is also the only mechanism that *could*
  help ``alembic upgrade --sql``, which has no connection to repair anything
  through -- but offline mode is independently unusable in this project: the
  revisions guard themselves with ``_table_exists()``, and
  ``op.get_bind().execute(...)`` returns ``None`` when there is no
  connection.)
* :func:`ensure_version_table` widens an **existing** narrow column. Databases
  created before this module already have ``varchar(32)`` and the hook does
  not retroactively touch them.

This lives in ``env.py``'s startup rather than in a migration because the
version table is written *by* the migration runner: a migration that tried to
widen it would have to record its own completion in the too-narrow column
first.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import Column, MetaData, PrimaryKeyConstraint, String, Table, text
from sqlalchemy.engine import Connection

#: Width for ``version_num``. Alembic's default is 32; the longest revision id
#: in this project is 37. 128 leaves room for descriptive names without
#: another migration-time surprise, and costs nothing -- Postgres ``varchar(n)``
#: stores only the bytes present, so the declared bound is a constraint, not an
#: allocation.
VERSION_NUM_WIDTH = 128

VERSION_TABLE = "alembic_version"
VERSION_COLUMN = "version_num"

_CURRENT_WIDTH_SQL = text(
    """
    SELECT character_maximum_length
    FROM information_schema.columns
    WHERE table_name = :table
      AND column_name = :column
      AND table_schema = current_schema()
    """
)


def use_wide_version_table() -> None:
    """Make alembic create ``version_num`` at :data:`VERSION_NUM_WIDTH`.

    ``version_table_impl`` is alembic's documented extension point for
    replacing the structure of the version table (added in alembic 1.14 for
    third-party dialects). ``PostgresqlImpl`` does not override it, so
    patching ``DefaultImpl`` covers the dialect this project uses.

    Raises ``AttributeError`` on an alembic too old to have the hook. That is
    deliberate: silently falling back to ``varchar(32)`` would restore the
    original bug on exactly the fresh-database path where it is hardest to
    notice, and a hard failure at startup is cheaper than a half-applied
    schema.
    """
    from alembic.ddl.impl import DefaultImpl

    if not hasattr(DefaultImpl, "version_table_impl"):  # pragma: no cover
        raise AttributeError(
            "alembic.ddl.impl.DefaultImpl has no 'version_table_impl' hook "
            "(added in alembic 1.14). Without it the version table is created "
            f"as varchar(32) and revision ids up to {VERSION_NUM_WIDTH} "
            "characters cannot be recorded. Upgrade alembic."
        )

    def version_table_impl(
        self: Any,
        *,
        version_table: str,
        version_table_schema: str | None,
        version_table_pk: bool,
        **kw: Any,
    ) -> Table:
        vt = Table(
            version_table,
            MetaData(),
            Column(VERSION_COLUMN, String(VERSION_NUM_WIDTH), nullable=False),
            schema=version_table_schema,
        )
        if version_table_pk:
            vt.append_constraint(
                PrimaryKeyConstraint(VERSION_COLUMN, name=f"{version_table}_pkc")
            )
        return vt

    DefaultImpl.version_table_impl = version_table_impl  # type: ignore[method-assign]


def ensure_version_table(connection: Connection) -> None:
    """Widen an existing narrow ``version_num`` column.

    For databases created before :func:`use_wide_version_table` existed. No-op
    when the table is absent (a fresh database -- alembic will create it wide)
    or already wide enough, so the common path costs one
    ``information_schema`` lookup and no DDL.

    Must run *before* ``context.run_migrations()``: alembic writes the version
    row as each revision completes, so waiting until after the run means the
    truncation has already happened.

    Scoped to ``current_schema()``. ``env.py`` does not set
    ``version_table_schema``, so that is the schema alembic uses; if one is
    ever configured, this lookup has to take it too or it will silently find
    nothing and skip a widening that was needed.
    """
    width = connection.execute(
        _CURRENT_WIDTH_SQL, {"table": VERSION_TABLE, "column": VERSION_COLUMN}
    ).scalar()

    # No row: the table does not exist yet. ``None`` width: the column is
    # unbounded ``varchar``/``text``, already wider than anything we would ask
    # for. Neither needs DDL.
    if width is None or width >= VERSION_NUM_WIDTH:
        return

    connection.execute(
        text(
            f"ALTER TABLE {VERSION_TABLE} "
            f"ALTER COLUMN {VERSION_COLUMN} TYPE VARCHAR({VERSION_NUM_WIDTH})"
        )
    )
