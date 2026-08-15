"""Generic oldest-processed-first watermark selection.

Several daily cron steps need to pick a bounded batch of entities to
process out of a table that has no natural "when was this last done"
column of its own (``organizations``, for one). The naive fix —
``SELECT ... LIMIT N`` with no ``ORDER BY`` — returns a
stable-but-arbitrary subset every single run (Postgres has no
obligation to vary plan output, and in practice doesn't), so the same
``N`` rows get reprocessed forever while everything past the limit is
silently starved. It never errors, so nothing pages on it.

:mod:`eden.columnar.compaction` already solved this correctly for
tables that *do* own a watermark column
(``columnar_partitions.last_compaction_at``, ``ORDER BY ... ASC NULLS
FIRST``). This module is that same idiom for entities that don't:
instead of an ``ALTER TABLE`` on a shared table like ``organizations``,
processing state lives in a small side table
(``<caller>_watermark(org_id PRIMARY KEY, last_processed_at)``)
that :func:`fetch_stale_candidates` left-joins against, and
:func:`advance_watermark` upserts into once an entity has been handled.
``NULLS FIRST`` means never-processed entities always sort ahead of
already-processed ones, so a growing candidate table drains in FIFO
order instead of a fixed prefix starving everything after it.

Composite keys
---------------
``candidate_id_column``, ``watermark_id_column``, ``id_alias`` (and
``advance_watermark``'s ``entity_id``/``watermark_id_column``) each
accept either a single column name (the original single-key shape,
unchanged) or a sequence of column names for a genuine multi-column
key — e.g. ``classifier_retrain``'s ``(org_id, signal_id)`` pairs or
``drift_baseline``'s ``(org_id, agent_id)`` pairs. Passing a sequence
of length 1 produces byte-identical SQL to the single-string form, so
every existing single-key caller is unaffected. ``advance_watermark``'s
``id_cast`` controls the Postgres cast applied to each bound parameter
(default ``"uuid"`` for every column, matching every watermark table
this module has shipped so far); pass ``None`` (or a per-column
sequence with ``None`` entries) for key components that aren't UUIDs,
e.g. ``agent_issues.agent_id`` is ``VARCHAR`` with no FK to a UUID
primary key.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

_ColumnArg = str | Sequence[str]


def _as_column_list(value: _ColumnArg) -> list[str]:
    return [value] if isinstance(value, str) else list(value)


async def fetch_stale_candidates(
    pg: Any,
    *,
    candidate_table: str,
    watermark_table: str,
    candidate_id_column: _ColumnArg = "id",
    watermark_id_column: _ColumnArg = "org_id",
    watermark_column: str = "last_processed_at",
    id_alias: _ColumnArg = "org_id",
    extra_columns: Sequence[str] = (),
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Return up to ``limit`` candidate ids, oldest-processed-first.

    Left-joins ``candidate_table`` against ``watermark_table`` and orders
    by ``watermark_column ASC NULLS FIRST`` — rows with no watermark row
    yet (never processed) sort before every already-processed row, and
    among those, the longest-stale sorts first. Each result row is
    ``{id_alias: "<candidate id as text>"}`` for a single-column key, or
    one text column per entry of ``id_alias`` for a composite key.

    ``candidate_id_column``/``watermark_id_column``/``id_alias`` must all
    be the same "shape" — three single strings for a single-column key,
    or three equal-length sequences for a composite key, matched up
    positionally (``candidate_id_column[i]`` joins against
    ``watermark_id_column[i]`` and is returned as ``id_alias[i]``).

    ``extra_columns`` are additional ``candidate_table`` columns to select
    and return verbatim (as text) alongside the id column(s), unchanged
    by the join/order/limit logic. Defaults to ``()``.
    """
    candidate_cols = _as_column_list(candidate_id_column)
    watermark_cols = _as_column_list(watermark_id_column)
    aliases = _as_column_list(id_alias)
    if not (len(candidate_cols) == len(watermark_cols) == len(aliases)):
        raise ValueError(
            "candidate_id_column, watermark_id_column, and id_alias must "
            "all supply the same number of columns"
        )
    select_key = ", ".join(
        f"c.{ccol}::text AS {alias}"
        for ccol, alias in zip(candidate_cols, aliases, strict=True)
    )
    join_cond = " AND ".join(
        f"w.{wcol} = c.{ccol}"
        for wcol, ccol in zip(watermark_cols, candidate_cols, strict=True)
    )
    extra_select = "".join(f", c.{col}::text AS {col}" for col in extra_columns)
    query = f"""
        SELECT {select_key}{extra_select}
        FROM {candidate_table} c
        LEFT JOIN {watermark_table} w
            ON {join_cond}
        ORDER BY w.{watermark_column} ASC NULLS FIRST
        LIMIT $1
        """
    return list(await pg.fetch(query, limit))


async def advance_watermark(
    pg: Any,
    *,
    watermark_table: str,
    entity_id: _ColumnArg,
    watermark_id_column: _ColumnArg = "org_id",
    watermark_column: str = "last_processed_at",
    id_cast: str | Sequence[str | None] | None = "uuid",
) -> None:
    """Upsert ``watermark_table.watermark_column = now()`` for ``entity_id``.

    Call this once an entity has finished a processing pass — on success
    *and* on failure. A poison entity that always raises must still
    advance, or it permanently occupies the front of
    :func:`fetch_stale_candidates`'s ordering and blocks every entity
    behind it forever; a failed pass simply gets retried on the next
    cron tick like everything else instead of wedging the queue.

    ``entity_id``/``watermark_id_column`` follow the same single-value-or-
    sequence shape as :func:`fetch_stale_candidates` for a composite key.
    ``id_cast`` is broadcast to every column when given as a single
    string (or ``None``), or supplied per-column as a sequence the same
    length as ``watermark_id_column``.
    """
    cols = _as_column_list(watermark_id_column)
    ids = [entity_id] if isinstance(entity_id, str) else list(entity_id)
    if len(cols) != len(ids):
        raise ValueError(
            "entity_id must supply exactly one value per watermark_id_column"
        )
    casts = (
        [id_cast] * len(cols) if id_cast is None or isinstance(id_cast, str) else list(id_cast)
    )
    if len(casts) != len(cols):
        raise ValueError("id_cast must supply exactly one entry per watermark_id_column")

    col_list = ", ".join(cols)
    placeholders = ", ".join(
        f"${i}" + (f"::{cast}" if cast else "") for i, cast in enumerate(casts, start=1)
    )
    query = f"""
        INSERT INTO {watermark_table} ({col_list}, {watermark_column})
        VALUES ({placeholders}, NOW())
        ON CONFLICT ({col_list}) DO UPDATE
            SET {watermark_column} = EXCLUDED.{watermark_column}
        """
    await pg.execute(query, *ids)
