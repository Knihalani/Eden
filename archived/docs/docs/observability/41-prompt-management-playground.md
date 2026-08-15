---
title: "41 — Prompt management + Playground (Phase I)"
status: IMPLEMENTED v1
last_updated: 2026-06-17
version: 1.0
---

# 41 — Prompt management + Playground (Phase I)

> **Status:** ✅ **IMPLEMENTED v1** (shipped 2026-06-17).
> Closes the Logfire "prompt management" + RagaAI "playground"
> gap. Two surfaces:
>  1. **Prompt registry** — versioned prompt templates
>     (system + user + tool definitions) with strict
>     ``compile()`` that validates required params.
>  2. **Playground** — interactive testing of a prompt
>     against the LLM with side-by-side model comparison.
> ~620 LOC backend + 28 unit tests.

## Goal & motivation

Logfire's prompt management is the headline feature on
the "developer experience" side. The user defines prompts
as versioned templates, the system compiles them with
strict validation, and the playground lets the user
test the template against any model tier + see the
results side-by-side.

Eden's Cat 12 experimentation surface (Bayesian A/B
testing, promotion logic) consumes prompts as strings.
Phase I gives the user a structured place to author
those strings — with versioning, rollback, and a
playground for "what does this look like to the model?".

## What's in Eden

### Prompt templates

A :class:`PromptTemplate` has:

  * **system** / **user** — the prompt body. The user
    body supports ``{{param}}`` placeholders.
  * **tools** — optional list of JSON-Schema tool
    definitions. The compiled prompt passes them to the
    LLM as the ``tools`` field.
  * **required_params** / **optional_params** — the
    compile step rejects missing required params and
    unknown params (catches typos at the boundary).
  * **model** — the default model identifier (T1/T2/T3/T4
    tier name, or a specific model id).
  * **temperature** / **max_tokens** — sampling knobs.
  * **description** — human-readable.
  * **version** — monotonic; auto-increments on update.

### Compile

The compile step:

  1. Checks that every required param is supplied.
  2. Checks that no unknown params are supplied (typos
     like ``lengthh`` instead of ``length`` are caught).
  3. Substitutes every ``{{name}}`` with
     ``str(params[name])``.

Failure modes raise typed exceptions
(:class:`PromptCompileError` /
:class:`PromptUnknownParamError`) so the route layer
returns 400 with a clear message.

### Versioning + rollback

The :class:`PromptRegistry` is in-memory. The user
registers a template; the version starts at 1. On
``update()``, the version bumps (2, 3, 4, ...). The
audit trail is preserved: every version is retained.

