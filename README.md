# Eden

**Eden is the observability + improvement platform for AI agents and LLM apps.** Comparable to Helicone or Langfuse for the observability layer, with a closed-loop improvement layer they don't have. Delivered as two pillars:

1. **Observability** — drop-in SDKs (Python, TypeScript) and an **OpenAI-compatible HTTP gateway** that proxies every request to whichever upstream model you configure (OpenAI, Anthropic, Bedrock, self-hosted).
2. **Web platform** — org management, trace/eval visualisations, data export, and a persistent AI assistant sidebar in every view.

The two pillars close the loop: capture, analyse, improve.

## Quickstart — Gateway (5-minute integration)

The fastest path to Eden is the OpenAI-compatible gateway. Change one line in your existing OpenAI SDK call:

```bash
pip install openai  # you probably already have this
export EDEN_API_KEY="..."
```

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://gateway.eden.example/v1",  # <-- the only line that changes
    api_key=os.environ["EDEN_API_KEY"],
)

resp = client.chat.completions.create(
    model="gpt-4o",  # any upstream you want: OpenAI, Anthropic, Bedrock, self-hosted
    messages=[{"role": "user", "content": "Hello"}],
)
```

Every call is now captured, traced, and made queryable in the web portal — with no other code changes. Visit the portal to see your first trace within 30 seconds.

## Quickstart — SDKs (advanced capture)

For multi-step agents, tool calls, and custom evaluations, use the Eden SDKs:

```bash
# Python
pip install eden-sdk

# TypeScript
npm install @eden/sdk
```

```python
import eden

# Wrap any LLM call to capture a span
with eden.span("agent.reasoning") as span:
    resp = client.chat.completions.create(...)
    span.set_output(resp.choices[0].message.content)
    span.set_eval("quality", score=0.92, evaluator="llm-judge")
```

## Quickstart — Self-host / Local dev

```bash
# Install the platform
git clone https://github.com/eden/eden.git
cd eden
cp .env.example .env

# Start infrastructure
docker compose -f docker/docker-compose.yml up -d

# Run the API + gateway
python -m eden.api.app
```

## Architecture

```
                  UPSTREAM MODELS
   OpenAI  Anthropic  Bedrock  Self-hosted  …
                  ▲           ▲
                  │           │
   your code ────►│           │──── Eden Gateway (OpenAI-compat)
   your SDKs      │           │         │
                  │           ▼         ▼
                  │     +-------------------+
                  │     |  Trace Ingestion  |  (7+ source decoders, PII pre-mask)
                  │     +---------+---------+
                  │               |
                  │               ▼
                  │     +-------------------+      +-----------------------+
                  │     |   Knowledge Base  |◄-----|  Web Platform         |
                  │     | (temporal graph + |      |  (org, viz, export,   |
                  │     |  episodic, vector)|      |   AI assistant)       |
                  │     +---------+---------+      +-----------+-----------+
                  │               ▲                            |
                  │               |   reads / proposes         | asks questions
                  │               +----------------------------+
                  │               |
                  │               ▼
                  │     +-------------------+
                  │     |  Web Platform     |  trace viz, eval, export
                  │     |  (Next.js)        |  AI assistant sidebar
                  │     +-------------------+
                  │
```

## Project Structure

```
eden/
├── src/eden/
│   ├── gateway/                 # OpenAI-compat HTTP proxy (Pillar 1)
│   │   ├── app.py               # FastAPI app
│   │   ├── adapters/            # Per-upstream forwarders (OpenAI, Anthropic, Bedrock, …)
│   │   └── streaming.py         # SSE passthrough
│   ├── ingest/                  # Multi-format trace ingestion (Pillar 1)
│   │   ├── decoders/            # OpenAI, Anthropic, Gemini, Bedrock, LangChain, …
│   │   └── pii.py               # Pre-mask
│   ├── sdk/                     # Python SDK (Pillar 1, advanced capture)
│   │   ├── span.py
│   │   ├── eval.py
│   │   └── context.py
│   ├── portal_api/              # API surface for the web platform (Pillar 2)
│   │   ├── orgs/
│   │   ├── projects/
│   │   ├── traces/
│   │   ├── evals/
│   │   ├── export/
│   │   └── assistant/           # Persistent AI assistant
│   ├── kb/                      # Knowledge Base (shared across pillars)
│   │   ├── episodic/            # PostgreSQL trace/eval/attempt records
│   │   ├── semantic/            # Temporal knowledge graph
│   │   ├── procedural/          # Skill Library
│   │   └── regression/          # Regression / exploit probes
│   ├── storage/                 # PostgreSQL + Qdrant clients
│   └── llm/                     # OpenRouter client
├── web/portal/                  # Next.js web platform (Pillar 2)
├── migrations/                  # Database schema
├── docker/                      # docker-compose for infrastructure
└── tests/
```

## Configuration

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

Key settings:
- `EDEN_API_KEY` — your Eden API key
- `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `BEDROCK_*` — upstream model credentials (configure whichever upstreams you want to use through the gateway)
- `POSTGRES_*` — PostgreSQL connection settings
- `QDRANT_*` — Qdrant connection settings
- `GATEWAY_BASE_URL` — public URL of your Eden gateway

## API

```bash
# Direct trace query (advanced; most users start via the SDK/gateway)
curl -X POST https://gateway.eden.example/v1/chat/completions \
  -H "Authorization: Bearer $EDEN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Hello"}]
  }'

# List recent traces
curl "https://api.eden.example/v1/traces?project_id=..." \
  -H "Authorization: Bearer $EDEN_API_KEY"
```

## Development

```bash
# Run tests
pytest

# Type checking
mypy src/eden

# Linting
ruff check src/eden

# Web platform
cd clients/portal && bun install && bun run dev
```

## Documentation

See [PRD.md](./PRD.md) for the full product requirements document and roadmap.
