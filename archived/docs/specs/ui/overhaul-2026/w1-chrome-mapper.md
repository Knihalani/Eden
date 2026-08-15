<!-- Auto-captured from Wave 1 agent `w1-chrome-mapper` (read-only discovery). -->

# Portal Chrome Deep Map (`w1-chrome-mapper`)

READ-ONLY map of logged-in portal chrome. Entry: `(portal)/layout.tsx` → `PortalChrome` → `AppShell`.

---

## Live refresh 2026-07-20

Verified against current `portal-chrome.tsx`, `AppShell.tsx`, and `onboarding-progress.ts`. Corrections vs the original Wave 1 capture:

| Claim (original) | Live code | Action |
|---|---|---|
| `OrganizationSwitcher` only when `!collapsed` | **Always mounted** — collapsed 64px rail still opens org picker (`portal-chrome.tsx:668-690`) | §5 + tree updated |
| `hideChrome` on onboarding wizard paths | **DEAD** — `isOnboardingWizardPath` always returns `false` (`onboarding-progress.ts:53-55`); `hidePortalChrome` never true | §0 / overload #10 updated |
| Worst-case chrome before content | **~7 main-column bands** possible (sticky header + onboarding sticky + offline + org-sync + auth + PageHeader + toolbar) | New §0.1 — **FAILS** anti-clutter / ≤2 hub-band doctrine |
| AppShell slots (`sidebar` / `header` / `children` / `mobileNav` / `commandPalette` / `aiRail`) | **Still accurate** (`AppShell.tsx:28-75`) | Keep |

Tree + sticky header anatomy below remain the structural map; read §0.1 and §5 before citing collapse / hideChrome behavior.

---

## 0.1 Worst-case simultaneous chrome (main column)

Anti-clutter / hub doctrine (`w3-density-rules.md`): hub chrome ≤ **2** bands (identity/tabs + sticky filters) under AppShell. Live worst case stacks **~7** main-column bands **before** primary list/detail content:

| # | Band | Condition | Sticky / z | Source |
|---|---|---|---|---|
| 1 | **AppShell sticky header** | always (hideChrome dead) | `sticky top-0 z-30` | `portal-chrome.tsx:895+` |
| 2 | **OnboardingBanner** | tour incomplete + not session-dismissed | `sticky top-14 z-20` | children stack ~`1052`; `onboarding-banner.tsx` |
| 3 | **Offline banner** | `!online` | in-flow | ~`1076-1087` |
| 4 | **Org-syncing banner** | `orgSyncing` ∧ not session auth | in-flow | ~`1088-1116` |
| 5 | **Auth error banner** | `user && authError` | in-flow; `role=alert` | ~`1117-1179` |
| 6 | **PageHeader** | page identity (most hubs) | in-page | `page-header.tsx` via `ResourcePageShell.header` |
| 7 | **Toolbar** | filters / tabs / ResourceOsToolbar / QueryFilterBar | in-page | `ResourcePageShell.toolbar` |

**Verdict:** Simultaneous chrome **FAILS** anti-clutter doctrine — operator can see shell sticky + onboarding sticky + three status banners + page identity + filter toolbar before any rows. Blocking banners set `data-eden-chrome-banner` (§3) but do not collapse PageHeader/toolbar.

---

## 1. Component tree

