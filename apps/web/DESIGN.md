# Eden frontend — tear-down design

**Status:** research + spec only. No pixels in this pass.  
**Revision:** 2 — adversarial pass (Sep 2026). Primitive choice **held**. Canvas, Clerk, landing order, and “what Base UI is missing” **changed**.  
**Scope you locked:** `apps/web`, `apps/control`, and `apps/site`.  
**Job of this file:** pick the primitive we build on, lock colour / type / motion / feel, and say what dies. Implementation starts only after you approve this list.

This is not a component kitchen and not a shadcn restyle. The public site is brand. The signed-in app is product. They share tokens. They do not share cinematic chrome.

---

## 0. What the adversarial pass changed

| Claim in rev 1 | Verdict | Now |
|---|---|---|
| Base UI is the primitive | **Held.** v1.8.0 (4 Sep 2026). MUI’s 2026 letter: Base UI is the company foundation; Joy is on hold because they paused it *to finish Base UI*, not because they abandon primitives. | Keep `@base-ui/react`. Pin a stable version. Path-import (`@base-ui/react/dialog`). |
| Context Menu / Toast / Combobox / Field are things we might lack | **Wrong.** All shipped. Hover Card is named **Preview Card**. Command palette is an official Autocomplete-in-Dialog demo. | Wrap what exists. Do not invent a second library for “gaps” that are naming. |
| Date picker, virtualizer, drag-drop | **Actually missing.** Calendar URL 404; virtualizer and drag PRs still open. | Eden v1 does not need a date grid. Canvas drag is **not** Base UI’s job (see §4). |
| Hand-roll every wrapper, never look at shadcn | **Mostly held.** Copy **Base UI’s own CSS Modules demos**, not shadcn/Coss class soup. | Scaffold from https://base-ui.com (CSS Modules tab). Restyle to tokens the same day. |
| CSS Modules, no Tailwind as design system | **Held.** Tailwind v4 `@theme` mapped to tokens is a later utility option, not v1. Agent prior is zinc/violet/`rounded-xl`. | §5. |
| Rebuild landing as part of tearing everything down | **Dangerous.** `/` just converted under a gated gauntlet. Design-system purity is not a reason to demolish a working brand door in phase 0. | Landing is **last**, and only if tokens moved. Keep the CTA path. |
| Human UI on site consolidates to web | **Held, narrowed.** MCP + `/v1` on `apps/site` stay. Parallel workshop HTML dies or token-matches. | Do not “rewrite site in React.” |
| Control is not a UI | **Held.** Delete unused lime HTML when touched. | |
| No graph library | **Gap.** Current canvas is a custom SVG/layout in `app/canvas` (`layoutProgram`, node boxes). Fine as a prototype; not an editor at 50–200 nodes. | `@xyflow/react` for the **stage** only. IR remains source of truth. Base UI on the **panel**, not on `<g>`. |

**Still forbidden:** MUI Material, Joy, Radix Themes, Chakra, Mantine, Park, Headless UI, Ark as the React system, Ariakit as system of record, Coss UI, `cmdk`, Sonner beside Base Toast, Geist, Lucide-as-personality, second chromatic, light-mode toggle in v1, fake metrics.

---

## 1. What we are tearing down

Today there are three front doors and no shared UI package.

| Surface | What it is | Verdict |
|---|---|---|
| `apps/web` | Next 15 + React 19 + Clerk. Product: landing, auth, home, canvas, notes. Plain global CSS. No primitives. Canvas = custom graph in `app/canvas`. | **Rebuild the product chrome.** Keep wrap `/v1`, `/health`, Clerk wiring, `lib/wrap.ts`. **Do not raze a converting landing to start a design system.** |
| `apps/site` | Bun string-HTML + MCP (`POST /mcp`) + `/v1`. Parallel landing/dashboard/workshop. Tokens drift. | **MCP and API survive.** Human workshop HTML is not a second product. Restyle leftovers from shared tokens or delete pages. |
| `apps/control` | JSON control plane. Orphan `src/ui.ts` (lime `#c8f542`) unused by the server. | **Not a UI.** Delete dead HTML when touched. Never ship lime. |

