import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  canaryLiveParts,
  diagnoseHonesty,
  llmBadge,
  renderHonestyLetter,
  rolloutPartition,
  type HonestyFinding,
  type Refusal,
  type StretchProgram,
  type StretchTrace,
} from "@eden/ir";
import { edenHome, ensureHome, readConfig, resolveApiKey, wrapPlaneUrl } from "./home";

export function explainHelp(): string {
  return `eden explain — why nothing compiled

  eden explain          Letter (default)
  eden explain --json   Findings as JSON

Empty workspace: 0 stretches, exit 0. Wrap down: local runs only, still a letter.
A broken read never breaks the agent.
`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function tracesFromRuns(home: string): StretchTrace[] {
  const dir = join(home, "runs");
  if (!existsSync(dir)) return [];
  const out: StretchTrace[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  for (const f of files) {
    let raw = "";
    try {
      raw = readFileSync(join(dir, f), "utf8");
    } catch {
      continue;
    }
    const events: StretchTrace["events"] = [];
    let input: Record<string, unknown> = {};
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        const name = typeof row.tool_name === "string" ? row.tool_name : typeof row.name === "string" ? row.name : "";
        if (!name) continue;
        const args = asRecord(row.tool_input) ?? asRecord(row.args) ?? {};
        if (!Object.keys(input).length) input = args;
        events.push({
          name,
          args,
          result: row.tool_response ?? row.result,
          ok: row.ok !== false,
        });
      } catch {}
    }
    if (!events.length) continue;
    out.push({
      id: f.replace(/\.jsonl$/, ""),
      events,
      input,
      llmCalls: 0,
      duration_ms: 0,
      cost_cents: 0,
      complete: true,
    });
  }
  return out;
}

async function fetchJson(url: string, key: string, fetchFn: typeof fetch): Promise<unknown> {
  try {
    const r = await fetchFn(url, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

export async function collectExplain(opts?: {
  fetch?: typeof fetch;
  traces?: StretchTrace[];
}): Promise<{ findings: HonestyFinding[]; letter: string; refusals: Refusal[] }> {
  ensureHome();
  const home = edenHome();
  const cfg = readConfig();
  const fetchFn = opts?.fetch ?? fetch;
  let traces = opts?.traces;
  let refusals: Refusal[] = [];
  let live = 0;
  let serving = "";
  if (!traces) {
    traces = tracesFromRuns(home);
    if (cfg) {
      const base = wrapPlaneUrl(cfg.base_url);
      const key = resolveApiKey();
      const remote = (await fetchJson(`${base}/v1/traces`, key, fetchFn)) as { traces?: StretchTrace[] } | null;
      if (Array.isArray(remote?.traces) && remote.traces.length) traces = remote.traces;
      const inbox = (await fetchJson(`${base}/v1/inbox`, key, fetchFn)) as {
        candidates?: Array<{ refusal?: Refusal | null }>;
        live?: Array<{ rollout?: string; program?: StretchProgram | null }>;
      } | null;
      if (inbox) {
        live = Array.isArray(inbox.live) ? inbox.live.length : 0;
        refusals = (inbox.candidates ?? []).flatMap((c) => (c.refusal ? [c.refusal] : []));
        serving = servingLine(inbox.live ?? []);
      }
    }
  }
  const findings = diagnoseHonesty(traces);
  let letter = renderHonestyLetter({ findings, refusals, live, serving });
  if (serving && (findings.length || refusals.length)) letter = `${letter.trimEnd()}\n\n${serving}`;
  const knock = knockMention(home);
  if (knock) letter = `${letter.trimEnd()}\n\n${knock}`;
  return { findings, letter, refusals };
}

export function servingLine(live: Array<{ rollout?: string; program?: StretchProgram | null }>): string {
  if (!live.length) return "";
  const p = rolloutPartition(live);
  const zero = live.filter((t) => t.program?.steps && llmBadge(t.program) === "Zero-LLM").length;
  const parts = canaryLiveParts(p);
  if (zero) parts.push(`${zero} Zero-LLM`);
  return parts.join(" · ");
}

function knockMention(home: string): string | null {
  try {
    if (!existsSync(join(home, "knock.json"))) return null;
    return "knock waiting · eden open or eden approve";
  } catch {
    return null;
  }
}

export async function explainCli(
  args: string[] = [],
  opts?: { fetch?: typeof fetch; traces?: StretchTrace[] },
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(explainHelp());
    return 0;
  }
  try {
    const { findings, letter } = await collectExplain(opts);
    if (args.includes("--json")) console.log(JSON.stringify({ findings }, null, 2));
    else console.log(letter);
    return 0;
  } catch (err) {
    process.stderr.write(`eden explain: ${(err as Error)?.message ?? String(err)}\n`);
    console.log(renderHonestyLetter({ findings: diagnoseHonesty([]) }));
    return 0;
  }
}
