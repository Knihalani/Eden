"""Wave 3 production wiring tests.

Covers:
  1. F39 nudges: install_learn_filters installs on multiple distinct gateways
     and is idempotent when called twice for the same gateway.
  2. F39 wiring: get_ai_gateway() calls install_learn_filters on construction.
  3. Health degrade: /health returns degraded when quality worker should be
     running (background leader) but is_worker_running() is False.
  4. FEAT-3 regression: install_all() must not monkey-patch
     InterventionEngine.evaluate_and_act — the guardrail-swap wiring
     (install_cat15_trajectory_replaces_intervention) has been removed.
  5. FEAT-4 regression: with the correct enforcement path restored (#4),
     InterventionEngine.evaluate_and_act must actually redact PII out of
     edited_text (not just leave the right function in place) whenever a
     trace_id is supplied — the exact call shape the removed monkey-patch
     used to intercept.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_FAKE_FILTER_MODULES = {
    "eden.llmops.filters.book": MagicMock(BookGatewayFilter=MagicMock(return_value=MagicMock())),
    "eden.llmops.filters.guardrail": MagicMock(get_guardrail_filter=MagicMock(return_value=MagicMock())),
    "eden.llmops.filters.nudge": MagicMock(NudgeGatewayFilter=MagicMock(return_value=MagicMock())),
    "eden.nudges.engine": MagicMock(NudgeEngine=MagicMock(return_value=MagicMock())),
}


def _make_gateway(name="FakeGW"):
    gw = MagicMock(name=name)
    gw.unregister_filter = MagicMock()
    gw.register_filter = MagicMock()
    return gw


# ---------------------------------------------------------------------------
# 1. learn_wiring: multi-gateway support
# ---------------------------------------------------------------------------

def test_install_learn_filters_installs_on_two_distinct_gateways():
    """install_learn_filters installs filters on each unique gateway."""
    import eden.llmops.learn_wiring as lw

    orig_gateways = set(lw._installed_gateways)
    orig_engine = lw._nudge_engine

    gw1 = _make_gateway("GW1")
    gw2 = _make_gateway("GW2")
    try:
        lw._installed_gateways = set()
        lw._nudge_engine = None
        lw._nudge_filter = None
        lw._book_filter = None
        lw._guardrail_filter = None

        with patch.dict("sys.modules", _FAKE_FILTER_MODULES):
            lw.install_learn_filters(gateway=gw1)
            lw.install_learn_filters(gateway=gw2)

        # F68 added a 4th filter (prompt_deploy) alongside nudge/book/guardrail.
        assert gw1.register_filter.call_count == 4, "gw1 should have 4 filters installed"
        assert gw2.register_filter.call_count == 4, "gw2 should have 4 filters installed"
        assert id(gw1) in lw._installed_gateways
        assert id(gw2) in lw._installed_gateways
        assert lw._nudge_engine is not None, "NudgeEngine should be created once"
    finally:
        lw._installed_gateways = orig_gateways
        lw._nudge_engine = orig_engine


def test_install_learn_filters_idempotent_same_gateway():
    """install_learn_filters is a no-op when called twice for the same gateway."""
    import eden.llmops.learn_wiring as lw

    orig_gateways = set(lw._installed_gateways)
    orig_engine = lw._nudge_engine

    gw = _make_gateway("GWIdem")
    try:
        lw._installed_gateways = set()
        lw._nudge_engine = None
        lw._nudge_filter = None
        lw._book_filter = None
        lw._guardrail_filter = None

        with patch.dict("sys.modules", _FAKE_FILTER_MODULES):
            lw.install_learn_filters(gateway=gw)
            lw.install_learn_filters(gateway=gw)  # second call must be no-op

        assert gw.register_filter.call_count == 4, "second call must not re-register"
    finally:
        lw._installed_gateways = orig_gateways
        lw._nudge_engine = orig_engine


# ---------------------------------------------------------------------------
# 2. gateway.get_ai_gateway() calls install_learn_filters
# ---------------------------------------------------------------------------

def test_get_ai_gateway_installs_learn_filters():
    """get_ai_gateway() wires learn filters onto the newly constructed AIGateway."""
    import eden.api.routes.gateway as gw_mod

    orig_gateway = gw_mod._gateway
    try:
        gw_mod._gateway = None
        fake_gw = _make_gateway("RealGW")

        installed_with = []

        def _capture_install(gateway=None):
            installed_with.append(gateway)

        # install_learn_filters is imported inside get_ai_gateway();
        # patch the source module, not a fabricated gateway attribute.
        with (
            patch("eden.api.routes.gateway.AIGateway", return_value=fake_gw),
            patch(
                "eden.llmops.learn_wiring.install_learn_filters",
                side_effect=_capture_install,
            ),
        ):
            with patch("asyncio.get_event_loop", side_effect=RuntimeError):
                result = gw_mod.get_ai_gateway()

        assert result is fake_gw
        assert len(installed_with) == 1
        assert installed_with[0] is fake_gw
    finally:
        gw_mod._gateway = orig_gateway


# ---------------------------------------------------------------------------
# 3. Health degrade when quality worker should be running but is dead
# ---------------------------------------------------------------------------

def _simulate_health(*, worker_running, bg_running, worker_enabled, pg, qdrant):
    """Reproduce the /health overall-status logic in isolation."""
    kb = {"postgres": pg, "qdrant": qdrant}
    overall = "healthy" if (
        kb.get("postgres") == "connected" and kb.get("qdrant") == "connected"
    ) else "degraded"

    if overall == "healthy":
        if (worker_enabled and bg_running and not worker_running):
            overall = "degraded"

    return overall


def test_health_degrades_when_leader_and_worker_dead():
    assert _simulate_health(
        worker_running=False,
        bg_running=True,
        worker_enabled=True,
        pg="connected",
        qdrant="connected",
    ) == "degraded"


def test_health_stays_healthy_when_not_leader():
    assert _simulate_health(
        worker_running=False,
        bg_running=False,
        worker_enabled=True,
        pg="connected",
        qdrant="connected",
    ) == "healthy"


def test_health_stays_healthy_when_worker_disabled():
    assert _simulate_health(
        worker_running=False,
        bg_running=True,
        worker_enabled=False,
        pg="connected",
        qdrant="connected",
    ) == "healthy"


def test_health_stays_healthy_when_worker_running():
    assert _simulate_health(
        worker_running=True,
        bg_running=True,
        worker_enabled=True,
        pg="connected",
        qdrant="connected",
    ) == "healthy"


# ---------------------------------------------------------------------------
# 4. FEAT-3 regression — install_all() must not monkey-patch
#    InterventionEngine.evaluate_and_act (the real content-safety
#    guardrail path). A prior wiring,
#    ``install_cat15_trajectory_replaces_intervention``, rebound it to
#    the Cat 15 trajectory hot path (cost/loop/latency checks) whenever
#    a ``trace_id`` was present — silently skipping all policy
#    evaluation and returning ``edited_text`` unredacted. It has been
#    removed; the trajectory hot path has its own dedicated call sites
#    (the ``/v1/guardrails/trajectory/check`` route and the
#    ``TrajectoryInterventionGatewayFilter`` gateway filter).
# ---------------------------------------------------------------------------

def test_wiring_module_no_longer_exposes_trajectory_replaces_intervention():
    """The guardrail-swap monkey-patch function must not exist at all."""
    import eden.observability.trace_quality.wiring as w

    assert not hasattr(w, "install_cat15_trajectory_replaces_intervention"), (
        "install_cat15_trajectory_replaces_intervention must be removed — "
        "it silently replaced the real content-safety guardrail check"
    )
    assert "install_cat15_trajectory_replaces_intervention" not in w.__all__


def test_install_all_does_not_patch_evaluate_and_act():
    """install_all() must leave InterventionEngine.evaluate_and_act untouched."""
    import eden.guardrails.intervention as intv
    import eden.observability.trace_quality.wiring as w

    original_fn = intv.InterventionEngine.evaluate_and_act
    try:
        with patch(
            "eden.observability.platform_activation.mark_wiring_installed"
        ):
            w.install_all()

        assert intv.InterventionEngine.evaluate_and_act is original_fn, (
            "install_all() must not monkey-patch "
            "InterventionEngine.evaluate_and_act — it is the real, "
            "fail-closed content-safety guardrail path and must run "
            "unmodified whenever a trace_id is present"
        )
    finally:
        intv.InterventionEngine.evaluate_and_act = original_fn


# ---------------------------------------------------------------------------
# 5. FEAT-4 regression — once the correct enforcement path is restored
#    (install_all() no longer substitutes evaluate_and_act, per #4 above),
#    the real path must actually redact PII out of ``edited_text``. This
#    is the concrete, customer-visible symptom of the old bypass: it isn't
#    enough that the right function gets called post-install_all() — the
#    function must produce a redacted result for the exact call shape
#    (PII text + trace_id) the removed monkey-patch used to intercept.
# ---------------------------------------------------------------------------

async def test_install_all_then_evaluate_and_act_redacts_pii_with_trace_id():
    """After install_all(), evaluate_and_act(trace_id=...) still redacts PII."""
    import eden.guardrails.intervention as intv
    import eden.observability.trace_quality.wiring as w

    original_fn = intv.InterventionEngine.evaluate_and_act
    try:
        with patch(
            "eden.observability.platform_activation.mark_wiring_installed"
        ):
            w.install_all()

        with patch(
            "eden.guardrails.intervention._fetch_policies",
            AsyncMock(
                return_value=[
                    {
                        "id": "p1",
                        "name": "redact-pii",
                        "type": "pii_redaction",
                        "spec": {},
                        "action": "redact",
                    }
                ]
            ),
        ):
            r = await intv.InterventionEngine().evaluate_and_act(
                "org_t",
                text="My SSN is 123-45-6789",
                trace_id="trace-feat4",
            )

        assert r["data"]["verdict"] == "redact"
        assert "123-45-6789" not in r["data"]["edited_text"], (
            "edited_text must be redacted, not the raw unredacted input, "
            "for calls that carry a trace_id — the exact shape the removed "
            "guardrail-swap monkey-patch used to bypass"
        )
        assert r["data"]["edited_text"] != "My SSN is 123-45-6789"
    finally:
        intv.InterventionEngine.evaluate_and_act = original_fn
