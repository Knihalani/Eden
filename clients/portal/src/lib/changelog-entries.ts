/**
 * Product-facing changelog entries for edenobservability.com/changelog.
 *
 * Seeded from sdk/python/CHANGELOG.md, sdk/ts-ai/CHANGELOG.md,
 * docs/docs/intro/changelog.md, and the 0.4.2 / Aug 2026 wave ship
 * commits (prototype instrumentation, wire compression, portal surfaces).
 * Do not invent releases — only ship notes that already exist in docs/git.
 */

export type ChangelogSection = {
  heading: string;
  items: string[];
};

export type ChangelogEntry = {
  /** Stable id for anchors, e.g. `0-4-2`. */
  id: string;
  /** Display version label, e.g. `0.4.2`. */
  version: string;
  /** Human date shown on the page. */
  date: string;
  /** ISO date for sorting / time elements. */
  dateIso: string;
  /** One-line product summary. */
  summary: string;
  sections: ChangelogSection[];
};

/** Newest first. Marketing canonical lives here; docs keeps the eng log. */
export const CHANGELOG_ENTRIES: ChangelogEntry[] = [
  {
    id: "0-4-2",
    version: "0.4.2",
    date: "August 10, 2026",
    dateIso: "2026-08-10",
    summary:
      "SDK one-liner class-level instrumentation and faster wire compression, plus the August portal wave: topics, drift, red-team, labeling, and Improve supervision.",
    sections: [
      {
        heading: "SDKs",
        items: [
          "TypeScript `@eden-ai/sdk` 0.4.2 adds prototype-level (class-level) auto-instrumentation via `instrument({ autoPatch: true })` — the default. Supported frameworks (OpenAI / xAI, Anthropic, Groq, LangChain `BaseChatModel`, Gemini, Mistral) are patched once so every client constructed afterward is traced without per-call-site `wrap*()`. Vercel AI stays wrap-only because of ESM namespace immutability; pass `autoPatch: false` to keep the older wrap-only behavior.",
          "Both SDKs ship a zstd fast path for ingest POSTs (`Content-Encoding: zstd`) when the optional fast dependency is present, falling back to gzip level 1 for slim installs. The gateway already accepts both encodings, so existing deployments keep working.",
          "Python `eden-sdk` 0.4.2 syncs the published package version (including `client.py` `__version__`) and adds the matching wire-compression + fast JSON helpers used on the send hot path.",
        ],
      },
      {
        heading: "Portal",
        items: [
          "August strategic-review wave landed end-to-end: labeling unification (IAA, queues, human labels, active learning), Topics and Drift surfaces, Guardrails red-team, artifact demotion + team-context panels, Improve merge/revert plan dialogs, playgrounds as a canonical route, unified alert routing with suppression rules, retention archive watermark + S3 lifecycle UI, agent identity aliases, session summaries, and tool-call labels.",
          "UX deep-pass: relative human time and product vocabulary replace raw enums on secondary surfaces; skeleton loading replaces bare “Loading…” fallbacks across Suspense boundaries and the portal boot gate.",
        ],
      },
    ],
  },
  {
    id: "0-4-1",
    version: "0.4.1",
    date: "August 3, 2026",
    dateIso: "2026-08-03",
    summary:
      "Auth and offline-queue durability fixes so ModelAdvisor and replayed telemetry use the same org API-key scheme as ingest.",
    sections: [
      {
        heading: "SDKs",
        items: [
          "Python and TypeScript: `ModelAdvisor` now sends `X-Org-Api-Key` + `X-Org-Id` (matching telemetry ingest auth) instead of Bearer-only headers that failed against Eden’s org API-key scheme. TypeScript keeps Bearer for older proxies.",
          "TypeScript offline queue spill stores the full `eventToWire` envelope so replay preserves `eventId` / `traceId` / `eventType` / metrics (legacy nested-payload rows still reconstruct).",
          "Transient flush failures re-queue in memory when the offline queue is disabled, instead of silently dropping the batch.",
          "Queue overflow uses an index cursor instead of `Array.shift()` (O(n)).",
          "`http-capture` joins the active trace via `currentTrace()?.traceId`.",
        ],
      },
    ],
  },
  {
    id: "0-4-0",
    version: "0.4.0",
    date: "July 28, 2026",
    dateIso: "2026-07-28",
    summary:
      "Lockstep Python and TypeScript minor: native Cohere / Groq / Mistral instrumentation, offline queue, LlamaIndex.TS + xAI wrappers, and portal mobile chrome.",
    sections: [
      {
        heading: "SDKs",
        items: [
          "Versioned in lockstep — `eden-sdk` and `@eden-ai/sdk` share the same number and feature set so a polyglot codebase does not reason about two ladders. Registry publish dates may differ by a day or two; the version number is the contract.",
          "Native auto-instrumentation for Cohere, Groq, and Mistral clients (streaming + usage/token extraction), registered for lazy load / `detectInstalledFrameworks()` and returned from `instrument()` alongside OpenAI and Anthropic.",
          "Offline queue: events buffer when the ingest endpoint is unreachable and flush on the next successful call, so a transient network partition no longer silently drops telemetry.",
          "TypeScript: `wrapLlamaIndex` for LlamaIndex.TS query / chat / retrieve engines (`agent.run`, `source_format: \"llamaindex\"`, streaming chunks to `/ingest/chunks`).",
          "TypeScript: `wrapXai` for xAI (Grok) — OpenAI-compatible client with `provider: \"xai\"` stamped on telemetry; `api.x.ai` added to the HTTP-capture host-suffix list.",
          "TypeScript: `wrapBedrock` / `wrapGemini` are now auto-detected by `detectInstalledFrameworks()` and returned from `instrument()`. Composition guard prevents double-instrumentation when `wrapXai` and `wrapOpenAI` are layered.",
        ],
      },
      {
        heading: "Portal & platform",
        items: [
          "Mobile bottom nav, local-draft honesty banner, reactive catalog agents, and clearer unavailable layouts shipped with the July 31 deploy wave.",
          "Gateway telemetry moved off the response path; PII `amask` + literal prefilter; bounded background task drain; clusterer fan-out limits; archive S3 client reuse.",
        ],
      },
    ],
  },
  {
    id: "0-3-2",
    version: "0.3.2",
    date: "July 18, 2026",
    dateIso: "2026-07-18",
    summary:
      "Session-first SDKs, doctor CLIs, safer default redaction, gzip ingest, and docs/portal packaging for public beta.",
    sections: [
      {
        heading: "SDKs",
        items: [
          "Python `eden-sdk` 0.3.2 — Pydantic AI instrumentation, Bedrock + Gemini auto-instrumentation, HTTP capture, OTel bridge, logging forwarder, session-first API, `python -m eden_sdk.doctor` / `eden-doctor` CLI.",
          "TypeScript `@eden-ai/sdk` 0.3.2 — Mastra `wrapMastra`, HTTP capture, `detectInstalledFrameworks` + `wrap*` pattern (replaces broken `instrument()` global-patch docs), session API, `npx eden-doctor`.",
          "Breaking: client-side `redact_on_client` / `redactOnClient` now defaults to false. The gateway remains the authoritative PII layer; restore the old behaviour with config or `EDEN_REDACT_ON_CLIENT=1`.",
          "Streaming instrumentations omit chunk text by default (`capture_chunk_text` / `captureChunkText`); set the matching env flag to include token text on `/ingest/chunks`.",
          "Ingest POSTs use `Content-Encoding: gzip`. Multi-format batch flush runs concurrently; chunk flush retries honour `Retry-After`.",
          "TypeScript: `instrument()` no longer enables HTTP capture by default (avoids double-emit with `wrap*`). Pass `httpCapture: true` to opt in. `flush()` waits for in-flight POSTs then drains.",
          "Python: default `batch_size` is 50 (was 32), matching TypeScript; `install_logging()` defaults to WARNING; OTel exporter and native `instrument()` are mutually exclusive unless `allow_dual=True`.",
        ],
      },
      {
        heading: "Docs",
        items: [
          "Connect-any-agent three-tier instrumentation guide, agent sessions (F23) reference, failure fixtures export + local replay, security model (tenancy, encryption, audit).",
          "Quickstart Fill-in creates an API key into a runnable snippet when signed in. SDKs default to `https://api.edenobservability.com` (no `EDEN_BASE_URL` required).",
          "Auto-instrumentation matrix covers Pydantic AI, Bedrock, Gemini, Mastra, and HTTP capture tiers. Deploy guide points SDKs at `api.edenobservability.com`.",
        ],
      },
      {
        heading: "Portal",
        items: [
          "Settings hub for API keys, autonomy, and workspace. Eden MCP server soft-retired for free beta (docs/nav/keys hidden; transport flag off; code kept for internal/dev).",
        ],
      },
    ],
  },
  {
    id: "v1-7",
    version: "v1.7",
    date: "June 2026",
    dateIso: "2026-06-01",
    summary:
      "Diátaxis docs overhaul, full SDK and REST API reference, and platform focus on observability SDKs after retiring the jobs / env-gen pipeline.",
    sections: [
      {
        heading: "Docs",
        items: [
          "Massive docs overhaul restructured around the Diátaxis framework (tutorials / how-to / reference / explanation), replacing the ad-hoc guide tree with four dropdown sidebars.",
          "SDK reference — full pages for the two production SDKs (Python and TypeScript), plus an auto-instrumentation matrix covering every framework the SDKs patch.",
          "REST API reference — every endpoint formerly in `guide/api.md` moved into dedicated navigable pages (ingestion, traces, eval, cost, organization, error codes).",
          "How-to guides for auth, API keys, deploy, GitHub, PII policy, cost budgets, auto-instrument, judges, custom LLM providers, SSO, and webhooks.",
          "Explanation pages for architecture, data model, the 22 intelligence categories, security model, multi-tenancy, sampling, and retention.",
        ],
      },
      {
        heading: "Platform",
        items: [
          "Jobs feature removed. The async env-gen “jobs” pipeline (route handlers, pydantic models, DB tables, quota tracking, RBAC permissions, SDK exports) has been retired. Corresponding code, billing quotas, permissions, and docs references were deleted.",
          "The two production SDKs that remain — Python `eden-sdk` and TypeScript `@eden-ai/sdk` — focus on the observability + ingestion surface. Experimental language SDKs (Go / Rust) are not GA.",
          "Env-gen SDK packages deleted (`src/eden/sdk/` Python module and `sdk/ts/` TypeScript package). Remaining SDKs live under their top-level language folders in `sdk/`.",
        ],
      },
    ],
  },
];
