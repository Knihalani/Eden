"""Smoke test that the top-level `eden` namespace exposes the public API.

The SDK ships two import paths (``eden`` and ``eden_sdk``) so that
PyPI's distribution name (``eden-sdk``) doesn't collide with the
short import path users actually type (``import eden``). The
top-level module must re-export every public name so the README's
``eden.configure(...)``, ``eden.openai_client(...)``,
``eden.ModelAdvisor()``, ``eden.FilterConfig(...)`` etc. all work
without an extra ``from eden_sdk import ...``.

These tests are intentionally minimal: they just confirm each
public name is callable / constructible from the ``eden`` namespace
and refers to the same object as the canonical ``eden_sdk`` import.
"""

from __future__ import annotations

import pytest

import eden  # noqa: F401  — module-level so all tests below can reach the public namespace


def test_eden_re_exports_core_tracing_api() -> None:
    import eden
    import eden_sdk

    # Core tracing surface.
    assert eden.trace is eden_sdk.trace
    assert eden.trace_agent is eden_sdk.trace_agent
    assert eden.current_span is eden_sdk.current_span
    assert eden.current_trace is eden_sdk.current_trace
    assert eden.Span is eden_sdk.Span
    assert eden.TraceContext is eden_sdk.TraceContext


def test_eden_re_exports_configuration_api() -> None:
    import eden
    import eden_sdk

    assert eden.configure is eden_sdk.configure
    assert eden.get_config is eden_sdk.get_config
    assert eden.reset_config is eden_sdk.reset_config
    assert eden.EdenConfig is eden_sdk.EdenConfig
    assert eden.EdenClient is eden_sdk.EdenClient
    assert eden.get_default_client is eden_sdk.get_default_client


def test_eden_re_exports_instrumentation_api() -> None:
    import eden
    import eden_sdk

    assert eden.instrument is eden_sdk.instrument
    assert eden.uninstrument is eden_sdk.uninstrument


def test_eden_re_exports_filter_config_api() -> None:
    import eden  # noqa: I001  - intentional inline import order
    from eden_sdk.filters import FilterConfig as _FC, PIIConfig as _PC  # noqa: I001

    # Same class object.
    assert eden.FilterConfig is _FC
    assert eden.PIIConfig is _PC
    # Constructible.
    pii = eden.PIIConfig(mode="redact")
    fc = eden.FilterConfig(pii=pii)
    assert fc.pii is pii


def test_eden_re_exports_gateway_helpers() -> None:
    import eden
    from eden_sdk.gateway_session import chat_completion, openai_client

    assert eden.openai_client is openai_client
    assert eden.chat_completion is chat_completion


def test_eden_re_exports_model_advisor_api() -> None:
    import eden
    from eden_sdk.model_advisor import (
        ModelAdvisor,
        ModelAdvisorError,
        ModelComparison,
        ModelSpec,
        Recommendation,
        RunnerUp,
        SwitchProjection,
    )

    assert eden.ModelAdvisor is ModelAdvisor
    assert eden.ModelAdvisorError is ModelAdvisorError
    assert eden.ModelComparison is ModelComparison
    assert eden.ModelSpec is ModelSpec
    assert eden.Recommendation is Recommendation
    assert eden.RunnerUp is RunnerUp
    assert eden.SwitchProjection is SwitchProjection


def test_eden_all_matches_public_api() -> None:
    import eden

    declared = set(eden.__all__)
    # `__version__` is a dunder — let it through the start-with-underscore filter.
    # `annotations` is a __future__ import side-effect; not a real public name.
    actual = {
        n for n in dir(eden)
        if (not n.startswith("_") or n == "__version__") and n != "annotations"
    }
    missing = declared - actual
    extra = actual - declared
    assert not missing, f"__all__ names not actually exported: {missing}"
    assert not extra, f"exported names not in __all__: {extra}"


