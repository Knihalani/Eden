"""The sidecar guard is held forever, so its renewal rate is a bill.

The guard is acquired once at startup and released at shutdown. Nothing
contends it, but the renewal task runs for the life of the process and
every renewal is a Lua ``EVAL`` — one Upstash command. At the original
TTL=60s / renew=20s that is 4,320 commands/day against a 10,000/day free
tier, spent on a lock with no contention.
"""

from __future__ import annotations

from eden.workers import sidecars

_UPSTASH_FREE_DAILY_COMMANDS = 10_000
_SECONDS_PER_DAY = 86_400.0


def test_guard_renewal_stays_a_small_slice_of_the_daily_budget():
    ttl, renew = sidecars._guard_ttl_and_renew()
    commands_per_day = _SECONDS_PER_DAY / renew
    share = commands_per_day / _UPSTASH_FREE_DAILY_COMMANDS
    assert share < 0.10, (
        f"an uncontended guard would burn {commands_per_day:.0f} Redis "
        f"commands/day ({share:.0%} of the free tier)"
    )


def test_renew_interval_is_safely_below_the_ttl():
    """A slow tick must not be able to drop a held guard."""
    ttl, renew = sidecars._guard_ttl_and_renew()
    assert renew < ttl / 2, (
        "renew must be under TTL/2 so one missed/slow renewal cannot "
        "let the guard lapse and allow a second process to double-consume"
    )


def test_renew_is_clamped_even_when_misconfigured():
    """A bad setting must not produce a guard that outlives its renewal."""

    class _BadSettings:
        sidecar_guard_ttl_seconds = 100
        sidecar_guard_renew_seconds = 5000.0  # absurdly larger than the TTL

    import eden.config as config_module

    original = config_module.get_settings
    config_module.get_settings = lambda: _BadSettings()  # type: ignore[assignment]
    try:
        ttl, renew = sidecars._guard_ttl_and_renew()
    finally:
        config_module.get_settings = original  # type: ignore[assignment]

    assert ttl == 100
    assert renew <= ttl / 2


def test_settings_drive_the_guard_values():
    class _Settings:
        sidecar_guard_ttl_seconds = 1200
        sidecar_guard_renew_seconds = 300.0

    import eden.config as config_module

    original = config_module.get_settings
    config_module.get_settings = lambda: _Settings()  # type: ignore[assignment]
    try:
        ttl, renew = sidecars._guard_ttl_and_renew()
    finally:
        config_module.get_settings = original  # type: ignore[assignment]

    assert (ttl, renew) == (1200, 300.0)
