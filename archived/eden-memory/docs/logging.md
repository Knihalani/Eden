# Logging — EU AI Act Article 12, aligned, not certified

> **Compile era: a retired product direction.** Eden is now passive memory for coding agents ([docs/README.md](README.md)). This file stays in `docs/` because `isolation.md`, `evidence-pack.md` and `zdr.md` link to it; the other compile-era documents are in [archived/compile-era/](../archived/compile-era/README.md).

[Article 12](https://artificialintelligenceact.eu/article/12/) (automatic recording of events) is cited as in force from **2 August 2026**.

Eden is **not** claiming high-risk AI-system certification under the EU AI Act. This note is **not** a SOC 2 report. Alignment here means: automatic logs, exportable, tamper-evident, with a stated retention floor — and an explicit list of what we do not claim.

## What we actually record

The control plane automatically records four event kinds:

1. **Approvals** — a compiled tool shipped live (human Approve).
2. **Versions** — superseded compilations kept so a replacement can be diffed.
3. **Executions** — receipts of compiled runs (ok / not ok).
4. **Refusals** — compile or shadow refusals that did not ship.

Those four are what the export contains. We do not log Annex III biometric fields; that is not this product.

## Export

```
eden audit export --format jsonl
eden audit export --format csv
eden audit verify <file>
```

Each record carries `sha256` of the canonical payload plus `prev` (the previous record’s hash; the first `prev` is 64 zero hex chars). `verify` accepts a clean file. Splicing a line or flipping a byte fails — fail closed. A broken export is not on the wrap/agent path — fail open for the agent.

JSONL opens in `jq`. CSV opens in a spreadsheet. Formula-shaped fields are prefixed so they do not execute as formulas.

## Retention floor

- Control-plane traces and receipts are capped at **5,000** rows; oldest dropped. Operational ceiling, not a legal hold.
- Un-uploaded `~/.eden/runs` logs are swept after `EDEN_RETAIN_DAYS` (default **14**).

We do not claim a seven-year archive, a WORM store, or an auditor-attested retention schedule.

## What we do not claim

- High-risk certification under the EU AI Act.
- SOC 2 (Type I or Type II).
- That the SQLite file is itself an immutable log. The **export** is the tamper-evident artifact.
