#!/usr/bin/env python3
"""20-line agent: wrap one tool. Compiled facts win; wrap down or miss runs original."""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "packages" / "sdk-py"))

from eden import EdenClient
from eden.wrap import wrap_tools


def lookup_ticket(_name: str, args: dict) -> dict:
    return {"id": args.get("id"), "original": True}


tools = wrap_tools({"lookupTicket": lookup_ticket}, EdenClient())
print(json.dumps(tools["lookupTicket"]("lookupTicket", {"id": "T-100"})))
