import {
  Activity,
  Eye,
  GitPullRequest,
} from "lucide-react";
import {
  DOCS_QUICKSTART_URL,
  FREE_TIER_ORG_CAP_USD,
  FREE_TIER_PERSONAL_CAP_USD,
  GATEWAY_URL,
} from "@/lib/constants";

/** Homepage marketing nav — trimmed to primary destinations.
 * In-page section anchors (Pillars / Improve) stay discoverable by
 * scroll; keeping them in the sticky bar crowded the row on md+. */
export const NAV_LINKS = [
  { label: "Install", href: "#install" },
  { label: "Pricing", href: "/pricing" },
  { label: "About", href: "/about" },
  { label: "Contact", href: "/contact" },
  { label: "Quickstart", href: DOCS_QUICKSTART_URL },
] as const;

export const PILLARS = [
  {
    id: "capture",
    icon: Eye,
    badge: "Capture",
    title: "One proxy. Every model.",
    description:
      "Drop-in SDKs and an OpenAI-compatible HTTP gateway. Point traffic at Eden once — every LLM call to OpenAI, Anthropic, Bedrock, or any OpenAI-compatible endpoint is captured, with PII pre-masked at ingest.",
    bullets: [
      "OpenAI-compatible gateway — base_url + org headers",
      "Native SDKs for Python and TypeScript (eden-sdk / @eden-ai/sdk)",
      "Decoders for OpenAI, Anthropic, Gemini, Bedrock, LangChain, LlamaIndex, Vercel AI SDK",
    ],
  },
  {
    id: "analyse",
    icon: Activity,
    badge: "Analyse",
    title: "Traces, cost, and evals in one workspace.",
    description:
      "Multi-tenant org workspace for traces, latency, spend, and eval scores. Drill from a regression into the spans that caused it. A cited AI assistant lives in every view — answers point at real trace IDs and eval records.",
    bullets: [
      "Time-series + drill-down for traces, tokens, cost, eval regressions",
      "Multi-tenant orgs with RBAC and audit log",
      "Export to JSONL/CSV, scheduled S3/GCS, webhook delivery",
    ],
  },
  {
    id: "improve",
    icon: GitPullRequest,
    badge: "Improve",
    title: "Patch drafts you review before anything ships.",
    description:
      "When judge scores drift, Eden clusters failing traces, drafts a patch, and runs your evals. Suggestions land in an inbox — a human opens the PR. Eden never opens a PR on its own.",
    bullets: [
      "PR-suggestion inbox — trace-driven drafts; you open the PR",
      "Deterministic + LLM-as-judge evals, regression alerts, golden-dataset replays",
      "Cost budgets, PII redaction, RBAC, audit log",
    ],
  },
] as const;

export const INSTALL_BLOCKS = [
  {
    id: "gateway",
    label: "Gateway",
    hint: "Fastest path — base_url + X-Org-Id / X-Org-Api-Key",
    code: `import os
from openai import OpenAI

client = OpenAI(
    base_url="${GATEWAY_URL}",  # Eden gateway
    api_key=os.environ["EDEN_API_KEY"],  # OpenAI SDK requires a value
    default_headers={
        "X-Org-Id": os.environ["EDEN_ORG_ID"],
        "X-Org-Api-Key": os.environ["EDEN_API_KEY"],
    },
)

resp = client.chat.completions.create(
    model="gpt-4o",  # any upstream: OpenAI, Anthropic, Bedrock…
    messages=[{"role": "user", "content": "Hello"}],
)`,
  },
  {
    id: "python",
    label: "Python",
    hint: "pip install eden-sdk · configure → instrument",
    code: `pip install eden-sdk

import os
import eden

eden.configure(
    api_key=os.environ["EDEN_API_KEY"],
    org_id=os.environ["EDEN_ORG_ID"],
)
eden.instrument()

# OpenAI / Anthropic / LangChain calls are traced.
# Validate: python -m eden_sdk.doctor`,
  },
  {
    id: "typescript",
    label: "TypeScript",
    hint: "npm install @eden-ai/sdk · configure → instrument",
    code: `npm install @eden-ai/sdk openai

import OpenAI from "openai";
import { configure, instrument, getDefaultClient } from "@eden-ai/sdk";

configure({
  orgId: process.env.EDEN_ORG_ID!,
  apiKey: process.env.EDEN_API_KEY!,
});

const { wrapOpenAI } = instrument();
const openai = wrapOpenAI(new OpenAI());
await openai.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "Hello" }],
});
await getDefaultClient().flush();

// Validate: npx eden-doctor`,
  },
] as const;

