"""Phase 3 local end-to-end proof: SDK ingest -> Postgres -> query API.

Usage (with the local API running on :8000 against local Postgres):

    PYTHONPATH=sdk/python uv run python scripts/e2e_local_trace_proof.py

Prints the trace_id and the query-API verification result.
"""

from __future__ import annotations

import os
import sys
import time

ORG_ID = os.environ["E2E_ORG_ID"]
API_KEY = os.environ["E2E_API_KEY"]
BASE_URL = os.environ.get("E2E_BASE_URL", "http://localhost:8000")

import eden  # noqa: E402

eden.configure(
    org_id=ORG_ID,
    api_key=API_KEY,
    base_url=BASE_URL,
    project_id="e2e-local-proof",
)

MARKER = f"e2e-local-proof-{int(time.time())}"

with eden.trace("e2e-pipeline", attributes={"marker": MARKER}) as root:
    root.set_input({"question": "What is Eden?", "marker": MARKER})
    with eden.trace("llm-call") as child:
        child.set_input({"model": "e2e-stub-model", "prompt": MARKER})
        child.set_output({"completion": "Eden is an LLM observability platform.", "marker": MARKER})
        child.set_tag("provider", "e2e-stub")
    root.set_output({"answer": "Eden is an LLM observability platform.", "marker": MARKER})

trace_id = root.trace_id
eden.get_default_client().flush()
print(f"TRACE_ID={trace_id}")
print(f"MARKER={MARKER}")
