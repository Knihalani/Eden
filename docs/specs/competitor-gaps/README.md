# Competitor Gap Implementation Specs

> **Date:** July 9, 2026  
> **Parent analysis:** [`eden-competitor-gap-analysis-laminar-sentrial-raindrop-bento.md`](../../eden-competitor-gap-analysis-laminar-sentrial-raindrop-bento.md)  
> **Review:** [`REVIEW.md`](./REVIEW.md)

This directory contains hyper-detailed implementation specifications for every individual competitive gap point identified in the Eden vs Laminar / Sentrial / Raindrop / BentoLabs analysis.

## Spec index

| ID | Title | Severity | Effort | Spec file |
|---|---|---|---|---|
| **Laminar** |
| 1.1 | Real Agent Debugger (cached prefix replay) | 🔴 | XL | [01-laminar.md](./01-laminar.md#gap-11) |
| 1.2 | Coding-agent iteration loop (CLI + MCP + skill) | 🔴 | L | [01-laminar.md](./01-laminar.md#gap-12) |
| 1.3 | Per-trace Signals (investigation agent) | 🔴 | XL | [01-laminar.md](./01-laminar.md#gap-13) |
| 1.4 | Browser session recording (RRWeb sync) | 🔴 | L | [01-laminar.md](./01-laminar.md#gap-14) |
| 1.5 | Platform UI + local dev server | 🟠 | L | [01-laminar.md](./01-laminar.md#gap-15) |
| 1.6 | Trace compression + search performance | 🟠 | XL | [01-laminar.md](./01-laminar.md#gap-16) |
| 1.7 | Browser/computer-use framework integrations | 🟠 | M | [01-laminar.md](./01-laminar.md#gap-17) |
| 1.8 | Sessions multi-turn timeline | 🟡 | M | [01-laminar.md](./01-laminar.md#gap-18) |
| 1.9 | Custom render templates + labeling UI | 🟡 | M | [01-laminar.md](./01-laminar.md#gap-19) |
| 1.10 | LangGraph visualization | 🟡 | S | [01-laminar.md](./01-laminar.md#gap-110) |
| **Sentrial** |
| 2.1 | Zero-config semantic issue detection | 🔴 | L | [02-sentrial.md](./02-sentrial.md#gap-21) |
| 2.2 | Learn-from-labeled tool calls | 🔴 | L | [02-sentrial.md](./02-sentrial.md#gap-22) |
| 2.3 | Diagnosis → GitHub PR chat flow | 🔴 | L | [02-sentrial.md](./02-sentrial.md#gap-23) |
| 2.4 | Session-first data model | 🟠 | M | [02-sentrial.md](./02-sentrial.md#gap-24) |
| 2.5 | Claude Code / Mastra one-liner integrations | 🟠 | S | [02-sentrial.md](./02-sentrial.md#gap-25) |
| 2.6 | CLI session inspection | 🟡 | S | [02-sentrial.md](./02-sentrial.md#gap-26) |
| 2.7 | "Use with AI" docs page | 🟡 | XS | [02-sentrial.md](./02-sentrial.md#gap-27) |
| **Raindrop** |
| 3.1 | Stumbles → Issues hierarchy | 🔴 | L | [03-raindrop.md](./03-raindrop.md#gap-31) |
| 3.2 | Triage Agent productization | 🔴 | M | [03-raindrop.md](./03-raindrop.md#gap-32) |
| 3.3 | Interactive Slack bot | 🔴 | L | [03-raindrop.md](./03-raindrop.md#gap-33) |
| 3.4 | Eden Workshop (OSS local debugger) | 🟠 | XL | [03-raindrop.md](./03-raindrop.md#gap-34) |
| 3.5 | Issue-linked production experiments | 🟠 | M | [03-raindrop.md](./03-raindrop.md#gap-35) |
| 3.6 | Per-product trained signal classifiers | 🟠 | XL | [03-raindrop.md](./03-raindrop.md#gap-36) |
| 3.7 | Wins / positive signal detection | 🟡 | S | [03-raindrop.md](./03-raindrop.md#gap-37) |
| 3.8 | Deep Search → classifier rules | 🟡 | M | [03-raindrop.md](./03-raindrop.md#gap-38) |
| 3.9 | Conversation UI polish | 🟡 | M | [03-raindrop.md](./03-raindrop.md#gap-39) |
| 3.10 | MCP run_autofix loop | 🟡 | M | [03-raindrop.md](./03-raindrop.md#gap-310) |
| **BentoLabs** |
| 4.1 | Runtime-injected nudges/skills | 🔴 | XL | [04-bentolabs.md](./04-bentolabs.md#gap-41) |
| 4.2 | "The Book" agent memory artifact | 🔴 | L | [04-bentolabs.md](./04-bentolabs.md#gap-42) |
| 4.3 | Evidence-gated promotion pipeline | 🔴 | L | [04-bentolabs.md](./04-bentolabs.md#gap-43) |
| 4.4 | Behavioral drift pinpointing | 🟠 | M | [04-bentolabs.md](./04-bentolabs.md#gap-44) |
| 4.5 | NL alerts + real/benign triage | 🟠 | M | [04-bentolabs.md](./04-bentolabs.md#gap-45) |
| 4.6 | Auto-curated production eval datasets | 🟠 | M | [04-bentolabs.md](./04-bentolabs.md#gap-46) |
| 4.7 | Long-running agent GTM positioning | 🟡 | XS | [04-bentolabs.md](./04-bentolabs.md#gap-47) |
| 4.8 | Zero-label improvement loop UX | 🟡 | S | [04-bentolabs.md](./04-bentolabs.md#gap-48) |
| **Cross-cutting** |
| 5.1 | Detect → Fix → Verify loop | 🔴 | — | [05-cross-cutting.md](./05-cross-cutting.md#theme-51) |
| 5.2 | Developer experience / local iteration | 🔴 | — | [05-cross-cutting.md](./05-cross-cutting.md#theme-52) |
| 5.3 | Slack as product | 🔴 | — | [05-cross-cutting.md](./05-cross-cutting.md#theme-53) |
| 5.4 | Semantic monitoring without config | 🔴 | — | [05-cross-cutting.md](./05-cross-cutting.md#theme-54) |
| 5.5 | Browser/computer-use observability | 🟠 | — | [05-cross-cutting.md](./05-cross-cutting.md#theme-55) |
| 5.6 | Production proof / GTM | 🟡 | — | [05-cross-cutting.md](./05-cross-cutting.md#theme-56) |

## Implementation waves (from REVIEW.md)

**Wave 0 — Unblock existing UI (1 week engineering)**  
Portal contract fixes: debugger API paths, signals schema alignment, sidebar entries.

**Wave 1 — P0 close-the-loop (8–12 weeks)**  
1.1, 2.1, 3.1, 1.2, 2.3, 3.2

**Wave 2 — P1 developer acquisition (6–10 weeks)**  
3.4, 1.4, 1.7, 1.5

**Wave 3 — P2 Bento counter + signals v2 (10–14 weeks)**  
4.1, 4.2, 4.3, 1.3, 3.6

**Wave 4 — P3 polish (ongoing)**  
3.3, 3.9, 1.6, remaining 🟡 items
