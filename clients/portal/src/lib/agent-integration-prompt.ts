/**
 * Integration prompt for coding agents.
 *
 * The quickstart snippet in `quickstart-snippets.ts` is a hello-world: it
 * proves credentials work. This is the other half — a brief a coding agent
 * can execute against a real repository it has never seen.
 *
 * Written as instructions rather than a persona. The failure mode for a
 * prompt like this is an agent that edits confidently, reports success, and
 * never checks whether a trace actually arrived, so the verification step is
 * explicit and the report-back asks for evidence rather than a summary.
 */

export type IntegrationPromptCreds = {
  apiKey?: string | null;
  orgId?: string | null;
};

/** Matches the placeholder convention in `buildQuickstartSnippet`. */
const API_KEY_PLACEHOLDER = "<your-api-key>";
const ORG_ID_PLACEHOLDER = "<your-org-id>";

export function buildAgentIntegrationPrompt(
  creds: IntegrationPromptCreds,
): string {
  const key = creds.apiKey || API_KEY_PLACEHOLDER;
  const org = creds.orgId || ORG_ID_PLACEHOLDER;

  return `Integrate Eden observability into this codebase.

Eden captures traces, spans, token cost, and failures from LLM and agent
code. Instrument this repository so its LLM activity is visible in Eden,
then prove a trace actually arrived. Do not report success without that
proof.

## Credentials

Already provisioned. Use these exact values; do not mint new ones.

- EDEN_ORG_ID=${org}
- EDEN_API_KEY=${key}

## Step 1 — Survey before editing

Report what you find before you change anything:

- Language, package manager, and how the app is run.
- Every LLM or agent framework in use. Eden has direct support for OpenAI,
  Anthropic, xAI, Bedrock, Gemini, Groq, Cohere, Mistral, LangChain,
  LlamaIndex, Vercel AI SDK, and Mastra.
- The process entry points, and whether it is a long-lived server, a
  serverless handler, a CLI, or a batch job. This determines where init
  goes and how flushing must work.
- How configuration and secrets are loaded today.

If the repo uses no LLM SDK at all, stop and say so.

## Step 2 — Install

- TypeScript/JavaScript: \`@eden-ai/sdk\`
- Python: \`eden-sdk\`, with extras matching what you found, e.g.
  \`eden-sdk[openai,langchain]\`

Use the package manager already in the repo. Do not switch it.

## Step 3 — Configure through the environment

Add the two credentials to whatever secret mechanism the repo already uses
(.env file, secret manager, CI variables) and add both names to
.env.example with empty values.

Do not hardcode the key in source. Do not commit it. If the .env file is
not already git-ignored, ignore it.

## Step 4 — Initialize once, at the entry point

Call configure and instrument before any LLM client is constructed —
instrumentation patches SDKs in place, so a client built earlier is missed.

TypeScript:
\`\`\`ts
import { configure, instrument } from "@eden-ai/sdk";

configure({
  apiKey: process.env.EDEN_API_KEY,
  orgId: process.env.EDEN_ORG_ID,
});
const { wrapOpenAI } = instrument();
\`\`\`

Python:
\`\`\`python
import os
import eden

eden.configure(
    api_key=os.environ["EDEN_API_KEY"],
    org_id=os.environ["EDEN_ORG_ID"],
)
eden.instrument()
\`\`\`

In serverless or multi-worker runtimes, initialize once per cold start at
module scope — not per request.

## Step 5 — Wrap clients auto-instrumentation cannot reach

Python's \`eden.instrument()\` patches supported libraries in place and
usually needs nothing further.

In TypeScript, \`instrument()\` returns wrappers — \`wrapOpenAI\`,
\`wrapAnthropic\`, \`wrapVercelAI\`, \`wrapLangChain\`, \`wrapMastra\`,
\`wrapBedrock\`, \`wrapGemini\`, \`wrapGroq\`, \`wrapCohere\`,
\`wrapMistral\`, \`wrapLlamaIndex\`, \`wrapXai\`. Apply the relevant one at
each client construction site:

\`\`\`ts
const openai = wrapOpenAI(new OpenAI());
\`\`\`

## Step 6 — Name the meaningful units of work

Wrap each top-level agent task or multi-step chain so traces group into
runs a human can reason about:

\`\`\`ts
await trace("checkout-support-agent", async (ctx) => {
  ctx.setInput({ question });
  const answer = await run(question);
  ctx.setOutput({ answer });
  return answer;
});
\`\`\`

\`\`\`python
@eden.trace_agent(name="checkout-support-agent")
def handle(question: str) -> str:
    ...
\`\`\`

Use the domain names the team already uses. Do not wrap every function —
trace the units someone would want to debug, typically one per request,
job, or agent run.

## Step 7 — Flush before exit

Telemetry is batched, so a process that exits immediately loses it. In
scripts, serverless handlers, and tests, flush before returning:
\`getDefaultClient().flush()\` in TypeScript,
\`eden.get_default_client().flush()\` in Python. Long-lived servers should
flush on shutdown.

## Step 8 — Verify, and do not skip this

1. Run the doctor: \`npx eden-doctor\` or \`python -m eden_sdk.doctor\`.
   It checks credentials and connectivity. It must pass.
2. Exercise one real code path that calls an LLM.
3. Confirm the trace appears at https://edenobservability.com/traces.

If nothing arrives, re-run with EDEN_DEBUG=1 and report what you saw.
Common causes, in order: instrument() ran after the client was built, the
process exited before flushing, or the credentials never reached the
runtime environment.

## Constraints

- Instrumentation is additive. Do not change existing behaviour, error
  handling, retries, or control flow.
- Do not upgrade or add unrelated dependencies.
- Do not disable, loosen, or suppress type checking or lint rules.
- If the repo has tests, run them and confirm they still pass.
- If a framework here has no Eden integration, say so rather than
  improvising one.

## Report back

- Files changed, and where initialization was placed.
- Which units of work you traced, and why those.
- Doctor output.
- Whether you confirmed a trace was received. If not, what you observed.`;
}
