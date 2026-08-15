# Eden OpenRouter Smoke Agent

Local tool-calling agent + web dashboard that uses the **published** npm package [`@eden-ai/sdk`](https://www.npmjs.com/package/@eden-ai/sdk) and sends traces to **prod Eden**.

## What you get

- Local dashboard at `http://127.0.0.1:4173`
- Form fields for **OpenRouter API key**, **model id**, **Eden org id**, and **Eden API key**
- A real agent loop (LLM → tools → LLM) with:
  - `get_current_time`
  - `calculate`
  - `lookup_city`
  - `echo_json`
- Instrumentation via `configure` + `wrapOpenAI` + `begin` sessions + `trace`
- Ingest target: `https://api.edenobservability.com` (overrideable)

## Setup

```bash
cd examples/openrouter-smoke-agent
npm install
cp .env.example .env   # optional defaults
npm start
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173).

## Credentials

| Field | Where to get it | Required? |
| --- | --- | --- |
| OpenRouter API key | [openrouter.ai/keys](https://openrouter.ai/keys) | Yes (LLM) |
| Model id | e.g. `openai/gpt-4o-mini`, `anthropic/claude-sonnet-4` | Yes |
| Eden org id | [edenobservability.com](https://edenobservability.com) → org settings | **Yes** |
| Eden API key | same → API keys | **Yes** |

**Why both Eden org id and API key?** The key hash is unique in the DB, but
today’s ingest auth still requires `X-Org-Id` + `X-Org-Api-Key` together
(and the SDK builds `/orgs/{orgId}/ingest/...`). An API key alone is not
enough yet — that would need a deliberate key-only auth change on Eden.

You can paste everything in the dashboard, or set env vars from `.env.example`.

## Verify prod

1. Run a prompt that forces tools, e.g.  
   `What time is it UTC, and what is (19.5 + 2.5) * 3? Also look up Singapore.`
2. Confirm the turn events panel shows LLM rounds + tool calls.
3. Open [edenobservability.com/traces](https://edenobservability.com/traces) and find the session / LLM spans tagged `smoke` / `openrouter`.

Optional connectivity check:

```bash
export EDEN_ORG_ID=org_... EDEN_ORG_API_KEY=sk_eden_...
npx eden-doctor
```

## Notes

- This project intentionally depends on the **published** `@eden-ai/sdk` from npm, not the monorepo workspace build.
- Keys entered in the UI are posted only to this local server, which then calls OpenRouter and Eden.
- “Remember in this browser” stores values in `localStorage` on your machine.
