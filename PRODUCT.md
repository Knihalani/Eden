# Product

## Register

**product** — design serves the product. Primary surfaces are the authenticated portal (dashboards, traces, evals, settings, builder) and the docs site as a technical reference companion. Marketing exists but is secondary to the instrument-panel product experience.

## Users & Purpose

### Primary: AI / ML engineers and platform owners

- **Context**: lives in a terminal and an IDE. Already runs OpenAI / Anthropic / Bedrock in production. Often on call.
- **Job to be done**: drop in one proxy line, capture every LLM call, then close the loop (find failures → propose a fix → ship a PR) without leaving the tool.
- **Sophistication**: high. Reads diffs, eval scores, and expects honest units and timestamps.
- **Pain**: vendor dashboards that hide cost; agents that silently drift; telemetry that doesn't survive a re-org.

### Secondary: engineering managers and platform leads

- Same surface, different lens — cost, eval regression rate, org-wide coverage, audit log.
- Needs to trust numbers in a board update without re-running the math.

### Purpose

Eden is the observability + improvement platform for AI agents and LLM apps: drop-in SDKs + OpenAI-compatible gateway for capture, and a multi-tenant web workspace for traces, evals, export, and a cited AI assistant.

## Brand Personality

**Three words: precise, technical, calm.**

- **Voice**: dry, declarative, infrastructure-grade. Never breathless. Never "revolutionary". Closer to a Stripe changelog than a SaaS landing page.
- **Tone**: confident with quiet edges. Trust is earned by being right, not loud.
- **Emotional goal**: *I trust this with my production traces.* Dense, legible instrument panel — never decorative.
- **Anti-personality**: no playful illustrations, no exclamation marks in CTAs, no "AI-y" gradients behind every headline, no anthropomorphised mascots.

## References

Mood references (intent, not pixel-matching):

- **Linear** — restraint, dense data tables, keyboard-first
- **Vercel dashboard** — black, sharp borders, monospace micro-labels
- **Raycast store** — focused ambient motion, no ambient decoration behind work
- **Stripe Sigma / Atlas** — instrument-panel precision
- **Terminal.app + VS Code dark+** — colour anchors

## Anti-references

- Gradient hero blobs behind headlines
- Pastel SaaS palettes
- Cartoon robots / sparkles / smiling agents
- Drop-shadowed neumorphic cards
- Pillow-y rounded everything (`rounded-3xl`, oversized blur)
- Phosphor green used decoratively (it means *active / running*)
- Borders below WCAG 3:1
- Arbitrary `z-9999` overlays

## Accessibility & Inclusion

- Target **WCAG AA** for text and non-text contrast (borders audited ≥ 3:1).
- Dark-terminal theme only; `color-scheme: dark` on root.
- Respect `prefers-reduced-motion` (disable shimmer, mesh drift, ticker sweeps).
- Keyboard-first navigation; focus rings with offset; mobile touch targets ≥ 44×44 where interactive.
- Semantic landmarks, labeled forms, and chart/SVG accessibility where data is conveyed visually.

## Strategic Design Principles

Resolve trade-offs in this order: **legibility → precision → restraint → motion → coherence**.

1. **Legibility beats decoration** — density is a feature only when every line can be read at speed.
2. **Token discipline** — primitive → semantic → component; never raw hex from components.
3. **Active is green, action is blue** — phosphor green for running/live/success; terminal blue for primary actions and focus.
4. **Instrument panel, not marketing deck** — information density over hero metrics theatre.
5. **Motion conveys state** — 150–300ms ease-out; no bounce/elastic; no page-load choreography.
