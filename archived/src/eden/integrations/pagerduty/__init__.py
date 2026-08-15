"""PagerDuty Events API v2 integration (FEAT-42).

* :mod:`eden.integrations.pagerduty.store` — per-org routing key config,
  same encrypted-credential-table pattern as ``eden.integrations.slack``.
* :mod:`eden.services.pagerduty_delivery` — the actual Events API v2
  sender, reusing ``eden.services.webhook_delivery``'s retry ladder.
"""
