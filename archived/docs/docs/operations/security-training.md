# Security Training Schedule

> **Owner:** Security · **Cadence:** quarterly · **Closes:** §9.1.6 of
> the roadmap.

Every engineer completes four training sessions per year. The
sessions are 60-90 min each, run by the Security Engineer, and
tracked in the HRIS training module.

## Annual schedule

| Quarter | Topic | Why | Format |
|---------|-------|-----|--------|
| Q1 | **OWASP Top 10 (2021 edition, refreshed if new edition ships)** | Baseline for every web-facing service. Covers broken access control, cryptographic failures, injection, insecure design, security misconfiguration, vulnerable & outdated components, identification & authentication failures, software & data integrity failures, security logging & monitoring failures, SSRF. | Lecture + hands-on lab exploiting a known-bad test app. |
| Q2 | **Secure code review** | We have 1k+ PRs a month. Reviewers need a shared vocabulary. | Walkthrough of 3 real CVEs from the past 90 days in OSS projects, applied to Eden's codebase. |
| Q3 | **Threat modeling for AI systems** | Eden is AI-native. The threat model is different (prompt injection, model exfil, KB poisoning). | STRIDE on the AI gateway + a sample data-flow diagram of an Eden job. |
| Q4 | **Incident response tabletop** | So on-call knows what to do when the page fires. | 90-min simulated incident (e.g., KB poisoning detected). Run the IR runbook. |

## Tracking

- Attendance is logged in the HRIS training module.
- New hires complete all four within their first 90 days (shorter
  condensed versions).
- Missed sessions are made up via recording + a 1:1 with the
  Security Engineer.

## Records retention

Training records are kept for 7 years per SOC 2 CC1.4 (training
records are part of the audit-trail evidence set).
