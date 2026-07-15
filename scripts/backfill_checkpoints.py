"""One-shot backfill: populate debugger_llm_cache from recent LLM telemetry.

Reads ``telemetry_events`` rows with ``event_type IN (llm.completion, ...)``
from the last N days and upserts them into ``debugger_llm_cache`` via
:class:`PrefixCacheService`.

Gated by ``debugger_checkpoint_backfill_v1`` (default off).  Set the
env var ``DEBUGGER_CHECKPOINT_BACKFILL_V1=true`` before running.

Run:

    uv run python scripts/backfill_checkpoints.py [--days 7] [--dry-run]

Options:
    --days N      Lookback window in days (default: 7)
    --dry-run     Print what would be upserted without writing
    --batch-size  Rows per page (default: 500)
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from typing import Any

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger("backfill_checkpoints")

_LLM_EVENT_TYPES = (
    "llm.completion",
    "llm_completion",
    "llm_completion_stream",
    "openai.chat_completion",
    "anthropic.message",
    "bedrock.invoke_model",
    "gemini.generate_content",
    "otel.llm_completion",
    "helicone.request",
    "langfuse.observation",
)


async def run(days: int, dry_run: bool, batch_size: int) -> int:
    from eden.config import get_settings
    settings = get_settings()
    if not settings.debugger_checkpoint_backfill_v1:
        logger.error(
            "Backfill is disabled. Set DEBUGGER_CHECKPOINT_BACKFILL_V1=true to enable."
        )
        return 1

    from eden.storage.postgres import get_postgres_client, close_postgres_client
    from eden.observability.ingestion.checkpoint_hook import extract_llm_payload
    from eden.debugger.cache import PrefixCacheService, llm_input_hash

    pg = await get_postgres_client()
    cache_svc = PrefixCacheService(pg)

    placeholders = ", ".join(f"${i + 1}" for i in range(len(_LLM_EVENT_TYPES)))
    query = f"""
        SELECT tenant_id, trace_id, payload
        FROM telemetry_events
        WHERE event_type IN ({placeholders})
          AND timestamp >= NOW() - INTERVAL '{days} days'
        ORDER BY timestamp ASC
        LIMIT {batch_size} OFFSET ${{offset}}
    """

    offset = 0
    total = 0
    upserted = 0

    while True:
        sql = f"""
            SELECT tenant_id, trace_id, payload
            FROM telemetry_events
            WHERE event_type = ANY($1::text[])
              AND timestamp >= NOW() - INTERVAL '{days} days'
            ORDER BY timestamp ASC
            LIMIT $2 OFFSET $3
        """
        rows = await pg.fetch(sql, list(_LLM_EVENT_TYPES), batch_size, offset)
        if not rows:
            break

        for row in rows:
            total += 1
            tenant_id = row["tenant_id"] or "default"
            trace_id = row["trace_id"] or ""
            if not trace_id:
                continue

            payload: Any = row["payload"]
            if isinstance(payload, str):
                try:
                    payload = json.loads(payload)
                except Exception:
                    continue
            if not isinstance(payload, dict):
                continue

            fields = extract_llm_payload(payload)
            ih = llm_input_hash(list(fields["input_messages"]))
            step_number = fields["step_number"]
            if step_number is None:
                step_number = 0

            if dry_run:
                logger.info(
                    "DRY-RUN upsert: org=%s trace=%s step=%d hash=%s",
                    tenant_id, trace_id, step_number, ih[:12],
                )
                upserted += 1
                continue

            ok = await cache_svc.upsert(
                org_id=str(tenant_id),
                trace_id=str(trace_id),
                step_number=int(step_number),
                input_hash=ih,
                response=dict(fields["response"]),
                model=fields.get("model") or None,
            )
            if ok:
                upserted += 1

        offset += len(rows)
        if len(rows) < batch_size:
            break

    logger.info(
        "Backfill complete: %d rows scanned, %d upserted%s.",
        total,
        upserted,
        " (dry-run)" if dry_run else "",
    )
    await close_postgres_client()
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description="Backfill debugger_llm_cache")
    parser.add_argument("--days", type=int, default=7, help="Lookback days (default 7)")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--batch-size", type=int, default=500)
    args = parser.parse_args()
    rc = asyncio.run(run(args.days, args.dry_run, args.batch_size))
    sys.exit(rc)


if __name__ == "__main__":
    main()