```
(portal)/layout.tsx
└─ PortalProviders
   └─ PortalChrome                          [portal-chrome.tsx:141]
      └─ Suspense
         └─ PortalLayoutContent             [portal-chrome.tsx:162]
            └─ AppShell                     [AppShell.tsx:28]
               └─ DensityProvider           [DensityProvider.tsx:8]
                  └─ div[data-density][data-shell]
                     ├─ a.skip-to-content
                     ├─ sidebar? (unless hideChrome — currently never)
                     │  ├─ mobile drawer backdrop (z-40)     [portal-chrome.tsx:584]
                     │  └─ <aside#portal-sidebar> (z-50)     [portal-chrome.tsx:593]
                     │     ├─ brand row (Logo + ⌘B + mobile X)
                     │     ├─ OrganizationSwitcher (always; compact when collapsed)
                     │     ├─ <nav> pinned + groups + customize/advanced
                     │     └─ user footer (BudgetTicker + avatar menu)
                     ├─ <main#main-content>
                     │  ├─ header? (sticky)                   [portal-chrome.tsx:895]
                     │  ├─ children (page stack)              [portal-chrome.tsx:~1048]
                     │  │  ├─ OnboardingBanner
                     │  │  ├─ OnboardingOverlay (dynamic)
                     │  │  └─ ErrorBoundary
                     │  │     ├─ offline banner
                     │  │     ├─ org-syncing banner
                     │  │     ├─ auth banner
                     │  │     └─ {route children}  ← PageHeader + toolbar live here
                     │  ├─ MobileBottomNav? (lg:hidden, z-40)
                     │  └─ CommandPalette? (slot; inside main)
                     └─ aiRail? (sibling of main)
                        └─ ChatSidebar (dynamic)              [ChatSidebar.tsx:36]
                           ├─ FAB + coach (closed)
                           ├─ Sheet (mobile open)
                           └─ <aside> (desktop open)
```

**AppShell slots (still accurate):** `sidebar`, `header`, `children`, `mobileNav`, `commandPalette`, `aiRail` — gated by `hideChrome` except `children` + `commandPalette` (`AppShell.tsx:52-72`).

**Hide path (DEAD):** `hideChrome={isOnboardingWizardPath(pathname)}` is wired (`portal-chrome.tsx:575-581`) but `isOnboardingWizardPath` **always returns `false`** (`onboarding-progress.ts:53-55` — “Legacy wizard routes redirect; improvement-loop keeps full chrome”). Result: full chrome on all logged-in routes; `data-shell` stays `"full"`.

---

## 2. Sticky header anatomy

| | Detail |
|---|---|
| **Mount** | `header` prop → `AppShell` → inside `#main-content` |
| **File** | `portal-chrome.tsx:895–~1020` |
| **Position** | `sticky top-0 z-30` |
| **Surface** | `bg-[var(--bg-primary)]/95 backdrop-blur-sm border-b` |
| **Inner row height** | `h-11` (44px) · `px-4 lg:px-10` |
| **Layout** | `flex items-center justify-between` (not a strict 3-column grid) |

### Slots (L → R)

| Slot | Viewport | Contents |
|---|---|---|
| **L — Mobile chrome** | `< lg` only (`lg:hidden`) | Hamburger (`min 44×44`, opens drawer) + `Logo` sm |
| **C — Breadcrumb** | all | Home icon → crumbs (collapse middle if ≥3) + optional `GROUP_LABEL ·` on leaf · `flex-1 lg:flex-initial` |
| **C+ — Help** | all | `PageHelpHint` (`shrink-0 ml-2`) — no-op if path has no description |
| **R — Actions** | all | Search (desktop: labeled ⌘K; mobile: icon) + `NotificationsDropdown` |

**Not in sticky header:** org switcher, density toggle, AI open control, user menu (those live in sidebar / settings / FAB).

---

## 3. Banner stack — order / conditions / z-index

### In-page stack (document order under `#main-content`, below sticky header)

| # | Banner | Condition | Sticky/z | File:line |
|---|---|---|---|---|
| 1 | **OnboardingBanner** | tour incomplete + not wizard path + not session-dismissed | `sticky top-14 z-20` | ~`1052`, `onboarding-banner.tsx:68–99` |
| — | **OnboardingOverlay** | product tour (deferred if chrome banners) | overlay | ~`1053–1055` |
| 2 | **Offline** | `!online` | in-flow, no sticky | ~`1076–1087` |
| 3 | **Org syncing** | `orgSyncing` ∧ not session auth ∧ not wizard path | in-flow | ~`1088–1116` |
| 4 | **Auth error** | `user && authError` | in-flow; `role=alert` | ~`1117–1179` |
| 5 | **Page children** | — | — | ~`1180` |

`OnboardingBanner` collapses to a compact chip when `showAuthBanner` (`collapsed={!!showAuthBanner}`).

### Blocking / deferral signal

```
blockingChromeBanner = showAuthBanner || showOrgSyncingBanner || !online
→ document.documentElement[data-eden-chrome-banner="1"]
```

