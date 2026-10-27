# @eden/redact

The secret gate, salvaged from the memory era (`archived/eden-memory/src/memory-secrets.ts` and
`archived/eden-memory/packages/ir/src/redact.ts`). It is the most battle-tested code in the old tree: the vendored
gitleaks v8.30.1 rules, provider shapes gitleaks misses, keyword rules, URL userinfo and keyword-gated entropy.

- `sanitizeForStore(text)`: the text with every secret replaced by `[REDACTED]`. Run it on anything the partner stores,
  indexes, logs, or sends to a model.
- `secretHits(text)`: the ids of the rules a text hits.
- `redact(value)` / `redactString(s)`: structural redaction of arbitrary JSON (tool inputs and outputs).

Comments still cite the memory era's decision ids (D13, A6 §2.2). Those documents are in
`archived/eden-memory/docs/memory-ship/`.

Upgrading the vendored rules: see `src/vendor/gitleaks/README.md`.
