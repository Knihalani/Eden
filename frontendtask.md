EDEN — FRONTEND CODEX BRIEF
Full Audit, Polish Pass, and Interaction Verification
Target: edenobservability.com
Scope: Frontend only. No backend changes, no infra work, no PR system work.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PRODUCT CONTEXT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Eden is an agent observability and improvement platform. It gives teams visibility into what their AI agents are doing, surfaces quality degradation and failure patterns, and in some cases takes automated action (e.g. spawning coding agents, opening PRs) to fix underlying problems. The frontend is the primary surface through which users navigate agent data, review reports, interact with dashboards, manage integrations, and take action. It must feel polished, coherent, and work perfectly on every device and input method.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PRIMARY OBJECTIVE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Do a complete frontend-only audit of the Eden product. Map every page, component, interaction, and visual inconsistency before touching a single line of code. Then fix everything in priority order — broken interactions first, visual polish second — until every user-facing surface works correctly, looks intentional, and feels production-ready.

Do not start fixing until the full audit is mapped and documented.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTCOME REQUIRED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

The end result is a frontend that:

Has zero broken interactions across all pages and components
Handles every user action correctly: clicks, scrolls, hovers, drags, keyboard navigation, form inputs, dropdowns, modals, tabs, toggles, tooltips, and any other interactive element
Shows correct loading states, error states, and empty states everywhere
Behaves correctly on mobile and touch devices
Is fully responsive across breakpoints (mobile, tablet, desktop, wide)
Has consistent visual language: typography scale, spacing system, color usage, component style, icon set, border radius, shadow, motion
Has no visual regressions, layout breaks, or z-index bugs
Feels like a single coherent product, not a patchwork of components

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHASE 0 — FULL AUDIT (DO NOT SKIP, DO NOT FIX YET)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Before writing a single fix, build a complete audit map. The audit map is a structured document (FRONTEND_AUDIT.md) that catalogs every issue found. Only once the full map is complete do you move to Phase 1.

The audit document must cover:

SECTION A — Page & Route Inventory
List every route and page in the app
Note whether each page renders correctly and fully
Flag any pages that 404, throw, or render blank
Note pages that exist in the nav but are unbuilt or stub

SECTION B — Interaction Audit (Per Page)
For each page, document the state of every interactive element:

Clicks
Every button, link, icon button, card click, row click, tab, chip, badge
Does it trigger the right action?
Does it have a hover/active/focus state?
Is there visual feedback (ripple, color change, cursor change)?

Scrolling
Does the page scroll correctly?
Are there nested scrollable containers? Do they conflict?
Is scroll position preserved on back navigation where expected?
Any sticky headers or footers — do they work without obscuring content?

Hovering
Do hover states exist and trigger on all interactive elements?
Are tooltips triggered correctly and positioned correctly (no clipping, no overflow)?
Are hover delays appropriate (not too fast, not sluggish)?

Dragging
Any drag-and-drop surfaces (reordering, kanban, upload zones)?
Do they accept drops correctly?
Is there drag feedback (ghost, placeholder, cursor change)?
Do they work on touch?

Keyboard Navigation
Can the page be fully navigated with Tab/Shift-Tab?
Do focus rings appear and are they visible?
Does Enter/Space activate buttons and links?
Does Escape close modals, dropdowns, drawers, popovers?
Are arrow keys handled in menus, tabs, and lists?
Is focus trapped correctly inside open modals?
Is focus restored to the trigger element after a modal/popover closes?

Form Inputs
Do all inputs accept and display input correctly?
Do validation rules fire at the right time (on blur, on submit, on change)?
Are error messages clear, correctly positioned, and readable?
Do required fields enforce correctly?
Are inputs disabled correctly when action is unavailable?
Do password inputs have show/hide toggle?
Does autofill work without breaking layout?

Modals & Dialogs
Do all modals open correctly from their triggers?
Is the backdrop rendered and does it close the modal on click where expected?
Is the modal correctly centered/anchored?
Does the modal scroll independently if content overflows?
Is the close button accessible and working?
Is focus trapped correctly?

Dropdowns & Select Menus
Do all dropdowns open and close correctly?
Are they correctly positioned (no overflow outside viewport)?
Do they close on outside click?
Do they close on Escape?
Are selected states rendered correctly?
Do multi-select dropdowns work?
Is the option list scrollable when long?

Animations & Transitions
Do page transitions exist and feel smooth?
Do modal/drawer open and close animations work?
Do list item enter/exit animations play correctly?
Are there any janky, stuttering, or broken animations?
Are animations skipped or reduced for users with prefers-reduced-motion?

Loading States
Does every async operation show a loading indicator?
Are skeletons or spinners used appropriately?
Is the page/component usable or correctly blocked while loading?
Are loading states dismissed correctly when data arrives?
Is there a stuck/infinite loading state anywhere?

Error States
Does every async operation handle errors and show an error UI?
Are error messages human-readable (not raw stack traces or API codes)?
Is there a retry mechanism where appropriate?
Are form submission errors shown correctly?
Are network errors handled gracefully?

Empty States
Does every list, table, and data surface show an intentional empty state?
Are empty states informative (do they tell the user what to do next)?
Are there any surfaces that show nothing / a blank box when data is empty?

SECTION C — Mobile & Touch Audit
Test every page at 375px, 768px, 1024px, 1440px
Note any layout breaks, overflow, or element collisions at each breakpoint
Test all interactions via touch simulation
Verify tap targets are at least 44x44px
Check that no hover-only interactions are broken on touch
Check that modals and drawers are usable on small screens
Verify that forms are usable on mobile keyboard

