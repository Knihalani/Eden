# Surface: Prompts registry

> **Status:** Live — secondary (not core leaf)  
> **Phase:** Later (post P7)  
> **Decision date:** 2026-07-22  
> **Companions:** [../02-information-architecture.md](../02-information-architecture.md) §1.2 · [../01-product-bible.md](../01-product-bible.md)

---

## 1. Purpose

Versioned prompt registry: list → select → edit versions → publish / env pin. Iterate templates here; run them in Evaluate playgrounds.

**Not** a 13th core sidebar leaf (IA law ≤12). Reachable via Cmd+K, Mobile More, and related strips.

---

## 2. URL + route grammar

Canonical: `/prompts?prompt=<name>`

| Old / alias | Destination |
|-------------|-------------|
| (none — was soft-landed) | Live `/prompts` |

Breadcrumb: Workspace / Prompts (+ prompt name when selected).

---

## 3. Layout

Master–detail (`ResourcePageShell` + `DetailPanelShell`):

- List of prompts (name, tags, auto-eval)
- Detail: version list, draft template/model/note, save version, env pins, rollback
- Primary CTA: **New prompt**

Related strip: Playgrounds (`/evals?tab=playgrounds`) · Improve · Artifacts · Ledger

---

## 4. Acceptance checklist

- [x] Live `/prompts` (not soft-landed to Dashboard)
- [x] Not a core sidebar leaf (CORE_NAV_LEAF_IDS stays 12)
- [x] Cmd+K + Mobile More entry points
- [x] Master–detail with version editor
- [x] Related strip uses live Improve/Evals destinations
- [x] Kit shell (`ResourcePageShell` / `DetailPanelShell`) — no EmbeddedSurface
- [x] en+de `prompts` + `nav.leaves.prompts`

---

*End of surfaces/prompts.md*
