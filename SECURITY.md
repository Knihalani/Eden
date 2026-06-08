# Security Policy

## Reporting a vulnerability

We take all security reports seriously. **Please do not file a
public GitHub issue for security vulnerabilities.**

Instead, report privately by emailing **security@eden.com**
(placeholder — replace with the real address when the public
security page goes live). Reports are triaged within 1 business
day.

Include:

* A clear description of the vulnerability.
* Steps to reproduce (proof-of-concept preferred).
* The affected component / version.
* Your name / handle if you'd like to be credited in the fix
  release notes (optional).

We follow responsible disclosure:

* We'll acknowledge your report within 1 business day.
* We'll keep you informed of progress toward a fix.
* We'll credit you in the release notes when the fix ships
  (unless you ask to remain anonymous).
* We aim to issue a fix within 90 days of confirmation; for
  critical issues we aim for 7 days.

## Scope

The bug bounty scope (when the program launches — see
[`docs/security.md`](docs/security.md)) will cover:

* `src/eden/` — the backend
* `clients/portal/` — the Next.js portal
* `migrations/` — schema and seed data
* `docker/`, `helm/` — deployment configurations
* `*.eden.com` — production infrastructure (out of scope for
  this repo; reported via the security email above)

Out of scope:

* Third-party dependencies (report upstream).
* Social-engineering attacks against Eden staff.
* Denial-of-service attacks against Eden infrastructure.

## Supported versions

| Version | Supported |
|---------|-----------|
| latest  | ✅ Full support |
| < latest | ⚠️ Critical fixes only for 30 days after the next release |

## See also

* [`docs/security.md`](docs/security.md) — public security overview
  (controls, evidence, certifications).
* [`docs/runbooks/security-training.md`](docs/runbooks/security-training.md)
  — Q1–Q4 training schedule.
* [`docs/soc2-control-mapping.md`](docs/soc2-control-mapping.md) —
  SOC 2 control matrix with evidence locations.