def test_eden_lazy_no_required_imports() -> None:
    """Importing eden must NOT pull in heavy optional deps.

    The runtime dep list is just ``httpx``; importing any of the
    framework SDKs (openai/anthropic/langchain/...) must be deferred
    to the actual instrumentation call. This guards against accidental
    top-level imports creeping into ``eden.__init__``.
    """
    import sys

    # Clear any prior imports.
    for k in list(sys.modules):
        if k.startswith(("openai", "anthropic", "langchain", "llama_index",
                         "crewai", "pyautogen", "pydantic")):
            sys.modules.pop(k, None)

    import eden  # noqa: F401

    banned = [k for k in sys.modules if k.startswith(
        ("openai", "anthropic", "langchain", "llama_index",
         "crewai", "pyautogen", "pydantic")
    )]
    assert not banned, f"eden.__init__ transitively imports: {banned}"


def test_eden_exposes_auto_instrument_helpers() -> None:
    import eden
    import eden_sdk

    # Both names must be exposed at the top level.
    assert hasattr(eden, "autoInstrument")
    assert hasattr(eden, "detect_installed_frameworks")
    # They should refer to the same callable (alias).
    assert eden.autoInstrument is eden.detect_installed_frameworks
    # Same object in the canonical eden_sdk namespace.
    assert eden.autoInstrument is eden_sdk.detect_installed_frameworks
    assert eden.autoInstrument is eden_sdk.autoInstrument


def test_detect_installed_frameworks_returns_full_map() -> None:
    import eden

    result = eden.detect_installed_frameworks()
    # Every supported key must be present (no partial dicts).
    expected = {
        "openai",
        "anthropic",
        "langchain",
        "llama_index",
        "crewai",
        "autogen",
        "mastra",
        "pydantic_ai",
    }
    assert set(result.keys()) == expected
    # All values must be booleans.
    assert all(isinstance(v, bool) for v in result.values())


def test_eden_instrument_no_eager_imports_of_all_frameworks() -> None:
    """``import eden`` must NOT pull in any framework dep.

    The previous design eagerly imported ``anthropic``, ``autogen``,
    ``crewai``, ``langchain``, ``llama_index``, ``mastra``, ``openai``
    from ``eden_sdk.instrumentations.__init__`` — meaning a fresh
    ``import eden`` paid ~960 ms even when the user only wanted to
    instrument one of them.

    After PEP 562 lazy loading, ``eden_sdk.instrumentations.openai`` is
    only imported when the user explicitly calls
    ``eden.instrument("openai")`` (or does
    ``from eden_sdk.instrumentations import openai``). A bare
    ``import eden`` does NOT touch any framework dep.

    This test is the lock-in — if anyone re-introduces an eager
    ``from . import openai`` (etc.) in ``instrumentations/__init__.py``,
    this test fails with the list of unexpectedly-imported modules.
    """
    import sys

    # Wipe any prior imports so the test starts from a clean slate.
    for k in list(sys.modules):
        if k.startswith(("openai", "anthropic", "langchain", "llama_index",
                         "crewai", "pyautogen", "mastra")):
            sys.modules.pop(k, None)
        # And remove the cached lazy-loaded submodules from the parent.
        if k.startswith("eden_sdk.instrumentations."):
            sys.modules.pop(k, None)

    # Clear the parent module's globals too so the lazy __getattr__ runs
    # afresh.
    import eden_sdk.instrumentations as inst_pkg
    for n in list(vars(inst_pkg)):
        if n in inst_pkg.__all__:
            delattr(inst_pkg, n)

    # Now do the bare import — must NOT trigger framework imports.
    import eden  # noqa: F401

    leaked = [
        name for name in sys.modules
        if name == "openai"
        or name.startswith("openai.")
        or name == "anthropic"
        or name.startswith("anthropic.")
        or name.startswith("langchain")
        or name.startswith("llama_index")
        or name.startswith("crewai")
        or name.startswith("pyautogen")
        or name == "mastra"
    ]
    # We allow `eden_sdk.instrumentations.openai` etc. as *modules* in
    # sys.modules only AFTER the user calls `eden.instrument("openai")` —
    # not after `import eden`. So if any of these slipped through,
    # something eagerly re-introduced the import.
    leaked_real = [
        n for n in leaked
        if not n.startswith("eden_sdk.instrumentations.")
    ]
    assert not leaked_real, (
        f"import eden transitively imported framework modules: {leaked_real}"
    )


