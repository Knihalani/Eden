# Surface: Audit

> **Status:** Spec — must-ship  
> **Phase:** P7  
> **Decision date:** 2026-07-21  
> **Companions:** [../02-information-architecture.md](../02-information-architecture.md) · [../01-product-bible.md](../01-product-bible.md) J14 · [../design/DESIGN-SYSTEM-V2.md](../design/DESIGN-SYSTEM-V2.md)  
> **Feel:** Quiet, dense, trustworthy — compliance instrument, not marketing dashboard.

---

## 1. Purpose

**One decision this surface owns:** Inspect the org audit trail and export an **AuditPack** for a time range (and optional Agent) that Jordan (or Mira) can hand to compliance without re-running math elsewhere.

Not owned here: live Trace debugging, Improve queue, or Settings policy editing (link out).

---

## 2. Primary user + JTBD

| Field | Value |
|-------|-------|
| **Primary** | Jordan — EM / platform; audit readiness |
| **Secondary** | Mira — prove what changed after an incident |
| **JTBD** | J14 — Export AuditPack |
| **Done when** | Pack generated for range/agent; downloadable; events list shareable via URL filters |

Voice: dry, precise. No exclamation CTAs. No “self-healing compliance” copy.

---

## 3. URL + query grammar

| Route | Purpose |
|-------|---------|
| `/audit` | Audit hub |

| Param | Values / type | Meaning |
|-------|---------------|---------|
| `tab` | `events` \| `packs` | Hub lens |
| `packId` | id | Selected AuditPack (packs tab / detail) |
| `agentId` | id | Scope |
| `q` | string | Search events |
| `pastHours` / `from` / `to` | time | Range |
| `actorId` | id | Who |
| `action` | enum string | Action filter |
| `filter` | string | Structured filter if needed |

Redirects: `/audit-trail`, `/audit-trail/:path*` → `/audit`.

Examples:

```
/audit
/audit?tab=events&pastHours=168
/audit?tab=packs
/audit?tab=packs&packId=ap_01&agentId=agent_support
```

Breadcrumb: `Workspace / Audit`.

---

## 4. Layout diagrams

### 4.1 Desktop ≥1280 — Events

```
Band 1: Workspace / Audit
Band 2: Tabs Events | Packs · Time · Agent · Search · Overflow
────────────────────────────────────────────────────────────
Dense DataTable (Braintrust energy, quieter):
  time · actor · action · object · agent · result
Row → DetailPanelShell / right inspector (KV + raw payload mono)
No KPI card collage
```

### 4.2 Desktop — Packs

```
List of AuditPacks: created · range · agent scope · status · export
Primary CTA: Generate pack
Detail: manifest, checksum/chain note if available, download buttons
```

### 4.3 Tablet / mobile

Single column; detail in Sheet; Generate in Dialog; tables horizontal scroll or priority columns.

---

## 5. Chrome budget

| Band | Contents |
|------|----------|
| **1** | Breadcrumb + title |
| **2** | Tabs + ≤5: **Generate pack** · **Time** · **Filter** · **Search** · **Overflow** (Export CSV of events if shipped, Refresh) |

One solid CTA: **Generate pack** (on packs tab or overview action). Events tab primary may be **Export view** (secondary if Generate lives on packs).

---

## 6. AuditPack contract

| Field | Requirement |
|-------|-------------|
| Identity | `auditPackId` mono + copy |
| Scope | Org required; Agent optional; time range required |
| Contents | Manifest of included event classes / object refs — honest about what’s in/out |
| Integrity | Show chain/checksum if backend provides; never fake “verified” |
| Export | Download artifact (zip/json) — success toast only after real completion |
| Permissions | Per bible — Viewer if policy allows; else Member/Admin |

Generation is async-capable: status `queued` → `ready` → `failed` with Retry.

---

## 7. States

| State | Behavior |
|-------|----------|
| **Empty** | No events in range — explain retention; CTA adjust range / Settings retention (link) |
| **First-run** | Short trust copy: what is logged; CTA Generate pack or widen range |
| **Loading** | QueryState |
| **Error** | Retry + support |
| **Filtered-empty** | Clear filters — distinct from empty |
| **Populated** | Dense table / pack list |
| **Live** | Optional quiet refresh; no LIVE chrome as first-paint primary |

---

## 8. Components (kit only)

`PageHeader`, underline `Tabs`, `DataTable`, `DetailPanelShell`, `Panel`, `Button`, `Dialog`/`Sheet` (generate form), `QueryState`, `Badge`/`StatusBadge` (pack status), `CodeChip` (ids/checksums), MetricInline sparingly (event counts — not Helicone card grid).

---

## 9. Keyboard map

| Key | Action |
|-----|--------|
| `Esc` | Close detail sheet; clear `packId` selection if drawer |
| `⌘K` | Audit / Generate pack |
| `⌘↵` | Confirm Generate when dialog focused |
| `/` | Focus search |

---

## 10. Closed-loop exits

| From | To |
|------|----|
| Event object ref | Canonical Trace / Issue / Agent / Settings deep link |
| Pack detail | Download only — or open related Agent |
| Retention questions | `/settings?tab=retention` |
| PII questions | `/settings?tab=pii` |

No exit into red-team. No fake Improve Plan from audit noise.

---

## 11. Permissions

| Capability | Viewer | Member | Admin |
|------------|--------|--------|-------|
| View events | ✓ | ✓ | ✓ |
| Export AuditPack | if policy | ✓ | ✓ |
| Delete packs | | | ✓ |

---

## 12. Anti-patterns banned

- Loud marketing banners / purple trust theater  
- KPI card spam  
- Fake “cryptographically verified” without backend  
- False success toast before pack ready  
- Second sidebar  
- Cluttered multi-banner chrome  
- 9–10px labels; decorative shadows  
- Mixing Audit product with Settings-level `tab=analytics` prefs  

---

## 13. Acceptance checklist

- [x] `/audit` canonical; `/audit-trail` redirects
- [x] Tabs `events` \| `packs`
- [x] Generate AuditPack with org + time (+ optional agent)
- [x] Dense quiet table; master–detail or sheet inspector
- [x] Honest integrity/status; no fake verified
- [x] Chrome ≤2 bands; ≤5 actions; one primary CTA
- [x] QueryState states; en+de; kit only
- [x] Cross-links to Settings retention/PII
- [x] Feels trustworthy under visual QA (DS §15)

---

*End of surfaces/audit.md*
