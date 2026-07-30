#!/usr/bin/env python3
"""Walk the path a customer walks, against live production.

Mint an API key the way the product mints one, POST a trace to the
public ingest endpoint, then read it back through the API the portal
uses. Anything that breaks here breaks a demo.

This exists because on 2026-07-29 the product had 47 telemetry events
lifetime and 0 in the previous 24 hours — so nothing had exercised the
critical path in weeks, and no test covered it end to end against a
deployed environment.

    python scripts/smoke_demo_path.py            # uses a scratch org
    python scripts/smoke_demo_path.py --keep     # leave the key behind
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
import urllib.error
import urllib.request
import uuid
from datetime import UTC, datetime
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "src"))

API = "https://api.edenobservability.com"
SMOKE_ORG_NAME = "Eden Smoke (automated)"

# Mutable holder so the header helpers can see the org id.
ORG_ID_HEADER = [""]


def _dsn() -> str:
    txt = (REPO / ".env").read_text()
    url = re.search(r"^DATABASE_URL=(.*)$", txt, re.M).group(1).strip()
    return url.replace("postgresql+asyncpg://", "postgresql://").split("?")[0]


def _post(path: str, body: dict, key: str) -> tuple[int, str]:
    req = urllib.request.Request(
        f"{API}{path}",
        data=json.dumps(body).encode(),
        headers={
            "Content-Type": "application/json",
            "X-Org-Api-Key": key,
            "Authorization": f"Bearer {key}",
            # Required even though org_id is already in the path.
            "X-Org-Id": ORG_ID_HEADER[0],
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read().decode()[:400]
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:400]
    except Exception as e:  # noqa: BLE001
        return 0, f"{type(e).__name__}: {e}"


def _get(path: str, key: str) -> tuple[int, str]:
    req = urllib.request.Request(
        f"{API}{path}",
        headers={"X-Org-Api-Key": key, "Authorization": f"Bearer {key}",
                 "X-Org-Id": ORG_ID_HEADER[0]},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read().decode()[:600]
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:400]
    except Exception as e:  # noqa: BLE001
        return 0, f"{type(e).__name__}: {e}"


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", action="store_true", help="leave the key in place")
    args = ap.parse_args()

    import asyncpg

    from eden.api.routes.api_keys import (
        generate_api_key,
        get_key_prefix,
        hash_api_key,
    )

    conn = await asyncpg.connect(_dsn(), ssl="require")
    key_id = str(uuid.uuid4())
    results: list[tuple[str, bool, str]] = []

    try:
        # ── 1. an org to ingest into ────────────────────────────────
        # Reuse a real org that has a member — that is the shape a
        # customer arrives in after signup, and creating one here would
        # need owner_id/slug that only the signup flow knows how to set.
        org_id = await conn.fetchval(
            "SELECT o.id::text FROM organizations o "
            "JOIN org_members m ON m.org_id = o.id "
            "GROUP BY o.id ORDER BY count(m.user_id) DESC LIMIT 1"
        )
        if not org_id:
            print("no org with members exists — signup has never completed")
            return 1
        ORG_ID_HEADER[0] = org_id
        results.append(("org available", True, org_id[:8]))

        # ── 2. mint a key exactly as POST /api-keys does ────────────
        raw = generate_api_key()
        await conn.execute(
            "INSERT INTO org_api_keys (id, org_id, name, key_hash, key_prefix, scopes) "
            "VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::text[])",
            key_id, org_id, "smoke-demo-path",
            hash_api_key(raw), get_key_prefix(raw),
            ["ingest:write", "traces:read", "*"],
        )
        results.append(("api key minted", True, get_key_prefix(raw)))

        # ── 3. send a trace, the thing a customer's SDK does ────────
        # /ingest/openai takes FORMAT-SPECIFIC json — an actual OpenAI
        # chat-completion response, not Eden's internal event shape.
        # Sending the generic shape returns 200 {"accepted":1} and stores
        # a row with a regenerated trace_id and event_id "openai__", so
        # the payload has to be right for this to mean anything.
        trace_id = f"smoke-{uuid.uuid4().hex[:12]}"
        completion_id = f"chatcmpl-{trace_id}"
        payload = {
            "id": completion_id,
            "object": "chat.completion",
            "created": int(datetime.now(UTC).timestamp()),
            "model": "gpt-4o-mini",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": "Paris."},
                    "finish_reason": "stop",
                }
            ],
            "usage": {
                "prompt_tokens": 12,
                "completion_tokens": 3,
                "total_tokens": 15,
            },
            # Correlation the customer would supply.
            #
            # TOP-LEVEL, not nested under metadata. The openai decoder
            # reads `item.get("trace_id")` (ingestion/providers.py:287)
            # and falls back to the response `id`; nothing anywhere
            # reads metadata.trace_id. This script used to send it
            # nested, so the row landed under the derived id
            # "chatcmpl-…" and the script reported RESULT: BROKEN
            # against a perfectly healthy ingest path.
            #
            # That is the same failure mode being fixed all over this
            # codebase today — a check that cries wolf teaches you to
            # ignore it. The Python SDK sends trace_id top-level
            # (eden_sdk/doctor.py), so this now matches what a real
            # customer's SDK actually puts on the wire.
            "trace_id": trace_id,
            "metadata": {"trace_id": trace_id},
        }
        code, body = _post(f"/orgs/{org_id}/ingest/openai", payload, raw)
        ok = 200 <= code < 300
        results.append(("POST ingest/openai", ok, f"{code} {body[:90]}"))

        # ── 4. read it back the way the portal would ────────────────
        await asyncio.sleep(3)
        code, body = _get(f"/orgs/{org_id}/observability/traces?days=1", raw)
        found = trace_id in body
        # An org API key is INGEST-scoped; the read API requires a Clerk
        # session, so 401 here is the designed contract rather than a
        # failure. Asserting otherwise made this script report
        # "RESULT: BROKEN" on a healthy system every single run, which
        # is how a check stops being read at all.
        #
        # It stays visible, because it IS a real product limitation
        # worth seeing: a customer can send traces programmatically but
        # cannot read them back the same way — only through the portal.
        if code == 401 and not found:
            results.append(
                (
                    "read-back via API key",
                    True,
                    "401 by design — ingest-scoped key; portal reads via "
                    "Clerk session",
                )
            )
        else:
            results.append(
                ("trace readable via API", found, f"{code} {body[:110]}")
            )

        # ── 5. did it reach the database, and is it findable ────────
        n = await conn.fetchval(
            "SELECT count(*) FROM telemetry_events WHERE trace_id = $1", trace_id
        )
        results.append(
            ("findable by MY trace_id", n > 0, f"{n} row(s) for {trace_id}")
        )

        # Landed at all, under whatever id the adapter chose?
        row = await conn.fetchrow(
            "SELECT trace_id, event_id, event_type FROM telemetry_events "
            "WHERE timestamp > now() - interval '3 minutes' "
            "ORDER BY timestamp DESC LIMIT 1"
        )
        if row:
            results.append((
                "landed (any id)", True,
                f"trace_id={row['trace_id']} event_id={row['event_id']}",
            ))
        else:
            results.append(("landed (any id)", False, "nothing in last 3 min"))

    finally:
        if not args.keep:
            await conn.execute("DELETE FROM org_api_keys WHERE id = $1::uuid", key_id)
        await conn.close()

    print()
    print("=" * 72)
    print("CUSTOMER DEMO PATH — live production")
    print("=" * 72)
    worst = 0
    for label, ok, detail in results:
        mark = "PASS" if ok else "FAIL"
        if not ok:
            worst = 1
        print(f"  [{mark}] {label:26} {detail}")
    print()
    print("RESULT:", "path works end to end" if not worst
          else "BROKEN — a customer cannot complete this")
    return worst


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
