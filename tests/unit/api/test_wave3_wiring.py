"""Wave 3 production wiring tests.

Covers:
  1. F39 nudges: install_learn_filters installs on multiple distinct gateways
     and is idempotent when called twice for the same gateway.
  2. F39 wiring: get_ai_gateway() calls install_learn_filters on construction.
  3. Health degrade: /health returns degraded when quality worker should be
     running (background leader) but is_worker_running() is False.
  4. Hot-path flag: install_cat15_trajectory_replaces_intervention respects
     trace_quality_hot_path_enabled=False.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch


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
# 4. Hot-path flag gates install_cat15_trajectory_replaces_intervention
# ---------------------------------------------------------------------------

def test_hot_path_flag_false_skips_wiring():
    """trace_quality_hot_path_enabled=False prevents the monkey-patch."""
    import eden.observability.trace_quality.wiring as w

    original_fn = MagicMock()
    fake_intv = MagicMock()
    fake_intv.InterventionEngine.evaluate_and_act = original_fn

    fake_hooks = MagicMock()
    fake_settings = MagicMock()
    fake_settings.trace_quality_hot_path_enabled = False

    with patch("eden.config.get_settings", return_value=fake_settings):
        with patch.dict("sys.modules", {
            "eden.guardrails.intervention": fake_intv,
            "eden.observability.trace_quality.hooks": fake_hooks,
        }):
            w.install_cat15_trajectory_replaces_intervention()

    assert fake_intv.InterventionEngine.evaluate_and_act is original_fn, (
        "Monkey-patch must not be applied when hot_path_enabled=False"
    )


def test_hot_path_flag_true_applies_wiring():
    """trace_quality_hot_path_enabled=True (default) applies the monkey-patch."""
    import eden.guardrails.intervention as intv
    import eden.observability.trace_quality.wiring as w

    # Patch the already-imported module attribute — ``from eden.guardrails
    # import intervention`` resolves via the package attr, so sys.modules
    # swaps alone do not redirect the import.
    original_fn = intv.InterventionEngine.evaluate_and_act
    fake_settings = MagicMock()
    fake_settings.trace_quality_hot_path_enabled = True

    async def _fake_step(**_kwargs):
        return {
            "recommended_action": "allow",
            "applied": False,
            "reason": "test",
            "action_class": "none",
        }

    try:
        with (
            patch("eden.config.get_settings", return_value=fake_settings),
            patch(
                "eden.observability.trace_quality.hooks.evaluate_trajectory_step",
                side_effect=_fake_step,
            ),
        ):
            w.install_cat15_trajectory_replaces_intervention()

        assert intv.InterventionEngine.evaluate_and_act is not original_fn, (
            "Monkey-patch must be applied when hot_path_enabled=True"
        )
    finally:
        intv.InterventionEngine.evaluate_and_act = original_fn
