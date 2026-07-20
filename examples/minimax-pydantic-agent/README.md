# Eden MiniMax + Pydantic AI Agent

A real tool-calling agent built with **[Pydantic AI](https://ai.pydantic.dev/)**, powered by **MiniMax** via its OpenAI-compatible API, and observed by **prod Eden**.

| Piece | Value |
| --- | --- |
| Framework | Pydantic AI |
| LLM | MiniMax (`MiniMax-M3`) @ `https://api.minimax.io/v1` |
| Observability | [`eden-sdk`](https://pypi.org/project/eden-sdk/) → `https://api.edenobservability.com` |
| Docs | [docs.edenobservability.com/quickstart](https://docs.edenobservability.com/quickstart) |
| Traces UI | [edenobservability.com/traces](https://edenobservability.com/traces) |

## Tools

- `get_current_time` — UTC ISO + unix seconds
- `calculate` — simple arithmetic
- `lookup_city` — tiny built-in directory (Singapore, SF, London, Tokyo, Berlin)

## Setup

```bash
cd examples/minimax-pydantic-agent
cp .env.example .env
# Edit .env: MINIMAX_API_KEY, EDEN_ORG_ID, EDEN_API_KEY

uv sync
# Uses the monorepo sdk/python via [tool.uv.sources].
# Standalone: pip install "eden-sdk[pydantic_ai,openai]" pydantic-ai openai python-dotenv
```

## Run

```bash
uv run python agent.py
```

Optional one-shot prompt:

```bash
AGENT_PROMPT="Calculate 7 * 8 and look up Tokyo." uv run python agent.py
```

You should see tool use in the terminal, then a new session/spans under Traces tagged `smoke` / `minimax` / `pydantic-ai`.

## Connectivity check

```bash
export EDEN_ORG_ID=... EDEN_API_KEY=...
uv run python -m eden_sdk.doctor
```

## Notes

- Secrets live only in `.env` (gitignored). Never commit real keys.
- Eden ingest still needs **both** org id and API key (`X-Org-Id` + `X-Org-Api-Key`).
- MiniMax is wired as an OpenAI-compatible client (`OpenAIChatModel` + `OpenAIProvider`).
