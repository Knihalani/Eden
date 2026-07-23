import { NextResponse } from "next/server";
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

/**
 * Compile a natural-language signal via Eden model router T3
 * (OpenRouter primary: x-ai/grok-4.5). Falls back locally if unset/unreachable.
 */
export async function POST(request: Request) {
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
      reason: err instanceof Error ? err.message : "T3 request failed",
    });
  }
}