- Set: `portal-chrome.tsx:483–495`
- Attr: `lib/overlay-defer.ts:9`
- Consumers: cookie consent + `OnboardingOverlay` via `shouldDeferBlockingOverlays()`

### Global z-index layer cake (chrome-related)

| Layer | z | Notes |
|---|---|---|
| OnboardingBanner | `z-20` | under header |
| Sticky header / AI desktop panel | `z-30` | **same band** — collide when AI open |
| Mobile drawer backdrop / bottom nav / cookie | `z-40` / `--z-cookie:40` | |
| Sidebar / FAB / CommandPalette / notif menu | `z-50` | |
| Toasts | `--z-toast: 60` | |

---

## 4. AI rail — mount / width / breakpoints

| | Detail |
|---|---|
| **Mount** | `AppShell` `aiRail` prop — **sibling after `</main>`**, not inside main (`AppShell.tsx:66`, `portal-chrome.tsx:1025`) |
| **Component** | dynamic `ChatSidebar` (`ssr:false`) |
| **Gate** | `f70` feature flag fail-closed; returns `null` if off (`ChatSidebar.tsx:43`) |
| **Width** | `SIDEBAR_WIDTH = 360` (`ai-insights/types.ts:81`); desktop `w-[min(100vw,360px)]` |
| **Desktop push** | `#main-content` gets `marginRight: 360px` when open ∧ `min-width: 1024px` ∧ org ∧ f70 (`useChatSidebar.ts:229–248`) |
| **Breakpoint** | `max-width: 1023px` → mobile Sheet; `≥1024` → fixed aside (`useChatSidebar.ts:130`, `ChatSidebar.tsx:183–212`) |
| **Desktop panel** | `fixed right-0 top-0 z-30 h-dvh` |
| **Mobile** | Radix `Sheet` `side=right`, `w-full max-w-full sm:max-w-md` |
| **FAB (closed)** | `fixed bottom-20 right-4 z-50` (clears mobile nav); `lg:bottom-6 lg:right-6` |
| **Toggle** | `⌘/Ctrl+J` → `eden:toggle-ai-chat` (`portal-chrome.tsx:360–363`); also `eden:ask-ai`, `?ai=1` |
| **Route hide** | FAB hidden on `/onboarding*`; panel still gated by org |
| **suppressCoach** | `!!showAuthBanner` |

---

## 5. Org switcher — duplicate locations

| Location | Mechanism | When visible |
|---|---|---|
| **A. Sidebar** | Clerk `<OrganizationSwitcher hidePersonal afterSelectOrganizationUrl="/dashboard">` | **Always mounted** — expanded full-width trigger; collapsed `w-10` centered trigger (preview text + chevron hidden) | `portal-chrome.tsx:668-690` |
| **B. Settings page** | Eden `<Select>` over `organizations` + `setCurrentOrg` + Clerk `setActive` | Always on Settings when `organizations.length > 0` | `settings/page.tsx` (org panel) |
| **C. User menu → Organization** | Link `/settings?tab=org` | Always (sidebar footer) | `portal-chrome.tsx` user menu |
| **D. OrgTab / create flows** | `setActiveOrg` + `setCurrentOrg` on create | Settings Org tab | `org-tab.tsx` |

**Not duplicated in sticky header.** Collapsed rail **still** exposes org picker (comment: “Always mounted so collapsed 64px rail still opens org picker”).

---

## 6. Density controls

| | Detail |
|---|---|
| **Type** | `"comfortable" \| "compact"` (`use-sidebar-prefs.ts:26`) |
| **Source of truth** | `useSidebarPrefs().prefs.density` (API + sessionStorage) |
| **UI to change** | **Only** Settings → Sidebar tab toggle (`sidebar-settings-view.tsx:104–115`) |
| **Chrome wire** | `densityCompact` → `AppShell density=` → `DensityProvider` + `data-density` (`portal-chrome.tsx:183,580`; `AppShell.tsx:40–46`) |
| **Direct chrome effects** | Nav padding/gaps; `NavItem`/`NavSubItem` `py` + icon size (`portal-chrome.tsx:703–753`) |
| **Downstream** | `InfiniteDataTable`, `VirtualizedList`, `QueryFilterBar` via `useDensity()`; CSS in `globals.css:898–917` |