def test_eden_instrument_specific_framework_does_not_trigger_others() -> None:
    """``eden.instrument("openai")`` must NOT pull in langchain / llama_index.

    Locks in the contract that single-framework instrumentation stays
    fast (~milliseconds, not seconds). If anyone breaks the lazy
    loading this test fails.
    """
    import importlib.util
    import sys

    if importlib.util.find_spec("openai") is None:
        pytest.skip("openai not installed in this environment")
    # Start clean.
    for k in list(sys.modules):
        if k.startswith(("openai", "anthropic", "langchain", "llama_index",
                         "crewai", "pyautogen", "mastra")):
            sys.modules.pop(k, None)

    # Wipe cached lazy submodules.
    import eden_sdk.instrumentations as inst_pkg
    for n in list(vars(inst_pkg)):
        if n in inst_pkg.__all__:
            delattr(inst_pkg, n)

    # Reset the SDK's instrumentation registry too.
    from eden_sdk import INSTRUMENTED
    INSTRUMENTED.clear()

    # Now instrument just openai.
    eden.configure(org_id="o", api_key="k", dry_run=True)
    eden.instrument("openai")

    # openai is allowed; nothing else is.
    try:
        assert "openai" in sys.modules, "openai should be installed by instrument()"
        banned = [
            n for n in sys.modules
            if n.startswith(("langchain", "llama_index", "crewai", "pyautogen"))
            and not n.startswith("eden_sdk.instrumentations.")
        ]
        assert not banned, (
            f"eden.instrument('openai') transitively imported: {banned}"
        )
    finally:
        # This test calls ``eden.instrument("openai")`` which loads the
        # real openai package into sys.modules. Other tests in this
        # suite (e.g. test_instrumentations.py) install a *fake* openai
        # by overwriting sys.modules["openai"]; that only works if the
        # sub-modules aren't already cached. Pop everything openai-shaped
        # so the next test sees a clean slate.
        for k in list(sys.modules):
            if k == "openai" or k.startswith("openai."):
                sys.modules.pop(k, None)
        # Also revert the patch so subsequent ``eden.instrument("openai")``
        # calls re-capture from the (now fake) target module.
        try:
            eden.uninstrument("openai")
        except Exception:
            pass
        # Drop the captured lazy submodules so the next test starts clean.
        import eden_sdk.instrumentations as inst_pkg
        for n in list(vars(inst_pkg)):
            if n in inst_pkg.__all__:
                delattr(inst_pkg, n)


# ── Public token API re-exports ─────────────────────────────────


def test_extract_usage_top_level_import():
    """``extract_usage`` must be importable from both
    ``eden_sdk`` and ``eden`` so users have one obvious place
    to grab it from."""
    import eden
    from eden_sdk._tokens import extract_usage as e
    assert eden.extract_usage is e


def test_normalize_model_name_top_level_import():
    import eden
    from eden_sdk._tokens import normalize_model_name as n
    assert eden.normalize_model_name is n


def test_tokens_helpers_round_trip():
    """End-to-end: extract_usage + normalize_model_name
    together produce the field shape the server normalizer
    expects on every emitted event."""
    import eden
    usage = eden.extract_usage({
        "prompt_tokens": 100,
        "completion_tokens": 50,
        "prompt_tokens_details": {"cached_tokens": 25},
    })
    assert usage["input_tokens"] == 100
    assert usage["output_tokens"] == 50
    assert usage["cache_read_tokens"] == 25
    assert usage["cache_creation_tokens"] is None
    assert eden.normalize_model_name("gpt-4o-2024-08-06") == "gpt-4o"
