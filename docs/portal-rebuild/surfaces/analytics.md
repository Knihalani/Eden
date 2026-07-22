# Surface: Analytics

> **Status:** Live — secondary (not core leaf)  
> **Phase:** Later (post P7)  
> **Decision date:** 2026-07-22  
> **Companions:** [../02-information-architecture.md](../02-information-architecture.md) §1.2 · [../01-product-bible.md](../01-product-bible.md)

---

## 1. Purpose

Product analytics hub: overview KPIs + charts, insights, topics, tools, users. Manager/usage lens — not Observe triage.

**Not** a 13th core sidebar leaf. Reachable via Cmd+K and Mobile More. Settings `tab=analytics` remains prefs only.

---

## 2. URL + route grammar

Canonical: `/analytics?tab=<overview|insights|topics|tools|users>`

| Old | New |
|-----|-----|
| `/users` | `/analytics?tab=users` |
| `/tools` | `/analytics?tab=tools` |
| `/insights` | `/analytics?tab=insights` |
| `/insights/topics` | `/analytics?tab=topics` |

---

## 3. Layout

- Band 1: PageHeader + range (overview) or refresh
- Band 2: underline tabs
- Overview: quiet KPI strip (tokens, p95, p99, requests) + charts
- Other tabs: thin panels (not embeds of other hubs)

Honest empty: “No analytics yet” until traces exist — not a fake load failure.

---

## 4. Acceptance checklist

- [x] Live `/analytics` (not soft-landed)
- [x] Tabs overview \| insights \| topics \| tools \| users
- [x] Alias redirects from `/users`, `/tools`, `/insights`
- [x] Not a core sidebar leaf
- [x] Cmd+K + Mobile More entry points
- [x] Kit shell; no EmbeddedSurface / red-team
- [x] en+de `analytics` + `nav.leaves.analytics`
- [x] Settings analytics tab remains prefs-only (separate)

---

*End of surfaces/analytics.md*