**Related (not density):** sidebar width collapse (`eden:sidebar:collapsed`), advanced surfaces toggle (`eden:sidebar:advanced-collapsed`).

---

## 7. File:line mount refs

| Concern | Path:lines |
|---|---|
| Layout mount | `clients/portal/src/app/(portal)/layout.tsx:18–20` |
| PortalChrome / Suspense | `.../portal-chrome.tsx:141–159` |
| AppShell composition | `.../portal-chrome.tsx:579+` + `AppShell.tsx:39–75` |
| Sidebar + org switcher | `portal-chrome.tsx:582–891` / **org always mounted `668–690`** |
| Sticky header | `portal-chrome.tsx:895–~1020` |
| CommandPalette slot | `portal-chrome.tsx` commandPalette prop; impl `components/ui/command-palette.tsx` |
| AI rail slot | `portal-chrome.tsx` aiRail prop; `ChatSidebar.tsx` |
| Banner stack | `portal-chrome.tsx:~1048–1180` |
| Mobile bottom nav | `AppShell` `mobileNav` ← `portal-chrome.tsx`; `MobileBottomNav.tsx` |
| Density provider | `AppShell.tsx:40`; control UI `sidebar-settings-view.tsx` |
| Settings org Select | `settings/page.tsx` org panel |
| Overlay defer attr | `portal-chrome.tsx` blockingChromeBanner effect; `lib/overlay-defer.ts:9–18` |
| hideChrome gate (dead) | `portal-chrome.tsx:575–581`; `onboarding-progress.ts:53–55` |

---

## 8. Overload points

1. **z-30 collision** — Sticky header and desktop AI panel both `z-30`; open AI can fight header stacking.
2. **Banner sticky offset mismatch** — Header `h-11` (44px) but OnboardingBanner uses `top-14` (56px) → gap or mis-stick.
3. **Worst-case ~7 main-column bands** — Sticky header + onboarding + offline + org-sync + auth + PageHeader + toolbar before content (**FAILS** anti-clutter / ≤2 hub-band doctrine). See §0.1.
4. **Dual org models** — Clerk `OrganizationSwitcher` (sidebar, always mounted incl. collapsed) vs Eden Select + `setCurrentOrg` (Settings) → two UIs, sync via Clerk active org + `useOrg`.
5. **Chrome banner pile-up** — Offline + sync + auth can all show; onboarding chip collapses only for auth, not offline/sync.
6. **FAB vs mobile nav vs cookie** — FAB `bottom-20`, cookie above `4rem` bottom nav, mobile nav `z-40`, FAB `z-50` — crowded bottom-right on narrow viewports.
7. **CommandPalette inside `main`** — Mounted in main slot (`AppShell.tsx:70`) but `fixed inset-0 z-50`; competes with sidebar/FAB z-50 layers.
8. **Many sticky/fixed layers** — Sidebar sticky `lg:h-dvh`, header sticky, onboarding sticky, AI fixed, mobile nav fixed — scroll + focus traps (drawer, AI, palette, tour) interact.
9. **Density control buried** — Affects whole shell tables/nav but only reachable via Settings → Sidebar (plus “Customize sidebar” link).
10. **hideChrome is DEAD** — `isOnboardingWizardPath` always `false`; wizard minimal-shell path never activates. Dead gate still passed to `AppShell` (`portal-chrome.tsx:575-581`).

---

### Evidence snapshot

- Primary chrome: `portal-chrome.tsx` + `AppShell.tsx` (76 LOC incl. props)
- Sidebar widths: expanded `240` / collapsed `64` (`portal-chrome.tsx:78–79`)
- Header row: `h-11`; AI rail: `360px`; mobile/desktop split: `1023px` / `1024px`
- Org switcher in chrome: **1 Clerk component, always mounted (incl. collapsed)**; functional duplicate: **Settings Select**
- `hideChrome` / wizard path: **unreachable** (`onboarding-progress.ts:53-55`)