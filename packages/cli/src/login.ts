import { readConfig, writeConfig, ensureHome, wrapPlaneUrl, keyFingerprint } from "./home";

export async function login(args: string[]): Promise<void> {
  ensureHome();
  const explicit = arg(args, "--key") || process.env.EDEN_API_KEY;
  const apiKey = explicit || (args.includes("--dev") ? "eden_dev" : undefined);
  if (!apiKey) {
    throw new Error("eden login needs --key, EDEN_API_KEY, or --dev for the local default");
  }
  const baseUrl = wrapPlaneUrl(arg(args, "--url") || process.env.EDEN_BASE_URL);
  writeConfig({ api_key: apiKey, base_url: baseUrl });
  console.log(`logged in · ${baseUrl}`);
}

export function formatStatus(
  base: string,
  key: string,
  health: {
    ok?: boolean;
    traces?: number;
    live?: number;
    fails?: number;
    savings?: { llmReductionMean?: number; tokensSavedMean?: number; timeSavedMsMean?: number; runs?: number };
  } | null,
): string {
  const short = keyFingerprint(key);
  if (!health?.ok) return `${base} · down · key ${short}`;
  const fails = health.fails ? ` · fails ${health.fails}` : "";
  const tokens = health.savings?.tokensSavedMean;
  const save =
    tokens != null && Number.isFinite(tokens) && tokens > 0
      ? ` · ${Math.round(tokens)} tokens saved`
      : "";
  return `${base} · ok · traces ${health.traces ?? 0} · live ${health.live ?? 0}${fails}${save} · key ${short}`;
}

export async function status(): Promise<void> {
  const c = readConfig();
  if (!c) {
    console.log("not logged in · run eden login");
    return;
  }
  let health: { ok?: boolean; traces?: number; live?: number; fails?: number } | null = null;
  try {
    const r = await fetch(`${wrapPlaneUrl(c.base_url)}/health`, {
      headers: { authorization: `Bearer ${c.api_key}` },
      signal: AbortSignal.timeout(1500),
    });
    if (r.ok)
      health = (await r.json()) as {
        ok?: boolean;
        traces?: number;
        live?: number;
        fails?: number;
        savings?: { llmReductionMean?: number; tokensSavedMean?: number; timeSavedMsMean?: number; runs?: number };
      };
  } catch {
    health = null;
  }
  console.log(formatStatus(c.base_url, c.api_key, health));
}

export async function savings(): Promise<void> {
  const c = readConfig();
  if (!c) {
    console.log("not logged in · run eden login");
    return;
  }
  const base = wrapPlaneUrl(c.base_url);
  try {
    const r = await fetch(`${base}/v1/savings`, {
      headers: { authorization: `Bearer ${c.api_key}` },
      signal: AbortSignal.timeout(1500),
    });
    if (!r.ok) {
      console.log(`savings · HTTP ${r.status}`);
      return;
    }
    const j = (await r.json()) as {
      live?: number;
      runs?: number;
      fail?: number;
      tokensSavedMean?: number;
      timeSavedMsMean?: number;
    };
    const tok = j.tokensSavedMean != null && j.tokensSavedMean > 0 ? `${Math.round(j.tokensSavedMean)} tokens saved` : "";
    const time = j.timeSavedMsMean != null && j.timeSavedMsMean > 0 ? `${Math.round(j.timeSavedMsMean)} ms saved` : "";
    const x = [tok, time].filter(Boolean).join(" · ") || "not measured";
    console.log(`live ${j.live ?? 0} · ${j.runs ?? 0} runs · ${j.fail ?? 0} failed · ${x}`);
  } catch {
    console.log("savings · wrap down");
  }
}

function arg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
