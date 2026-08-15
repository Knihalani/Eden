# Wave 13 — Deep UX flow pass (every surface)

**Goal:** finish the clarity + interaction mandate of Waves 10–12 at the *flow*
level. Waves 10–12 made the site *read* clearly (severity vocabulary, human
timestamps, descriptive search, tactile buttons). This wave makes every
interaction *feel* considered: the global loading/empty/error trio, toast
feedback, the ⌘K power-user flow, and the first-run auth shells. Pure
frontend; backend untouched.

The mandate per the audit (this session):

| Flow | Finding | Fix |
|---|---|---|
| ⌘K palette | Live data loads with no affordance; result descriptions leak raw enums (`· error`, `· open`); bare "No matches"; no keyboard hints | Loading skeleton row, one-vocabulary labels, helpful empty state, ↑↓/↵/esc footer |
| Loading states | `QueryLoadingPanel` is bare "Loading…" text on ~15 pages | Skeleton rows matching the route-level `loading.tsx` language |
| Errors | `QueryErrorPanel` text-only, no visual anchor | Icon + tone, same skeleton family |
| Empty states | `EmptyState` text-only on ~40 surfaces | Optional icon slot; apply on primary flows |
| Toasts | Pop in with no motion; tone only via border color | Slide-in animation, tone icons, auto-dismiss progress line |
| Home | Attention cards end abruptly; zero-data states text-only | Hover affordance on cards, icons on empty states |
| Notifications | Empty state text-only; hand-rolled relative time | Shared `EmptyState` + `formatRelativeTime` |
| Auth loading | `(auth)/login` + `signup` loading shells are bare "Loading…" | Skeleton blocks (same family as invite panel + portal shell) |

## Execution order

1. **Shared primitives** — `QueryLoadingPanel` → skeleton layout; `QueryErrorPanel`
   icon; `EmptyState` icon slot; toast animation/icons/progress. Every later
   flow fix rides on these.
2. **Command palette** — loading row, vocabulary labels, footer hints, clear
   button, empty-state copy.
3. **Flow polish** — home attention cards + empty states; notifications inbox;
   auth loading shells.
4. **Tests** — pin each new behavior; keep the existing 360+ vitest suite green.
5. **Validation** — vitest, `tsc --noEmit`, eslint, portal lint scripts.

## Files touched (expected)

`components/shell/query-error-panel.tsx` · `lab/lab-toast.tsx` ·
`lab/lab-ui.tsx` · `styles/components.css` ·
`components/shell/command-palette.tsx` · `app/(portal)/home/home-client.tsx` ·
`components/shell/notifications-bell.tsx` ·
`app/(auth)/login/[[...login]]/loading.tsx` ·
`app/(auth)/signup/[[...signup]]/loading.tsx` + new/extended tests.

## Definition of done

Portal vitest green (360+ → more), `tsc --noEmit` clean, eslint 0 errors,
`lint:portal-layout` / `lint:portal-classes` clean.
