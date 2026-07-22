# Surface: Settings

> **Status:** Spec — must-ship  
> **Phase:** P7  
> **Decision date:** 2026-07-21  
> **Companions:** [../02-information-architecture.md](../02-information-architecture.md) §2.3 · [../01-product-bible.md](../01-product-bible.md) J1/J15 · [../design/DESIGN-SYSTEM-V2.md](../design/DESIGN-SYSTEM-V2.md) §7.4  
> **Grammar:** Linear/Vercel-style workspace settings — progressive disclosure; **no second ~240px Settings sidebar**.

---

## 1. Purpose

**One decision this surface owns:** Administer the workspace (identity, gateway/keys, members, billing, security/compliance prefs) so Mira can **connect tonight** and Jordan can run the org — without a hub-of-hubs.

Not owned here: product Analytics hub (Later), Prompts registry (Later), red-team, or Observe triage.

---

## 2. Primary user + JTBD

| Field | Value |
|-------|-------|
| **Primary (day-0)** | Mira — J1 connect agent (keys + gateway) |
| **Primary (ongoing)** | Admin / Jordan — J15 administer workspace |
| **Member** | Own account tab; limited keys if granted |
| **Done when** | Fail→act ≤2 clicks to API keys / members / billing from overview; gateway instructions copyable |

---

## 3. URL + query grammar

Canonical: `/settings?tab=<id>`

Path-style `/settings/<tab>` **redirects** to query form.

### 3.1 Visible daily tabs (≤8)

First paint shows **at most 8** category controls (pills or underline). Order:

| # | `tab` | Purpose |
|---|-------|---------|
| 1 | `overview` | Workspace pulse / recovery — identity, plan chip, health, **one** accent CTA |
| 2 | `account` | Personal account (ex-`/profile`) |
| 3 | `org` | Org profile |
| 4 | `members` | Members / invites |
| 5 | `api-keys` | Org API keys |
| 6 | `gateway` | Gateway configuration & instructions |
| 7 | `billing` | Billing |
| 8 | `security` | Security + alert channels (bundled) |

### 3.2 Advanced (collapsed) — progressive disclosure

Not on first paint. Reach via **Advanced** disclosure, Cmd+K, or deep link `?tab=`.

| `tab` | Purpose |
|-------|---------|
| `finops` | Finops kills / related |
| `pii` | PII policies |
| `retention` | Retention |
| `exports` | Exports |
| `webhooks-dlq` | Webhook DLQ |
| `mcp` | MCP |
| `scim` | SCIM |
| `status` | Status |
| `autonomous` | Autonomous improve toggles (if retained) |
| `sidebar` | Nav prefs (defaults = FINAL IA tree) |
| `references` | References |
| `analytics` | Settings-level analytics **prefs only** — not Later Analytics product hub |

Ghosts (Roles/SSO/etc.) soft-hide until shipped — do not advertise in rail/⌘K before ship (DESIGN-SYSTEM-V2 ban).

### 3.3 Redirects

| Old | New |
|-----|-----|
| `/profile` | `/settings?tab=account` |
| `/billing` | `/settings?tab=billing` |
| `/finops` | `/settings?tab=finops` |
| `/settings/gateway` etc. | `/settings?tab=gateway` … |

### 3.4 Examples

```
/settings
/settings?tab=overview
/settings?tab=api-keys
/settings?tab=gateway
/settings?tab=members
/settings?tab=billing
/settings?tab=pii
```

Breadcrumb: `Workspace / Settings` (+ tab label in title, not every crumb).

---

## 4. Layout diagrams

### 4.1 Desktop ≥1280

```
Band 1: Workspace / Settings · subtitle one-liner
Band 2: pills/tabs ≤8 + Advanced ▾
────────────────────────────────────────────────
Content column (single) — forms in Panel, not Card soup
Overview: identity · plan chip · health row · ONE accent CTA
```

**Banned:** Second sticky Settings nav rail ~240px.

### 4.2 Tablet / mobile

```
Tab control → horizontal scroll pills OR select “Category”
Single column forms
Touch ≥44px
Sheets for invite / create-key modals
```

---

## 5. Chrome budget

| Band | Contents |
|------|----------|
| **1** | PageHeader title + optional subtitle |
| **2** | Category tabs (≤8 visible) + Advanced |

In-tab toolbars: ≤5 actions (e.g. Members: Invite · Search · Filter · Overflow).

**One primary CTA rule (overview):** Create key **or** Invite **or** Manage billing — context picks one solid accent, not all three solid.

---

## 6. Tab content contracts

