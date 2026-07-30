"""Ratchet on portal handlers that return [] when they actually failed.

`return []` on a dead database or a raising query makes "we are broken"
and "you have no data yet" the same screen. During onboarding that is
the worst possible failure mode, because the customer's rational
response is to go debug their own code.

Four handlers were converted to 503 on 2026-07-30 — the ones where an
empty list actively misleads and where the portal demonstrably renders
an error state:

    list_portal_traces      (list + detail)
    list_user_orgs          (routes/orgs.py)
    list_portal_api_keys

The rest are recorded below rather than converted, deliberately. Two
reasons, both real:

  * Three are helpers (`_load_registry`, `_fetch_members`,
    `_fetch_invites`) composed into a larger response, where [] is a
    legitimate partial rather than a lie.
  * The portal does not check `isError` on every page yet — the agents
    detail view renders an EmptyState regardless. Converting those to
    503 before the client handles it would turn a degraded-but-readable
    page into a hard error, which is a net loss.

So this is a RATCHET, not a pass/fail on the existing set: the known
sites are allowed, and any NEW one fails. It cannot be satisfied by
adding an entry — shrinking the list is the only way it moves.
"""

from __future__ import annotations

import ast
from pathlib import Path

_REPO = Path(__file__).resolve().parents[3]
_PORTAL = _REPO / "src" / "eden" / "api" / "routes" / "portal.py"

#: (handler, kind) pairs that currently return [] on a failure path.
#: Line numbers are deliberately excluded — they churn on every edit and
#: would make this a maintenance tax rather than a guard.
KNOWN_SILENT_EMPTY: set[tuple[str, str]] = {
    ("list_portal_agents", "no-client"),
    ("list_portal_agents", "except"),
    ("_load_registry", "except"),
    ("list_portal_sessions", "except"),
    ("list_portal_issues", "except"),
    ("list_portal_signals", "no-client"),
    ("list_portal_signals", "except"),
    ("list_portal_alert_rules", "except"),
    ("list_portal_alert_events", "except"),
    ("list_portal_cost_drivers", "except"),
    ("list_portal_members", "no-client"),
    ("list_portal_members", "except"),
    ("_fetch_members", "except"),
    ("_fetch_invites", "except"),
    ("list_portal_audit_events", "no-client"),
    ("list_portal_audit_events", "except"),
    ("list_portal_audit_packs", "except"),
    ("list_portal_datasets", "except"),
    ("list_portal_playgrounds", "except"),
    ("list_portal_experiments", "except"),
    ("list_portal_improve_plans", "except"),
    ("list_portal_debugger_sessions", "except"),
    ("list_portal_assistant_threads", "no-client"),
    ("list_portal_assistant_threads", "except"),
}


def _find_silent_empty() -> set[tuple[str, str]]:
    tree = ast.parse(_PORTAL.read_text())
    found: set[tuple[str, str]] = set()
    for fn in ast.walk(tree):
        if not isinstance(fn, ast.FunctionDef | ast.AsyncFunctionDef):
            continue
        for node in ast.walk(fn):
            if isinstance(node, ast.If):
                for st in node.body:
                    if (
                        isinstance(st, ast.Return)
                        and isinstance(st.value, ast.List)
                        and not st.value.elts
                    ):
                        test = ast.unparse(node.test)
                        if "None" in test and "client" in test:
                            found.add((fn.name, "no-client"))
            if isinstance(node, ast.ExceptHandler):
                for st in ast.walk(node):
                    if (
                        isinstance(st, ast.Return)
                        and isinstance(st.value, ast.List)
                        and not st.value.elts
                    ):
                        found.add((fn.name, "except"))
    return found


class TestSilentEmptyRatchet:
    def test_no_new_silent_empty_handlers(self):
        found = _find_silent_empty()
        new = found - KNOWN_SILENT_EMPTY
        assert not new, (
            "new portal handler(s) return [] on a failure path:\n  "
            + "\n  ".join(f"{fn} ({kind})" for fn, kind in sorted(new))
            + "\n\nAn empty list must mean 'you have no data', never 'the "
            "query failed'. Raise 503 with a Retry-After instead, and "
            "confirm the portal page renders an error state for it."
        )

    def test_ratchet_list_does_not_drift_upward(self):
        """Fixing one must shrink the list, not leave a stale entry."""
        found = _find_silent_empty()
        stale = KNOWN_SILENT_EMPTY - found
        assert not stale, (
            "these are recorded as silent-empty but no longer are — "
            f"remove them from KNOWN_SILENT_EMPTY: {sorted(stale)}"
        )

    def test_the_converted_handlers_stayed_converted(self):
        """The four already fixed must not regress."""
        found = _find_silent_empty()
        for handler in ("list_portal_traces", "list_portal_api_keys"):
            assert (handler, "no-client") not in found, (
                f"{handler} regressed to returning [] on a dead database"
            )
            assert (handler, "except") not in found, (
                f"{handler} regressed to returning [] on a failed query"
            )
