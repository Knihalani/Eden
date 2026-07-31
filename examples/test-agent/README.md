# Eden Test Agent

Basic one-shot chat agent using **OpenAI SDK** against MiniMax's OpenAI-compatible API, instrumented with **eden-sdk** so traces land on prod Eden.

| Piece | Value |
| --- | --- |
| Framework | OpenAI Python SDK |
| LLM | MiniMax (`MiniMax-M3`) via OpenAI-compatible API |
| Observability | [`eden-sdk`](https://pypi.org/project/eden-sdk/) → `https://api.edenobservability.com` |
| Traces UI | [edenobservability.com/traces](https://edenobservability.com/traces) |

## Setup

```bash
cd examples/test-agent
cp .env.example .env
# Fill EDEN_ORG_ID, EDEN_API_KEY, MINIMAX_API_KEY

uv sync
```

## Run

```bash
uv run python agent.py
```

## Connectivity check

```bash
export EDEN_ORG_ID=... EDEN_API_KEY=...
uv run python -m eden_sdk.doctor
```