### 6.1 Overview

- Org name, plan chip, gateway health / last ingest pulse, member count.  
- Recovery actions: deep links to `api-keys`, `gateway`, `members`, `billing`.  
- Fail→act ≤2 clicks to keys / members / billing.

### 6.2 Account

- Profile, email, sessions, density preference, locale (en/de).  
- Cookie/privacy reopen entry (post-choice cookie banner must not stay fixed).

### 6.3 Org

- Display name, slug, avatar — Admin mutate.

### 6.4 Members

- List + invite + role (Viewer / Member / Admin per bible §8).  
- Primary CTA: **Invite**.

### 6.5 API keys

- Create / revoke / copy once.  
- Day-0 path for J1.  
- Primary CTA: **Create key**.

### 6.6 Gateway

- Base URL, auth headers, agent identity binding notes, copy blocks.  
- Equal-class mention: Gateway **or** SDK → `/agents/connect` + external docs.  
- Not a marketing tour.

### 6.7 Billing

- Plan, invoices, payment method — Admin.  
- Primary CTA when action needed: **Manage billing**.

### 6.8 Security

- SSO placeholders soft-hide; alert notification channels; session policies as shipped.  
- Bundle related controls to stay within disclosure model.

### 6.9 Advanced tabs

Dense forms; same Panel grammar; deep-linkable; listed under Advanced with honest “not on daily strip” affordance.

---

## 7. States

| State | Behavior |
|-------|----------|
| **Empty** | N/A for hub; sub-tabs may empty (no keys → Create key CTA) |
| **First-run** | Overview steers to Create key → Gateway → Connect agent |
| **Loading** | QueryState / form skeletons |
| **Error** | Retry; do not clear draft forms silently |
| **Filtered-empty** | Members search — Clear |
| **Populated** | Forms + tables |
| **Live** | Rare (gateway health pulse) — muted, not perpetual glow |

---

## 8. Components (kit only)

`PageHeader`, Tabs (`pills` allowed for Settings per DS), `Panel`, `Input`/`Select`/`Textarea`, `Button`, `DataTable` (members/keys), `Dialog`/`Sheet`, `Badge`/`StatusBadge`, `QueryState`, `Tag`, copy `CodeChip` for URLs/keys.

No decorative StatCard spam — overview health row may use MetricInline or one click-through StatCard max.

---

## 9. Keyboard map

| Key | Action |
|-----|--------|
| `⌘K` | Jump to Settings tabs (API keys, Gateway, Members, Billing, …) |
| `Esc` | Close dialog/sheet |
| `⌘S` / `Ctrl+S` | Save dirty form when applicable (announce) |

---

## 10. Closed-loop exits

| From | To |
|------|----|
| Overview / Gateway / Keys | `/agents/connect` or Agents empty CTA |
| Gateway done | `/traces` waiting / Dashboard |
| Any | Docs Quickstart (external) secondary |
| Billing | Stay in Settings (external portal only if provider requires) |

Do not dump user into Analytics/Prompts Later hubs.

---

## 11. Permissions

| Tab | Viewer | Member | Admin |
|-----|--------|--------|-------|
| account (own) | ✓ | ✓ | ✓ |
| overview read | ✓ | ✓ | ✓ |
| api-keys | read limited | create if granted | ✓ |
| gateway read | ✓ | ✓ | ✓ |
| members | read | read | ✓ mutate |
| billing / org / security / advanced mutate | | | ✓ |

Hide primary mutate CTAs for roles that cannot act.

---

## 12. Anti-patterns banned

- Second Settings sidebar  
- ≥9 visible tabs on first paint (hard: ≤8)  
- Advertising unshipped SSO/Roles in Cmd+K  
- Hub-of-hubs overview that only links with no pulse  
- Multiple solid accent buttons on overview  
- Purple glow, pillow cards, 9–10px labels  
- Rebuilding docs inside Settings  
- Red-team settings  

---

## 13. Acceptance checklist

- [x] `/settings?tab=` canonical; path redirects  
- [x] ≤8 visible tabs; Advanced collapses the rest  
- [x] No second Settings rail  
- [x] Overview fail→act ≤2 clicks to keys / members / billing  
- [x] Gateway + API keys support J1 connect-tonight  
- [x] `/profile` → account tab  
- [x] Chrome ≤2 bands; one primary CTA per context  
- [x] Permissions hide mutate CTAs  
- [x] Ghosts soft-hidden until shipped  
- [x] en+de; kit only; QueryState on lists  

---

*End of surfaces/settings.md*