/** Honest soft-launch facts — kept for reuse; hero first-viewport omits KPI theatre. */
export const HERO_METRICS = [
  { kpi: "$1/$3", unit: "spend caps", label: "Free tier" },
  { kpi: "1-line", unit: "swap", label: "Drop-in gateway" },
  { kpi: "<5ms", unit: "p99", label: "SDK overhead" },
] as const;

export const ASSISTANT_TURNS = [
  {
    role: "user" as const,
    body: "Why did latency spike on Tuesday for project copilot-prod?",
  },
  {
    role: "assistant" as const,
    body:
      "Latency p95 went from 1.2s → 2.4s on Tuesday 14:00 UTC, driven by a regression in planner.v3 — 2,400 traces with multi-step tool loops. An Improve draft is queued for review; open the PR only if you accept it.",
    cites: ["trace_8a3f…", "trace_8b12…", "trace_8c44…"],
  },
] as const;

export const FAQS = [
  {
    q: "What is Eden?",
    a: "Eden is an observability and improvement platform for AI agents and LLM apps. Capture every call through an OpenAI-compatible gateway or drop-in SDK, analyse traces and evals in a multi-tenant workspace, and review human-gated patch suggestions when scores drift.",
  },
  {
    q: "Gateway vs SDK — which do I use?",
    a: "Use the gateway when you can point an OpenAI-compatible client at Eden's base_url and send X-Org-Id + X-Org-Api-Key (default_headers, or eden_sdk.openai_client()) — no separate instrumentation package required. Use the SDK (eden-sdk / @eden-ai/sdk) when you want native spans for Python or TypeScript frameworks. Both write the same traces; pick one path to first capture.",
  },
  {
    q: "What does the free tier include?",
    a: `Soft launch is free — no credit card. Caps are $${FREE_TIER_PERSONAL_CAP_USD}/mo LLM spend on a personal workspace (1 seat) and $${FREE_TIER_ORG_CAP_USD}/mo on an org workspace (up to 3 seats). Paid Team / Pro plans are not available yet.`,
  },
  {
    q: "Does PII get stored?",
    a: "PII is masked at ingest using your redaction rules. You can opt out of raw payload retention entirely; structured metadata is enough to run the product.",
  },
  {
    q: "How fast is the first trace?",
    a: `Create an account, copy an API key from Settings → API keys, then either point your OpenAI client at the Eden gateway or install the SDK and call instrument/wrap. Send one chat completion — the Traces view typically shows it within a few seconds. Docs: ${DOCS_QUICKSTART_URL}.`,
  },
  {
    q: "Does Eden open PRs automatically?",
    a: "No. When a regression is detected, the Improve inbox queues a draft patch with failing traces, root cause, and eval results. A human clicks Open PR — Eden never opens a PR on its own.",
  },
] as const;

/** Span rows for the hero Traces explorer mock. */
export const TRACE_MOCK_SPANS = [
  {
    id: "root",
    depth: 0,
    name: "agent.run",
    model: "—",
    latency: "1.42s",
    cost: "$0.00061",
    status: "ok" as const,
    live: false,
  },
  {
    id: "llm",
    depth: 1,
    name: "chat.completions",
    model: "gpt-4o-mini",
    latency: "1.18s",
    cost: "$0.00042",
    status: "ok" as const,
    live: true,
  },
  {
    id: "tool",
    depth: 1,
    name: "tool.search",
    model: "—",
    latency: "180ms",
    cost: "—",
    status: "ok" as const,
    live: false,
  },
  {
    id: "judge",
    depth: 1,
    name: "eval.quality",
    model: "judge.v2",
    latency: "62ms",
    cost: "$0.00019",
    status: "fail" as const,
    live: false,
    failDetail: "score 0.61 · threshold 0.80",
  },
] as const;