``rollback(name, to_version)`` restores a previous
version's content as a NEW version. This is intentional:
the audit trail is preserved (you can see "we rolled
back to v3 on 2026-06-17") AND the live version is
incremented. The user can roll forward again by
re-updating.

### Playground

The :class:`Playground` takes a template + params and
runs the compiled prompt against the LLM. The unit-
testable surface uses a stub handler; production wires
the real :class:`ModelRouter`.

The :meth:`Playground.compare` method runs the same
prompt against two models and returns both results
side-by-side. The user picks a "primary" model in the
template, supplies a "comparison" model in the request,
and the playground returns both responses. The UI
(Phase E) renders them in a diff view.

### Routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/orgs/{org}/prompts` | yes | Register a template |
| `GET` | `/orgs/{org}/prompts` | yes | List template names |
| `GET` | `/orgs/{org}/prompts/{name}` | yes | Get latest version |
| `PATCH` | `/orgs/{org}/prompts/{name}` | yes | Bump to a new version |
| `GET` | `/orgs/{org}/prompts/{name}/versions` | yes | List all versions |
| `POST` | `/orgs/{org}/prompts/{name}/rollback/{version}` | yes | Rollback |
| `POST` | `/orgs/{org}/prompts/{name}/playground` | yes | Run against the LLM |
| `POST` | `/orgs/{org}/prompts/{name}/compare` | yes | Run against two models |

## Example session

```bash
# Register a template.
curl -X POST -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
     -d '{
       "name": "summarise",
       "system": "You are a helpful summariser.",
       "user": "Summarise the following text in {{length}} words:\n\n{{text}}",
       "required_params": ["text", "length"],
       "model": "t2",
       "temperature": 0.3,
       "max_tokens": 256,
       "description": "Generic text summarisation"
     }' \
     https://app.eden.example/orgs/myorg/prompts
# {"name": "summarise", "version": 1, ...}

# Update to a new version.
curl -X PATCH -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
     -d '{"user": "TLDR in {{length}} words:\n\n{{text}}", "temperature": 0.0}' \
     https://app.eden.example/orgs/myorg/prompts/summarise
# {"name": "summarise", "version": 2, "user": "TLDR in {{length}} words:...", ...}

# Run in the playground.
curl -X POST -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
     -d '{
       "params": {"text": "Eden is an AI agent observability platform...", "length": 50}
     }' \
     https://app.eden.example/orgs/myorg/prompts/summarise/playground
# {
#   "template_name": "summarise", "template_version": 2,
#   "model": "t2", "response": "Eden is an observability platform...",
#   "latency_ms": 1234, "prompt_tokens": 87, "completion_tokens": 51,
#   "cost_usd": 0.000123
# }

# Compare two models.
curl -X POST -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
     -d '{
       "params": {"text": "Eden is...", "length": 50},
       "model_b": "t3"
     }' \
     https://app.eden.example/orgs/myorg/prompts/summarise/compare
# {
#   "a": {"model": "t2", "response": "..."},
#   "b": {"model": "t3", "response": "..."}
# }

# Rollback to v1.
curl -X POST -H "Authorization: Bearer $JWT" \
     https://app.eden.example/orgs/myorg/prompts/summarise/rollback/1
# {"name": "summarise", "version": 3, "user": "Summarise the following text in {{length}} words:...", ...}
```

## RagaAI / Logfire parity matrix

| Logfire/RagaAI feature | Eden Phase I | Notes |
|---|---|---|
| Versioned templates | ✅ PromptRegistry | In-memory; DB in I.5 |
| Strict compile() | ✅ compile_template | Validates required + unknown params |
| Param substitution | ✅ {{name}} | Jinja-like |
| Tool definitions | ✅ PromptTemplate.tools | JSON-Schema dicts |
| Model + temperature + max_tokens | ✅ per-template | Plus per-call overrides |
| Playground (single model) | ✅ POST /playground | Stub handler in v1 |
| Multi-model comparison | ✅ POST /compare | Side-by-side results |
| Rollback | ✅ POST /rollback/{version} | Audit trail preserved |
| Version history | ✅ GET /versions | Sorted list |
| DB-backed templates | 🟡 in-memory v1; DB in I.5 | Same API |
| Playground cost tracking | 🟡 cost_usd field | Wires to ModelRouter in I.5 |
| Token counting | 🟡 prompt_tokens/completion_tokens | Per-call result |
| A/B testing on a template | ❌ deferred | Cat 12 (Bayesian recommender) |
| Custom validators | ❌ deferred | "length must be > 0" etc. |
| Tagging / search | ❌ deferred | Phase E (UI polish) |

## What's NOT in this phase (deferred)

- **DB-backed registry** — the v1 is in-memory. Phase I.5
  wires Postgres + multi-tenant isolation.
- **Production LLM handler** — the v1 uses a stub. Phase
  I.5 wires the real :class:`ModelRouter` with token +
  cost tracking.
- **A/B testing on a template** — pairs with Cat 12
  (Bayesian experiment recommender). The template
  becomes the "treatment"; the experiment measures which
  version gets the most upvotes / fewest bad responses.
- **Custom validators** — "this param must be a positive
  integer" or "this param must be one of {a, b, c}". The
  compile step is generic; custom validation is a future
  cat.
- **Tagging + search** — "show me all templates tagged
  'rag'". A search route is a Phase E (UI polish) item.

## Failure modes

| Failure | Behaviour |
|---|---|
| Missing required param | 400 with `PromptCompileError` |
| Unknown param (typo) | 400 with `PromptUnknownParamError` |
| Register duplicate name | 409 (already exists) |
| Update non-existent template | 409 (update_failed) |
| Rollback to non-existent version | 404 |
| Template not found | 404 |
| Empty params + required params | 400 (compile_failed) |
| Compare with same model twice | Returns the same model on both sides; the user is responsible for choosing distinct models |

## Telemetry

- `prompt.template.registered` (counter)
- `prompt.template.updated` (counter)
- `prompt.template.rolled_back` (counter)
- `prompt.playground.run` (counter) — fires per playground call
- `prompt.playground.compare` (counter) — fires per compare call
- `prompt.playground.latency_ms` (histogram) — per-call latency

These flow into the same pipeline as LLM spans.

## Tests

28 unit tests in `tests/unit/test_prompts.py`:

- `TestExtractPlaceholders` (3) — empty, single, multiple + dedup
- `TestSubstitute` (3) — replaces, missing leaves alone, stringifies
- `TestCompileTemplate` (5) — happy, missing raises, unknown
  raises, tools + temp pass through, empty params
- `TestPromptRegistry` (8) — register, duplicate raises,
  get latest, get specific version, update bumps, rollback
  creates new version, list versions, list names, delete
- `TestPlayground` (5) — default handler, annotates
  template metadata, compare, custom handler, compile error
  propagates
- `TestDataclass` (3) — to_dict round-trips

All 28 pass; 0 regressions in the existing unit suite
(731/731 total across new modules).

## Cross-references

- [Cat 12 — Experimentation Intelligence](12-experimentation-intelligence.md)
  — the A/B testing surface that consumes the prompt
  versions.
- [Phase C — Unified AI Agent](14-autonomous-intelligence.md)
  — the agent that can use the playground to test its
  own system prompts.
- [Phase S — Dataset-as-Spreadsheet](40-dataset-spreadsheet.md)
  — the destination for prompt outputs (the user can
  save playground results to a dataset).
- [Cat 14 — Autonomous Intelligence](14-autonomous-intelligence.md)
  — the SelfHealer can use the playground to test fixes
  before deploying.
