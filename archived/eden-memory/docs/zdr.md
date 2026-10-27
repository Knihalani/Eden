# Zero data retention — guidance, not a badge

> **Compile era: a retired product direction.** Eden is now passive memory for coding agents ([docs/README.md](README.md)). This file stays in `docs/` because the website's `/isolation` page and a test refer to it by path; the other compile-era documents are in [archived/compile-era/](../archived/compile-era/README.md).

Eden is not ZDR certified. This note is not a certification of any kind. It tells an operator what **Eden** records on the PTC, island, and prompt-cache paths, and what still goes to a **model provider**. Provider ZDR is that provider’s org arrangement, sold by them, not an Eden flag.

A critic who wants Anthropic’s contract should read [Anthropic zero data retention](https://docs.anthropic.com/en/docs/build-with-claude/zero-data-retention) and [API data retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention). This page does not replace those. It maps Eden’s paths onto them so nobody mistakes a cache breakpoint, a local memo, or an `allowed_callers` field for a ZDR badge.

Never claim “Eden is ZDR certified.” Never claim “Eden is ZDR.”

## What Eden records

Eden records **redacted traces and receipts locally**. Credential-shaped values are rewritten at record time (`packages/ir/src/redact.ts`). Control-plane receipts (approvals, versions, executions, refusals) live in the tenant store and export as a hash chain — see [logging](logging.md). Un-uploaded laptop sessions sit under `~/.eden/runs` until drain or retention sweep.

That is Eden’s record. It is not the provider’s retention policy. The laptop file `~/.eden/config.json` holds the API key in plaintext. **It is not a vault.**

## Paths

| Path | What Eden keeps | What leaves the box | ZDR? |
|---|---|---|---|
| Island **memo** (hit) | In-process witness table. Key is `(system, input, schema)`. A hit returns the stored output. Two agreeing outputs are required before a value is served. Cap 512; a burst of unique keys clears the table. | Nothing on this call. The provider is not contacted. | Local lookup. Not provider ZDR. Not a cert. |
| Island **miss** | After the call, the output is observed into the same table. Receipts are redacted. | The island request (system, input, schema) goes to the configured provider. Temperature is pinned to 0. | We do not claim this call is ZDR. It is ZDR only if that provider org is. |
| PTC `allowed_callers` | Compiled program schemas are emitted on the host tool list (`direct` and `code_execution_20260120`). Guidance, not a security wall. | Tool **definitions** (name, description, input schema) still go to the host / model. A PTC script that calls those tools still sends I/O through that host. | We do not claim those calls are ZDR. Anthropic’s own ZDR note excludes some code-execution riders. |
| Prompt-cache breakpoints | Eden sets Anthropic `cache_control: ephemeral` on stable prefix boundaries (last tool, system, last message block). Opt-in `EDEN_CACHE_GUARD=1` moves volatile prefix text after the stable prefix. | The provider may hold a KV cache and hashes in memory for a TTL, then delete them — **if** that org’s ZDR covers prompt caching. | Breakpoints are billing discipline. They do not make Eden ZDR. |
| Laptop home | `~/.eden/config.json`, traces, listing draft, skill hash log. | Nothing extra from these files unless the operator uploads or the wrap forwards a call. | Not a vault. Not ZDR. |

## Island

Compiled programs call an island for the judgment step. The witness memo is **local**: two agreeing outputs for the same key, then a lookup. A miss calls a provider. A pinned island that misses deopts — it does not silently call the model.

The memo is process memory, not an encrypted store. A restart forgets it. Disagreeing outputs reset the count. Eden still holds conversation and receipt state on the client and in the control plane. ZDR is not “the model forgets,” and a local memo is not “Eden is ZDR.”

## PTC

When a host exposes code execution, Eden emits compiled programs as callable functions with `allowed_callers`. That is so an approved routine can be invoked from a PTC script. It still **sends tool definitions to the host**. We do not claim those definitions, or the calls that follow, are ZDR. If the host’s code-execution path is outside the provider’s ZDR cover, Eden cannot pull it back in.

## Prompt cache

`EDEN_PROMPT_CACHE` (default on) places Anthropic-dialect ephemeral markers so a stable prefix can be billed as cache. That is a provider cache. Prompt-cache breakpoints do not make Eden “ZDR.” Provider ZDR, including whether prompt caching is ZDR-eligible, is their org arrangement.

Kill switch: **`EDEN_PROMPT_CACHE=0`**. That flag wins over cache-guard. It stops Eden emitting breakpoints. It does not enroll or unenroll the org in Anthropic ZDR.

## Kill switches on this page

| Flag | Default | What it does |
|---|---|---|
| `EDEN_PROMPT_CACHE=0` | on (unset) | No ephemeral cache breakpoints. Cache-guard is then a no-op. |
| `EDEN_CACHE_GUARD=1` | off | Reorder volatile Anthropic prefix blocks so the breakpoint stays on stable text. Not a ZDR control. |

## What we do not claim

- “Eden is ZDR certified.”
- “Eden is ZDR.”
- That island memo, prompt-cache breakpoints, or PTC `allowed_callers` are a substitute for a provider ZDR contract.
- That a laptop `~/.eden` directory is a vault, a WORM store, or an attested retention hold.
- That third-party hosts, code-execution sandboxes, or tools Eden did not emit are covered by anyone’s ZDR.

Related: [evidence pack](evidence-pack.md), [isolation](isolation.md), [logging](logging.md), [OWASP MCP](owasp-mcp.md).
