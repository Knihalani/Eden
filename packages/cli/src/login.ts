import { readConfig, writeConfig, ensureHome, wrapPlaneUrl } from "./home";

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
    savings?: { llmReductionMean?: number; runs?: number };
  } | null,
): string {
  const short = key.slice(0, 6);
  if (!health?.ok) return `${base} · down · key ${short}…`;
  const fails = health.fails ? ` · fails ${health.fails}` : "";
  const save =
    health.savings?.llmReductionMean && Number.isFinite(health.savings.llmReductionMean)
      ? ` · ${health.savings.llmReductionMean.toFixed(1)}× LLM`
      : "";
  return `${base} · ok · traces ${health.traces ?? 0} · live ${health.live ?? 0}${fails}${save} · key ${short}…`;
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
        savings?: { llmReductionMean?: number; runs?: number };
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
    const j = (await r.json()) as { live?: number; runs?: number; fail?: number; llmReductionMean?: number };
    const x = j.llmReductionMean && Number.isFinite(j.llmReductionMean) ? `${j.llmReductionMean.toFixed(1)}× LLM` : "no shadow yet";
    console.log(`live ${j.live ?? 0} · ${j.runs ?? 0} runs · ${j.fail ?? 0} failed · ${x}`);
  } catch {
    console.log("savings · wrap down");
  }
}

function arg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
