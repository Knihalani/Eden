# Portal UX walkthrough — V2 post-overhaul checklist

Use this for a 15–20 minute team review after Wave 12 freeze.

## Prep

- [ ] Portal running locally (`bun run dev` in `clients/portal`)
- [ ] Org with at least one API key (first-run paths still matter)
- [ ] Optional: `e2e/.auth-state.json` for golden / axe later

## Home + Shell (fleet freeze · 5 min)

Use after W11 freeze (`.home-shell-w11-freeze.md`) when reviewing `/dashboard` + global chrome.

- [ ] **Cookie 2A** — first visit: banner; Accept/Decline → **nothing** fixed; reopen only via Settings Privacy or footer “Cookie preferences”
- [ ] **Ask AI 1A** — find chat in under 2s via header icon **or** redesigned FAB **or** ⌘K/⌘J (one surface; collapsed default)
- [ ] **Sidebar** — tonal rail 240↔64; core ≤12; Advanced collapsed; no `SidebarSearch`
- [ ] **Header** — slim `h-11`; breadcrumbs + visible **Search… ⌘K** chip + Ask AI + notifications (≤2 bands with page toolbar)
- [ ] **Home** `/dashboard` — Status (KPI≤4) → Diagnosis (**one** solid CTA) → Recent failures; ready toolbar **Open Traces** is ghost
- [ ] **Bottom exclusivity** — FAB vs mobile nav never stacked; cookie gone does not collide
- [ ] `portal-chrome.tsx` ≤400 LOC (freeze measured **321**)

## Chrome (2 min)

- [ ] Sidebar ≤12 core items; Advanced collapsed by default
- [ ] Header = breadcrumbs + Search…⌘K chip + Ask AI + notifications (no PageHelpHint triple)
- [ ] AI rail starts collapsed; header / FAB / ⌘K can Ask AI
- [ ] At most one banner visible
- [ ] Mobile: bottom nav 5 cores; tables become cards on key hubs
- [ ] `portal-chrome.tsx` stays lean (Home Shell freeze **321 LOC**)

## Happy path — Observe → Eval → Improve (8 min)

1. **Home** `/dashboard` — status strip → diagnosis → one CTA (not a KPI wall); Ask AI discoverable without ⌘K knowledge.
2. **Traces** `/traces` — count first-paint controls (tabs + filters + views + More ≤8). Open a row → Transcript default. More → **Open Improve**.
3. **Issues** `/issues` — select row; list stays; resolve/triage in detail; **Open Improve** → `/improve?issue=`.
4. **Evals** `/evals` — primary tabs only; Advanced overflow for studio/synthetic. Playgrounds consume `?prompt=` from Improve Prompts.
5. **Improve V3** `/improve` — master–detail Queue (Needs you / In progress / Verify) → Plans Diff/Summary → Artifacts evidence-gated promote → Ledger. Related strip = Issues · Artifacts · Ledger · Prompts (Advanced off strip).

### Improve V3 loop (Wave 9)

- [ ] Queue opens with ViewsMenu (not three permanent card walls); `?issue=` filters and auto-opens single plan when applicable
- [ ] Hub related strip = Issues · Artifacts · Ledger · Prompts only
- [ ] Prompts `/prompts` is core Improve; **Open in Playground** → `/evals?tab=playgrounds&prompt=`
- [ ] Artifacts promote CTA only inside evidence boundary; Ledger owns promotions mode
- [ ] History tab: dense runs table + **Run sweep now**; empty = one CTA
- [ ] Approve toasts stay honest (PR opened / promoted / held — never bare “Approved”)
- [ ] Onboarding `/onboarding/improvement-loop` checklist includes Queue + Prompts
- [ ] Advanced (Scorecard / Online scoring / Change impact / Guardrails / Cost) stay off hub strip

## Settings + density (3 min)

- [ ] `/settings` shows ≤8 default tabs; Advanced reveals gateway/PII/retention/exports
- [ ] No second 240px settings sidebar
- [ ] Density toggle Comfortable ↔ Compact persists

## Regression sniff (3 min)

- [ ] `/observability` redirects to `/traces`
- [ ] `/promotions` lands on ledger promotions mode
- [ ] Auth pages (sign-in / forgot / reset) still match portal dark chrome
- [ ] Badge variants only from kit (`Badge` / `StatusBadge` family)

## Sign-off

- [ ] No new solid accent CTAs competing on one screen
- [ ] No hub-of-hubs double title when opening Evals/Analytics tabs
- [ ] 75-route matrix reviewed: `.wave12-route-matrix.md`
- [ ] Ship critic: `.wave12-final-critic.md`

---

## Workspace (Ambition A · 5 min)

Use after V2 chrome sniff when reviewing Settings / Audit.

- [ ] `/settings` lands on **Overview** (identity + plan + health + one primary CTA)
- [ ] Daily tabs ≤6; Advanced dashed / opt-in — no second 240px settings sidebar
- [ ] Fail→act: from overview, open API keys / Members / Billing in ≤2 clicks
- [ ] Personal org: no invite / SCIM / transfer chrome; Members teaches upgrade
- [ ] `?tab=audit-log` redirects to `/audit-trail` (sidebar Audit trail is the sole IA entry)
- [ ] Mobile More → Workspace = Audit trail · Settings · API keys only
- [ ] `?tab=roles` / `?tab=sso` → quiet notice only (Ghosts A — not in rail or ⌘K)
- [ ] Freeze critic / signoff: `.workspace-wave12-final-critic.md` · `.workspace-wave12-signoff.md`
- [ ] Optional: live axe checklist in `.workspace-wave12-axe-evidence.md` (deferred if server/auth missing)

## Workspace Section Overhaul

1. Open **Settings** → Overview (workspace identity + CTAs to keys/members/billing).
2. Mobile More → **Workspace** = Audit trail, Settings, API keys.
3. Compliance lives only at **/audit-trail** (Events \| Chain packs). `?tab=audit-log` redirects.
4. Personal workspaces: no invite/SCIM/transfer; Members teaches team upgrade.
5. Roles/SSO deep-links show a quiet notice only (not in rail/⌘K promo).

## Evaluate V3 (5–8 min)

Use after Observe / Improve sniff when reviewing `/evals` closed loop (Waves E0–E7 freeze).

- [ ] **Hub** `/evals` — three primary tabs only: **Datasets · Playground · Experiments**; **Advanced** overflow = Scores / Labeling / Studio / Synthetic (one-line jobs; no Go-to soup)
- [ ] **Trace → dataset** — open a trace → **Add to dataset** (single and, if multi-select, bulk) → lands under `/evals?tab=datasets` with dataset selected
- [ ] **Dataset → experiment** — open a dataset → solid **Start experiment** → lands Experiments with new run
- [ ] **Playground Run / Promote** — solid **Run**; fail-first matrix; bind dataset; **Promote** → Experiments compare-ready (`experimentId` selected). Optional: Trace **Open playground** shows **From production** chip
- [ ] **Experiments compare** — pick **baseline**; open **Diff** (Base↔Comparison / Expected↔Output); see Improve / Regress / Tradeoff / Tie grades; toggle `failuresOnly` (URL `failuresOnly=1`) for regression-first triage
- [ ] Soft: live Evaluate screenshots / authenticated axe deferred this freeze (Clerk session/key mismatch) — path contract + `e2e/golden/w-e7-visual-baselines.md` + W12 `05-playgrounds` / `07-experiments` + `.cursor/visual-research/evals-v3/` still count; see `.wave-e7-final-critic.md`