SECTION D — Visual Consistency Audit
Typography: Is there a consistent type scale? Are heading levels used correctly? Is line-height and letter-spacing consistent?
Spacing: Is the spacing system consistent (e.g. 4px/8px base grid)? Are there random pixel values that don't fit the system?
Color: Is the color palette consistent? Are semantic colors (error, success, warning, info) used correctly and consistently? Is contrast ratio sufficient (WCAG AA minimum)?
Component coherence: Are buttons, inputs, cards, badges, and icons using the same design language everywhere? Are there component variants that look like they came from different systems?
Iconography: Is a single icon set used? Are icon sizes consistent? Are icons used semantically?
Borders and radius: Is border-radius consistent? Are there components with sharply different rounding?
Shadows and elevation: Is shadow usage consistent and intentional?
Motion: Is animation easing and duration consistent across components?

SECTION E — Cross-Browser & Environment Audit
Chrome, Firefox, Safari (desktop)
Chrome mobile, Safari iOS
Note any browser-specific rendering bugs

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
INTERACTION VERIFICATION METHODOLOGY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

For each interactive element, the verification test is:

Identify: What is this element? What is it supposed to do?
Trigger: Exercise it via mouse, keyboard, and touch (where applicable)
Observe: Does the expected outcome occur? Does it produce visible feedback?
Edge: Test with empty state, error state, loading state, and long/unusual input
Accessibility: Is it reachable by keyboard? Does it have appropriate ARIA label or role?
Pass / Fail / Needs Polish: Record the verdict in FRONTEND_AUDIT.md

Do not skip elements because they look like they work. Every element must be tested explicitly.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FIX PRIORITY ORDER
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Fix in this exact order. Do not work on lower-priority items before all higher-priority items are resolved.

P0 — Broken (Fix First)
Pages that throw, 404, or render blank
Interactions that do nothing when triggered
Modals or forms that cannot be submitted or closed
Data that never loads (stuck loading states)
Auth walls that block access incorrectly
Crashes or unhandled errors thrown to the user

P1 — Functionally Wrong (Fix Second)
Interactions that trigger the wrong action
Forms that submit with invalid data or fail silently
Dropdowns or menus that don't close correctly
Focus management broken (focus disappears, focus trap missing)
Keyboard navigation that gets stuck or skips elements
Mobile interactions that don't work via touch
Responsive breakpoints that break layout

P2 — Missing States (Fix Third)
Missing loading states on async operations
Missing empty states on data surfaces
Missing error states or raw error text shown to users
Missing hover/active/focus feedback on interactive elements

P3 — Visual Polish (Fix Last)
Typography inconsistencies
Spacing that doesn't fit the grid
Color that's off-palette or low-contrast
Components that look visually mismatched
Animations that feel wrong (too slow, too fast, wrong easing)
Icon size or style inconsistencies
General feel: anything that looks unfinished or incoherent

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EXECUTION RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Do not ask for permission mid-run. Keep going.
Do not stop because a fix is uncertain. Make the best call, document your reasoning in a comment, and move on.
Do not start fixing while the audit is still incomplete. Audit first, always.
Do not redesign. Polish and fix only. Preserve existing layout intent.
Do not add new features or new pages. Fix what is there.
Do not touch backend code, API routes, database logic, infrastructure, or the PR system. Frontend files only.
If a component has widespread visual issues, fix the source component and let changes cascade — do not patch each instance individually.
If a fix requires a tradeoff, document the decision in DECISIONS.md and proceed.
If something is genuinely ambiguous (e.g. unclear intended behavior), make a reasonable judgment call, document it, and continue.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DELIVERABLES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

FRONTEND_AUDIT.md
Complete audit map. Every page, every section (A through E), every issue found. Must be finalized before any fixes begin.

FIXES_LOG.md
Running log of every fix applied. Format per entry:
File changed
What was broken
What was fixed
Priority level (P0/P1/P2/P3)

DECISIONS.md
Any judgment calls made mid-run. Format:
What the ambiguity was
What decision was made and why

SUMMARY.md
End-of-run summary:
Total issues found
Issues fixed by priority level
Any items that were out of scope or intentionally skipped with reason
State of the frontend at end of run

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DEFINITION OF DONE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

This run is complete when ALL of the following are true:

[ ] Every page in the app renders without throwing or going blank
[ ] Every P0 and P1 issue from FRONTENDAUDIT.md has a corresponding fix in FIXESLOG.md
[ ] Every interactive element on every page has been tested and either passes or has a logged fix
[ ] Every async operation has a loading state, error state, and empty state
[ ] Every modal can be opened, interacted with, and closed correctly
[ ] Every form validates correctly and submits or fails with a clear user-facing message
[ ] Keyboard navigation works across all pages with no stuck or missing focus
[ ] All pages are usable on mobile at 375px width
[ ] All pages are usable via touch with tap targets meeting 44px minimum
[ ] Visual consistency audit is complete and all P3 items have been addressed or explicitly deferred with reason
[ ] FRONTENDAUDIT.md, FIXESLOG.md, DECISIONS.md, and SUMMARY.md all exist and are complete

Do not mark this run as done until every checkbox above is true.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
START CONDITION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Begin by reading the full codebase, mapping all routes and pages, and starting FRONTEND_AUDIT.md. Do not write a single fix until the audit document covers all five sections. Once the audit is complete, begin fixing in priority order and keep going until all done criteria are met.
