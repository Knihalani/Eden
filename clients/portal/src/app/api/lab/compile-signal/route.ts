import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import {
  COMPILE_SYSTEM_PROMPT,
  T3_PRIMARY_MODEL,
  compileNaturalLanguageFallback,
  type CompiledSignalDraft,
} from "@/lab/signal-compile";

export const maxDuration = 60;

type Body = {
  prompt?: string;
};

/** In-flight / short TTL dedupe so double-clicks don't double-bill OpenRouter. */
const _compileInflight = new Map<string, Promise<Response>>();
const _compileCache = new Map<
  string,
  { at: number; body: Record<string, unknown> }
>();
const COMPILE_CACHE_TTL_MS = 60_000;

/** Per-user sliding window: 20 compiles / hour (Wave 4 cost control). */
const COMPILE_RATE_LIMIT = 20;
const COMPILE_RATE_WINDOW_MS = 60 * 60 * 1000;
const _compileRateByUser = new Map<string, number[]>();

function checkCompileRateLimit(userId: string): boolean {
  const now = Date.now();
  const windowStart = now - COMPILE_RATE_WINDOW_MS;
  const prior = (_compileRateByUser.get(userId) ?? []).filter(
    (t) => t > windowStart,
  );
  if (prior.length >= COMPILE_RATE_LIMIT) {
    _compileRateByUser.set(userId, prior);
    return false;
  }
  prior.push(now);
  _compileRateByUser.set(userId, prior);
  // Bound map growth in long-lived serverless isolates.
  if (_compileRateByUser.size > 5_000) {
    for (const [uid, times] of _compileRateByUser) {
      const kept = times.filter((t) => t > windowStart);
      if (kept.length === 0) _compileRateByUser.delete(uid);
      else _compileRateByUser.set(uid, kept);
    }
  }
  return true;
}

/** Tenant-scoped so one org/user cannot reuse another’s compile cache. */
function cacheKey(userId: string, orgId: string, prompt: string): string {
  return `${userId}:${orgId}:${prompt.trim().toLowerCase().slice(0, 500)}`;
}

function parseDraft(raw: string, prompt: string): CompiledSignalDraft | null {
  try {
    const cleaned = raw
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    const data = JSON.parse(cleaned) as Partial<CompiledSignalDraft>;
    if (!data.name || !data.watching || !data.condition) return null;
    const kind = data.kind ?? "custom";
    const severity = data.severity ?? "error";
    if (!["error", "latency", "cost", "policy", "custom"].includes(kind)) {
      return null;
    }
    if (!["critical", "error", "warn"].includes(severity)) return null;
    return {
      name: String(data.name).slice(0, 80),
      description: String(data.description || prompt).trim(),
      kind,
      severity,
      condition: String(data.condition),
      watching: String(data.watching),
      model: T3_PRIMARY_MODEL,
      tier: "t3",
    };
  } catch {
    return null;
  }
}

async function compileSignalOnce(prompt: string): Promise<NextResponse> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const baseUrl =
    process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";

  if (!apiKey) {
    const draft = compileNaturalLanguageFallback(prompt);
    return NextResponse.json({
      draft,
      source: "fallback",
      reason: "OPENROUTER_API_KEY not configured",
    });
  }

  try {
    const upstream = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL || "https://eden.dev",
        "X-Title": "Eden Lab — Signal compile (T3)",
      },
      body: JSON.stringify({
        model: T3_PRIMARY_MODEL,
        temperature: 0.2,
        messages: [
          { role: "system", content: COMPILE_SYSTEM_PROMPT },
          {
            role: "user",
            content: `Create an Eden signal from this request:\n\n${prompt}`,
          },
        ],
      }),
    });

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => upstream.statusText);
      const draft = compileNaturalLanguageFallback(prompt);
      return NextResponse.json({
        draft,
        source: "fallback",
        reason: `T3 upstream ${upstream.status}: ${detail.slice(0, 200)}`,
      });
    }

    const payload = (await upstream.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content ?? "";
    const draft = parseDraft(content, prompt);
    if (!draft) {
      return NextResponse.json({
        draft: compileNaturalLanguageFallback(prompt),
        source: "fallback",
        reason: "T3 response was not valid JSON",
      });
    }

    return NextResponse.json({ draft, source: "t3", model: T3_PRIMARY_MODEL });
  } catch (err) {
    const draft = compileNaturalLanguageFallback(prompt);
    return NextResponse.json({
      draft,
      source: "fallback",
      reason: err instanceof Error ? err.message : "compile failed",
    });
  }
}

/**
 * Compile a natural-language signal via Eden internal chat model
 * (OpenRouter: deepseek/deepseek-v4-flash-0731). Falls back locally if unset/unreachable.
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session.userId) {
    return NextResponse.json({ detail: "Unauthorized" }, { status: 401 });
  }
  // Require an active Clerk org membership (not personal-account mode).
  if (!session.orgId) {
    return NextResponse.json(
      { detail: "Organization membership required" },
      { status: 403 },
    );
  }
  if (!checkCompileRateLimit(session.userId)) {
    return NextResponse.json(
      { detail: "Rate limit exceeded: 20 compiles per hour" },
      { status: 429, headers: { "Retry-After": "3600" } },
    );
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ detail: "Invalid JSON" }, { status: 400 });
  }

  const prompt = body.prompt?.trim() ?? "";
  if (!prompt) {
    return NextResponse.json({ detail: "prompt is required" }, { status: 400 });
  }

  const key = cacheKey(session.userId, session.orgId, prompt);
  const cached = _compileCache.get(key);
  if (cached && Date.now() - cached.at < COMPILE_CACHE_TTL_MS) {
    return NextResponse.json(cached.body);
  }

  const existing = _compileInflight.get(key);
  if (existing) {
    return existing.then((r) => r.clone());
  }

  const run = (async (): Promise<Response> => {
    try {
      return await compileSignalOnce(prompt);
    } finally {
      _compileInflight.delete(key);
    }
  })();
  _compileInflight.set(key, run);
  const res = await run;
  if (res.ok) {
    try {
      const cloned = res.clone();
      const json = (await cloned.json()) as Record<string, unknown>;
      // Never cache fallback drafts — they mask recovered OpenRouter.
      if (json.draft && json.source === "t3") {
        _compileCache.set(key, { at: Date.now(), body: json });
        if (_compileCache.size > 200) {
          const cutoff = Date.now() - COMPILE_CACHE_TTL_MS;
          for (const [k, v] of _compileCache) {
            if (v.at < cutoff) _compileCache.delete(k);
          }
        }
      }
    } catch {
      /* ignore cache fill errors */
    }
  }
  return res;
}