`packages/*` have no React. There is no design system to migrate — only tokens in `apps/web/app/globals.css` and a drifting set in `apps/site/src/html.ts`.

**Survive:** Clerk (real auth, orgs), wrap `/v1` + `/health`, `@eden/control` as a library, `logo.webp`, exact tagline **Making your agent do less work.**

**Die when implementation starts (not now):** product chrome as 3.5k lines of one-off CSS, site workshop as a second app, control’s unused HTML, any second accent (lime, lavender, ochre, coral, ice, mint, gold).

---

## 2. Primitive — Base UI (held)

**Package:** `@base-ui/react` (MIT, tree-shakeable, pin **1.8.x** or current stable)  
**Docs:** https://base-ui.com — CSS Modules examples are first-class, equal to Tailwind.  
**Composition:** `render` prop, **not** Radix `asChild`.  
**Why unstyled:** we own graphite + 2px radius + crimson-only. A theme kit would fight that.

### Why this still wins

- Authors of Radix + Floating UI, staffed at MUI. [2026 letter](https://mui.com/blog/2026-and-beyond/): Base UI is a major focus; Joy on hold; MUI Base (`@mui/base`) deprecated in favour of this. Joy’s pause is evidence they *finished the primitive*, not that they flake on foundations.
- shadcn/ui defaulted new projects to Base UI in [July 2026](https://ui.shadcn.com/docs/changelog/2026-07-base-ui-default). We still **do not ship shadcn’s look**.
- Coverage Eden actually needs is in 1.8.0: Dialog, Alert Dialog, Menu, Context Menu, Popover, Tooltip, Tabs, Select, Combobox, Autocomplete, Toast, Field, Form, Drawer, Scroll Area, Number Field, Preview Card, Checkbox, Switch, Radio, Slider, Accordion, Collapsible, Toolbar.
- Popup open / highlight latency beats Radix and React Aria in [atomiks/popup-performance-benchmark](https://github.com/atomiks/popup-performance-benchmark).
- Combobox / Autocomplete / Toast exist first-party. Radix still does not have a real Combobox.

### Compared (unchanged rejects)

| Library | Verdict |
|---|---|
| **React Aria Components** | Runner-up if we sign a WCAG/i18n contract. Heavier (~+40kB gzip in shadcn’s 2026 three-base audit). Apache-2.0. Denser interaction → Spectrum gravity. |
| **Radix** | Reject for **greenfield**. Keep only if a leftover dep forces it — isolate, don’t dual-stack `asChild` + `render`. |
| **Ark / Park / Headless UI / Ariakit** | Reject as system of record (cross-framework tax, too small, or 0.x bus factor). |
| **MUI / Chakra / Radix Themes / Mantine** | Never. |
| **Coss UI** ([coss.com/ui](https://coss.com/ui)) | **Trap.** Cal.com’s shadcn+Tailwind v4 kit. Init pulls Inter/Geist Mono, `--success`/`--warning`/`--info`, shadcn token names. Repo default AGPL with MIT CLI bits — easy to copy the wrong tree. Docs still call Base UI “beta” after v1. Steal **one** idea: Command = Dialog + Autocomplete. Copy composition, not CSS. |
| **cmdk / cmdk-base / react-cmdk-base** | `cmdk` pulls Radix Dialog. Random `cmdk-base` ports are not a staffed library. Use Base Autocomplete + Dialog. |

### Where primitives are allowed

| Surface | Primitives? |
|---|---|
| Landing `/` | Almost never. Native `<a>` / `<button>` + CSS. Dialog only if mobile nav needs a focus trap. |
| Account, workspace, tour, setup, home, **canvas panel** | **Yes.** |
| Canvas **graph stage** | **No.** xyflow (or current SVG) + `data-id`. Base UI portals **out of** the transformed pane. |
| Clerk screens | Appearance tokens only. Never rebuild `<SignUp />` as a Base Dialog. |
| `apps/site` HTML | Shared CSS tokens only. |
| `apps/control` | No UI. |

### What we wrap

Owned files under `apps/web/app/ui/`: parts + CSS Modules, tokens only. Start from Base UI’s CSS Modules demos, then replace their borders/type with ours.

**v1 wrap list (do not boil the ocean):** Dialog, Alert Dialog, Menu, Context Menu, Popover, Tooltip, Tabs, Select, Combobox, Autocomplete, Toast (one Provider; two if we add anchored toasts), Field, Drawer, Scroll Area, Checkbox, Switch.

**Ours, not a library:** Button, input chrome, hairlines, rails, empty states, Approve (native `<button>` + `--ship`).

**Compose, don’t install:** Command palette = Dialog + Autocomplete (official demo). Hover inspect on a **panel** = Preview Card or Popover — not on a transformed canvas node until proven.

**Do not wrap in v1:** Calendar/DatePicker (unreleased on the public site). Virtualizer (PRs open). Drag engine (not a graph). Table/Pagination/Skeleton/Badge — those are CSS.

### `render` footgun (real)

`render={() => <Comp />}` and `render={Comp}` are not the same. Putting hooks inside the `render` function can crash React reconciliation ([#4039](https://github.com/mui/base-ui/issues/4039)). Correct: `render={<el />}` or `render={(props) => <el {...props} />}` **without hooks**. ESLint: ban `render={PascalCase}` and hooks inside render callbacks.

### Do not install

`radix-ui`, `@radix-ui/react-*`, `@mui/material`, `@mui/joy`, `@mui/base`, Radix Themes, Chakra, Mantine, Park, Coss CLI, Headless UI, Ark, Ariakit, `cmdk`, Sonner + Base Toast together, `ai-elements` until its Base UI variant merges, Emotion / styled-components, Lucide as the voice, a second icon pack, Floating UI as a direct dep, elkjs until a license read (EPL-2.0 OR GPL-3.0), Rete.js.

---

## 3. Canvas — xyflow for the stage

Base UI does not pan, zoom, route edges, or virtualize SVG. Treating “primitives” as the canvas plan was the biggest hole in rev 1.

**Today:** `apps/web/app/canvas` already lays out `StretchProgram` (`layoutProgram`, node metrics, contract panel). Custom SVG/CSS graph. Honest, but pan/zoom/multi-select/undo at 50–200 nodes is a second product.

**Use:** `@xyflow/react` (React Flow 12, MIT). Dark via `colorMode="dark"` + override `--xy-*` to `--well` / `--line` / `--ink`. IR is source of truth; Flow is a view. Lazy-load on `/request/[id]` and `/live/[id]` only (~58 KB gzip). Memo custom nodes. No MiniMap unless we need it (it is the agent-builder uniform).

**Attribution:** default “React Flow” mark. MIT allows hiding; they ask you to subscribe (Pro from ~$169/mo). **Keep the mark until we pay or explicitly hide it with eyes open.** Hiding without Pro looks cheap.

**Not Rete** (execute-the-graph gravity, styled-components default). **Not elkjs in v1** (copyleft worker). If layout quality needs a library later, `@dagrejs/dagre` (MIT) or keep `layoutProgram`.

**Base UI on canvas:** detail panel (Tabs, Field, Scroll Area), Approve (native + `--ship`), node ⋯ Menu / Context Menu **portaled to `document.body`**, command palette as a Dialog — **never inside the Flow viewport**. Click-to-panel, not Preview Card on a transformed `<g>`.

Context Menu is an enhancement. Visible ⋯ on the selected node is required ([Base UI’s own rule](https://base-ui.com/react/components/context-menu)).

---

## 4. Styling layer (held)

**OKLCH CSS custom properties + CSS Modules on wrappers + one global token file.**

Not Tailwind as the design system. Not Coss. Not shadcn CLI “just for Dialog.”

If we ever add Tailwind v4, `@theme` maps **only** to these tokens, default color scales stripped, and agents are forbidden from `zinc-*` / `violet-*` / `rounded-xl`. Not v1.

**Shared tokens:** one CSS file `apps/web` and leftover `apps/site` HTML both import. Control never gets a third palette.

**Radius:** `2px` on controls (Clerk already). Circles only for the mark / avatars. This is the anti-shadcn tell. Do not “soften” to 8–10px to look more Linear.

**Focus:** `--focus` graphite ring everywhere. Crimson ring **only** on Sign up and Approve.

**Layout:** luminance stacking and hairlines. Rail + well. No nested cards, drop-shadow stacks, KPI grids.

**Portal root:** `.root { isolation: isolate; }` (Base UI handbook). `body { position: relative; }` for iOS 26 Safari dialog backdrops. Test Clerk Sign up + a Base Dialog on iOS 26 before calling the shell done.

---

## 5. Colour — one scheme, three permissions

Night desk. Graphite neutrals (hue **260**, chroma **~0.01**). One chromatic: **crimson** hue **~18**, high chroma, for Sign up and Approve only. Live is a verb (Pause / Resume), not a second hue. Dashboard chrome has **no ship colour**.

Not ochre, coral, ice, mint, gold, Linear lavender, neon cyan, cream paper, Signal black+gold, Coss `--success` green.

**Adversarial on “no ship on dashboard”:** wayfinding to Approve still exists — it lives on the **canvas**, as a word plus crimson there. Home “waiting” is **type** (`waiting` / `blocked` / `named`), not a red dot on the rail. Color is never the only state signal.

Lightness gap (dark bg L < 0.25): body ink L ≥ 0.75. WCAG AA for body and muted. APCA Lc ≥ 60 for body. Contrast is fixed by moving **L only**.

### Core tokens (lock)

| Token | Value | Use |
|---|---|---|
| `--bg` | `oklch(0.16 0.012 260)` | Page |
| `--well` | `oklch(0.145 0.01 260)` | Canvas / recessed |
| `--surface` | `oklch(0.2 0.012 260)` | Raised strip |
| `--paper` | `oklch(0.255 0.012 260)` | Product sheet / panel |
| `--paper-top` | `oklch(0.29 0.012 260)` | Sheet header |
| `--ink` | `oklch(0.93 0.012 260)` | Body |
| `--ink-lift` | `oklch(0.98 0.008 260)` | Display / hover |
| `--muted` | `oklch(0.78 0.014 260)` | Secondary; L gap vs `--bg` is ~0.62 — keep muted **this light** |
| `--line` | `oklch(0.32 0.012 260)` | Hairline |
| `--line-row` | `oklch(0.26 0.01 260)` | Row rules |
| `--focus` | `oklch(0.85 0.01 260)` | Focus ring (not crimson) |
| `--fail` | `oklch(0.74 0.07 15)` | Error **type**; not a brand colour |
| `--ship` | `oklch(0.64 0.21 18)` | Sign up, Approve fill |
| `--ship-ink` | `oklch(0.15 0.05 18)` | Text on ship (L gap vs fill ~0.49; verify AA on the real button) |
| `--ship-hover` | `oklch(0.70 0.2 18)` | |
| `--ship-active` | `oklch(0.58 0.19 18)` | |

`--fail` sits on hue 15 next to ship 18 on purpose (same family, lower chroma). No green success.

Clerk already mirrors these (`apps/web/app/clerk-shell.tsx`). Keep it.

### Graphite ramp (same H, same C%)

| Step | L (approx) | Role |
|---|---|---|
| 50 | 0.98 | Ink lift |
| 100 | 0.93 | Ink |
| 200 | 0.78 | Muted |
| 300 | 0.44 | Bind / strong line |
| 400 | 0.32 | Line |
| 500 | 0.255 | Paper |
| 600 | 0.20 | Surface |
| 700 | 0.16 | Bg |
| 800 | 0.145 | Well |
| 900 | 0.11 | Deeper pit only if the graph needs it |

### Themes (same tokens, different permission)

**Brand (marketing `/`)**  
Cinematic. `--ship` allowed on Sign up (and Approve in a silhouette). Source Serif 4 for the promise. Promise only.

**Product (home, lists, settings)**  
Quiet instrument. **No `--ship` on chrome, nav, or empty states.** Compact density. Rail + well.

**Canvas**  
`--well` stage. `--paper` panel. Crimson **only** on Approve. Node state is type, not a rainbow. xyflow CSS vars remapped — default React Flow pink/blue **forbidden**.

**Auth**  
Product tokens. `borderRadius: 2px`. Crimson as Clerk `colorPrimary`. No Clerk purple.

**Site leftovers**  
Same `:root`. No cream plane. No lime.

No light theme in v1. `color-scheme: dark` only. Deferred on purpose (bright-room builders exist; a toggle is a second product). Revisit after the product shell is real — invert L, keep H/C%.

---

## 6. Type

| Role | Face | Notes |
|---|---|---|
| UI | **Bricolage Grotesque** (`--font-ui`) | Product, chrome, forms, canvas labels |
| Display | **Source Serif 4** (`--font-display`) | Tagline and brand headings on marketing + close. **Not** dashboard titles. |

**Adversarial on Bricolage:** it is a 2025–26 workhorse (“perfectly imperfect,” Google Font darling). Risk: looking like every indie SaaS zine. **Keep it** — already locked, pairs with Source Serif 4, not Inter/Geist. Constrain it so it reads as an instrument, not a poster:

- Optical size / width: **default (text)**, not compressed display, on product UI.
- Weight: 500 body, 600 labels. Do not use the chaotic end of the width axis in the app.
- Marketing may open up slightly on the h1 only.

Do not switch to Geist, Inter, IBM Plex, or a mono UI. Mono only for keys, hashes, version ids.

**Scale (product, major third 1.25, five sizes):**

| Role | Size | Line-height |
|---|---|---|
| caption | 0.75rem | 1.35 |
| secondary | 0.875rem | 1.4 |
| body | 1rem | 1.55 (light-on-dark; do not tighten) |
| section | 1.25rem | 1.25 |
| page title | 1.5rem | 1.2 |

Marketing display stays `clamp()` and `letter-spacing: -0.03em`. Measure for ledes: `max-width: 65ch`.

Load with `font-display: swap` and metric-matched fallbacks (already `next/font`).

---

## 7. Feel

Feel comes from the primitive + restraint, not decoration.

- Keyboard: Base UI’s model (Tab, Esc, typeahead, focus return).
- Tap ≥ 44px (`--tap`) on marketing CTAs and mobile chrome. Product rows can be denser; the **row hit target** still ≥ 44px on touch.
- Skip link to `#content` stays.
- `prefers-reduced-motion: reduce` = static. Disable Base UI enter/exit (`[data-starting-style]`). In tests, set `globalThis.BASE_UI_ANIMATIONS_DISABLED` (what Base UI’s own suite does).
- Allowed motion: GPU `transform` / `opacity`, CSS 3D, canvas `rAF` that **cancels when idle**.
- Forbidden: bounce, particles, gradient text, glass stacks, layout-property animation, elastic easing, `AnimatePresence` on every tooltip.
- Timing: `--ease-out: cubic-bezier(0.16, 1, 0.3, 1)`. Overlays 100–160ms, scale 0.98 → 1 + opacity.
- Marketing scroll (direction A) is brand, not the dashboard.
- Icons: inline SVG, one stroke, 16/20. Not Lucide as personality.
- Empty states: next step (reopen setup). Zeros are honest.

---

## 8. Clerk — portals, not z-index

Do **not** rebuild Clerk with Base UI. Appearance `variables` already map tokens.

**The real bug class (2024–2026):** Clerk UserButton / OrganizationSwitcher portal to `document.body`. Base UI Dialog/Drawer marks the rest of the tree `inert` / `pointer-events: none`. The Clerk menu **paints** on top (their z-index ~10000) and **cannot be clicked**. Same family: [clerk#3739](https://github.com/clerk/javascript/issues/3739), [clerk#4373](https://github.com/clerk/javascript/issues/4373), [shadcn#5462](https://github.com/shadcn-ui/ui/issues/5462).

**Rule:** never put `<UserButton>` / `<OrganizationSwitcher>` inside a Base UI Dialog, Drawer, or modal Menu. Account chrome lives in the **shell**, not in a sheet.

Hatch if we must: Clerk [`UNSAFE_PortalProvider`](https://clerk.com/docs/nextjs/reference/components/utilities/portal-provider) (docs name Radix/Aria; the failure mode is the same). `pointerEvents: "auto"` on popover roots is a smell, not a design.

Appearance ceiling: `variables` = colour/radius/font. `elements` = brittle `cl-*` map. Nested Clerk surfaces need a **nested** appearance object. You will never make `<SignUp />` look like a custom Base Dialog. Don’t try.

---

## 9. Testing

- Query **page/`document.body`**, not the RTL container. Dialogs portal out.
- `waitFor` `role="dialog"` / `role="menu"`. Don’t click through `inert`.
- Playwright: page-level locators; wait until `data-starting-style` is gone (or disable animations in extra CSS).
- Canvas: `data-id` on nodes, not pixel clicks. xyflow’s own suite is Cypress; we still use Playwright + roles.
- Don’t portal Base UI into ShadowRoot (dismiss/backdrop history: [#2867](https://github.com/mui/base-ui/issues/2867)).
- Don’t write a test that opens a Base Dialog **and** a Clerk UserButton.

---

## 10. Bundle (honest)

Today product UI JS beyond React/Next/Clerk ≈ 0.

A signed-in shell (Dialog + Menu + Popover + Tooltip + Select + Toast + Tabs + Combobox), path-imported, is roughly **80–120 KB gzip** shared, not 400 KB. Landing **must not** import this graph.

xyflow is another **~58 KB gzip**, canvas routes only.

CSS Modules wrappers add almost no JS. Skipping Base UI does not keep the current CSS “cheap” — it keeps broken focus traps.

---

## 11. Product rules (unchanged)

From `PRODUCT.md` / `REBUILD.md` / `.impeccable.md`:

1. Landing → sign up → skippable tour → setup prompt → **dashboard**. Canvas is a drill-in.
2. Same `logo.webp`. Never redraw the mark.
3. Approve on the canvas after editing. One chromatic CTA (crimson).
4. A runtime key never turns a tool On.
5. Setup prompt defaults to placeholders.
6. Organizations from day one.
7. If it cannot be proven, it is not on the landing page.
8. Approve metrics: tokens / time / quality, or “not measured” — never an `×` LLM-call ratio.

Copy: Keep = repeating work → a method you Approve. Know = named fact + named source. Next stays empty until it is real.

---

## 12. File shape (when we build)

```
packages/brand/tokens.css     ← :root only; web + site import
apps/web/app/ui/              ← Base UI wrappers + *.module.css
apps/web/app/globals.css      ← reset, themes, product chrome
apps/web/app/landing/         ← brand CSS; almost no primitives
apps/web/app/clerk-shell.tsx  ← appearance variables only
apps/web/app/canvas/          ← xyflow stage (lazy) + existing IR panel
```

`.root { isolation: isolate }` around the app. Toast.Provider once in the product layout, not on `/`.

---

## 13. Rebuild order (gated — do not start until this doc is approved)

One phase, then stop. Same rule as `REBUILD.md`. **Landing is not phase 0.**

0. **Tokens file** — extract shared `:root`. Delete control lime HTML when that file is touched. Landing keeps working (it already uses these tokens).  
1. **Base UI wrappers** — Dialog, Menu, Popover, Tooltip, Tabs, Select, Field, Toast. Unused is fine. ESLint for `render`.  
2. **Account / Clerk** — already real. Verify no UserButton-inside-Dialog. iOS 26 backdrop.  
3. **Product shell** — home rail + well, no ship colour.  
4. **Canvas panel** on Base UI (Tabs/Field/Approve). Graph can stay custom **until** pan/zoom hurts.  
5. **xyflow stage** — lazy, tokenised, IR as source of truth. Only when 4 is approved.  
6. **Landing** — restyle only if tokens drifted. Do not “start from scratch” again for purity.  
7. **Site** — MCP/API stay. Point leftover HTML at tokens, or remove workshop pages.

Do not restore deleted dashboard chrome unless a phase names that piece.

---

## 14. Decision in one line

**Own `@base-ui/react` (path-import, CSS Modules, our tokens). Product chrome only. Canvas stage is `@xyflow/react` when the custom graph runs out; panel stays Base UI. Clerk is appearance + never nested in our modals. Landing stays custom and is last. Site is MCP, not a second app. Control is not a frontend. Do not install Radix, shadcn/Coss looks, cmdk, or a second headless library.**
