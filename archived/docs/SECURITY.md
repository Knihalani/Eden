# Security

## Reporting a vulnerability

If you have discovered a security vulnerability in Eden, please report it
to us privately. **Do not file a public issue.**

* **Email:** <security@edenobservability.com>
* **PGP key:** <https://edenobservability.com/.well-known/security.asc>
* **Response SLA:** within **90 days** of your report.

We follow [coordinated disclosure](https://en.wikipedia.org/wiki/Coordinated_vulnerability_disclosure):

1. You email us with a description of the vulnerability + reproduction steps.
2. We acknowledge within 3 business days.
3. We aim to ship a fix within 90 days.
4. After the fix ships, we publish a post-mortem with credit (unless you prefer to remain anonymous).

## Out of scope

The following are explicitly out of scope for the bounty:

* Denial-of-service attacks (rate limits are documented in `docs/runbooks/`).
* Issues that require an attacker to have already compromised an Eden customer's account.
* Theoretical vulnerabilities without a working proof-of-concept.
* Social engineering attacks against Eden staff.

## What we'll do

* Triage your report within 3 business days.
* Keep you updated on the fix progress.
* Credit you in the release notes (unless you prefer anonymity).
* Pay a bounty for high/critical vulnerabilities (details on request).

## What you should do

* Give us a reasonable amount of time (≤ 90 days) to fix the issue before disclosing.
* Make a good-faith effort to avoid privacy violations, data destruction, or service disruption.
* Do not exploit a vulnerability beyond what is necessary to demonstrate it.
