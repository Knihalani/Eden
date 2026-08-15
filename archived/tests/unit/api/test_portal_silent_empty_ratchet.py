"""Ratchet on portal handlers that return [] when they actually failed.

`return []` on a dead database or a raising query makes "we are broken"
and "you have no data yet" the same screen. During onboarding that is
the worst possible failure mode, because the customer's rational
response is to go debug their own code.

Converted to 503 (must not regress):

    list_portal_traces / get_portal_trace
    list_portal_api_keys / list_portal_keys
    list_portal_agents
    list_portal_sessions
    list_portal_issues
    list_portal_signals
    list_portal_alert_rules / list_portal_alert_events
    list_portal_cost_drivers
    list_portal_members (client + members query)
    list_portal_audit_events / list_portal_audit_packs
    list_portal_datasets / playgrounds / experiments
    list_portal_improve_plans
    list_portal_debugger_sessions
    list_portal_assistant_threads

Remaining known soft-empties are partial composers (invites).
Shrinking this list is the only way the ratchet moves.
"""

from __future__ import annotations

import ast
from pathlib import Path

_REPO = Path(__file__).resolve().parents[3]
_PORTAL = _REPO / "src" / "eden" / "api" / "routes" / "portal.py"

#: (handler, kind) pairs that currently return [] on a failure path.
KNOWN_SILENT_EMPTY: set[tuple[str, str]] = {
    ("_fetch_invites", "except"),
    # BUG-6: best-effort alias-discovery side-channel for the /agents
    # dashboard reconciliation (agent_identity_aliases). A failure here
    # must not 503 the whole dashboard — it just means the ghost-card
    # merge stays unresolved until the next successful call. The
    # user-facing handler itself (list_portal_agents) is already
    # 503-converted and unaffected.
    ("_load_alias_pairs", "except"),
}

_CONVERTED = (
    "list_portal_traces",
    "get_portal_trace",
    "list_portal_api_keys",
    "list_portal_keys",
    "list_portal_agents",
    "list_portal_sessions",
    "list_portal_issues",
    "list_portal_signals",
    "list_portal_alert_rules",
    "list_portal_alert_events",
    "list_portal_cost_drivers",
    "list_portal_members",
    "list_portal_audit_events",
    "list_portal_audit_packs",
    "list_portal_datasets",
    "list_portal_playgrounds",
    "list_portal_experiments",
    "list_portal_improve_plans",
    "list_portal_debugger_sessions",
    "list_portal_assistant_threads",
)


def _walk_excluding_nested_fns(node: ast.AST):
    """Walk ``node`` but do not descend into nested function defs.

    Without this, a parent like ``list_portal_members`` inherits
    ``return []`` from nested ``_fetch_invites``, which is already
    tracked under its own name.
    """
    yield node
    for child in ast.iter_child_nodes(node):
        if isinstance(child, ast.FunctionDef | ast.AsyncFunctionDef):
            continue
        yield from _walk_excluding_nested_fns(child)


def _find_silent_empty() -> set[tuple[str, str]]:
    tree = ast.parse(_PORTAL.read_text())
    found: set[tuple[str, str]] = set()
    for fn in ast.walk(tree):
        if not isinstance(fn, ast.FunctionDef | ast.AsyncFunctionDef):
            continue
        for node in _walk_excluding_nested_fns(fn):
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
                for st in _walk_excluding_nested_fns(node):
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
        """Already-fixed handlers must not regress to silent empty."""
        found = _find_silent_empty()
        for handler in _CONVERTED:
            assert (handler, "no-client") not in found, (
                f"{handler} regressed to returning [] on a dead database"
            )
            assert (handler, "except") not in found, (
                f"{handler} regressed to returning [] on a failed query"
            )
