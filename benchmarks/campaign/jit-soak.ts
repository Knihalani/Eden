/**
 * Wave 11.4 S3 soak: wrap intent scorer vs steering on a compilable world
 * plus unique-work / vague transcripts.
 *
 * Precision = among turns where steering would pick a program, the scorer's
 * top-1 is that program. Unique-work and no-evidence transcripts must surface
 * zero schemas. PASS only if precision ≥ 0.95 AND unique-work empty-catalog.
 *
 * Does not retune unique-work cents. After a PASS at the registered bar,
 * surfaceMode() defaults to `jit`; EDEN_SURFACE=all is the opt-out.
 *
 *   bun run bench:jit-soak
 */
import type { StretchProgram } from "@eden/ir";
import { rankPrograms, selectSurfacePrograms, steerToolCalls, surfaceMode, type OpenAiToolCall } from "@eden/wrap";
import { linearProgram } from "./struggle-harness";
import { Session } from "./session";
import { DESK_IDS, blockSeed, createDesk } from "./worlds";

process.env.CAMPAIGN_THINK_MS ??= "1";

const PRECISION_BAR = 0.95;

function soakProg(opts: {
  name: string;
  seq: string[];
  url?: string;
  cmd?: string;
  envelope?: Record<string, unknown[]>;
}): StretchProgram {
  const first = opts.seq[0] ?? opts.name;
  const args: Record<string, unknown> = {};
  if (opts.url) args.u = { kind: "literal", value: opts.url };
  if (opts.cmd) args.command = { kind: "transform", fn: "template", expr: opts.cmd };
  return {
    id: `p_${opts.name}`,
    version: "v1",
    name: opts.name,
    description: "",
    inputSchema: { type: "object", properties: {} },
    steps: [{ id: "s0", kind: "tool", tool: first, args }] as never,
    returns: { kind: "input", path: "" },
    contract: {
      envelope: { inputs: opts.envelope ?? {} },
      allowExact: true,
      witnesses: 3,
      minLlmReduction: 1,
    } as never,
    manifest: {
      llmReduction: 2,
      latencyReduction: 1,
      costReduction: 1,
      skipRateBefore: 0,
      skipRateAfter: 0,
      nShadow: 3,
    } as never,
    sequence: opts.seq,
  };
}

const GH_URL = "https://api.github.com/repos/acme/app/pulls/12";
const GH = soakProg({
  name: "github_pr_bundle",
  seq: ["web_fetch", "Bash"],
  url: GH_URL,
  envelope: { u: [GH_URL] },
});
const KUBECTL = soakProg({
  name: "kubectl_get_pods",
  seq: ["Bash"],
  cmd: "kubectl get pods -n {namespace}",
  envelope: { namespace: ["prod", "staging", "dev", "canary"] },
});
const NAME_ONLY = linearProgram("p_desk_lookup", ["getAccount", "listInvoices", "emailCustomer"], { text: true });
NAME_ONLY.contract.envelope = { inputs: { id: [...DESK_IDS] } };

function call(name: string, args: Record<string, unknown>): OpenAiToolCall {
  return { type: "function", function: { name, arguments: JSON.stringify(args) } };
}

/** Program steering would pick for this raw call, or null. */
export function steeringPick(c: OpenAiToolCall, live: StretchProgram[]): string | null {
  const out = steerToolCalls([c], live);
  const steered = out[0];
  if (!steered) return null;
  const n = steered.function?.name || "";
  if (steered.matched_by && live.some((p) => p.name === n)) return n;
  if (live.some((p) => p.name === n)) return n;
  return null;
}

export type SoakTurn = {
  label: string;
  messages: unknown[];
  call: OpenAiToolCall;
};

export type JitSoakResult = {
  precision: number;
  n: number;
  hits: number;
  misses: number;
  uniqueWorkSchemas: number;
  vagueSchemas: number;
  jitShadowMatch: boolean;
  campaign: "compiled" | "skip" | "off";
  campaignName?: string;
  uniqueWorkCents: "n/a";
  pass: boolean;
  reasons: string[];
  defaultMayFlip: boolean;
  lines: string[];
};

function scorerTop1(messages: unknown[], live: StretchProgram[]): string | null {
  const ranked = rankPrograms(messages, live);
  return ranked[0]?.program.name ?? null;
}

function surfaceNames(mode: "jit" | "jit-shadow", messages: unknown[], live: StretchProgram[]): string[] {
  const seen: string[] = [];
  const sel = selectSurfacePrograms({
    mode,
    live,
    messages,
    onShadow: (names) => seen.push(...names),
  });
  if (mode === "jit") return sel.surface.map((p) => p.name);
  return seen;
}

async function compileDesk(): Promise<StretchProgram | null> {
  const s = new Session([["desk", createDesk]], true);
  const pool = [...DESK_IDS].map((id) => ({ id, text: "requesting refund for outage" }));
  for (let i = 0; i < 13; i++) {
    await s.stretch("desk", pool[i % pool.length]!, blockSeed("jit-soak", i));
  }
  const r = await s.goLive("desk", { compile: 9, holdout: 3, sandbox: createDesk, maxGram: 26 });
  return r.program;
}

function fixtureTurns(): SoakTurn[] {
  const turns: SoakTurn[] = [];
  const ghProse = ["Look at", "Fetch", "Summarize reviews on", "Open", "Read", "Check"];
  for (const prose of ghProse) {
    for (const extra of ["and summarize the reviews", "for the author", "please"]) {
      turns.push({
        label: "gh",
        messages: [{ role: "user", content: `${prose} ${GH_URL} ${extra}` }],
        call: call("web_fetch", { u: GH_URL }),
      });
    }
  }
  for (const ns of ["prod", "staging", "dev", "canary"]) {
    const cmd = `kubectl get pods -n ${ns}`;
    for (const extra of ["and tell me what's crashing", "and list restarts", "please"]) {
      turns.push({
        label: "kubectl",
        messages: [{ role: "user", content: `${cmd} ${extra}` }],
        call: call("Bash", { command: cmd }),
      });
    }
  }
  // Name-prefix steering with no URL/CLI in the conversation: JIT must not
  // pretend these are scorer hits. They are real turns steering would pick.
  for (const id of ["A-2001", "A-2002", "A-2003", "A-2004"]) {
    turns.push({
      label: "name-only",
      messages: [{ role: "user", content: `please handle account ${id} requesting a refund` }],
      call: call("getAccount", { id, text: "requesting refund for outage" }),
    });
  }
  return turns;
}

function uniqueWorkMessages(): unknown[][] {
  return [
    [{ role: "user", content: "alpha then bravo then charlie for N-0 — never seen this sequence" }],
    [{ role: "user", content: "delta echo foxtrot hotel india for N-1 unique work" }],
    [{ role: "user", content: "golf bravo india alpha for N-2, a different tool order again" }],
    [{ role: "user", content: "write a one-off script that will not repeat" }],
  ];
}

function vagueMessages(): unknown[][] {
  return [
    [{ role: "user", content: "please handle ticket 123" }],
    [{ role: "user", content: "write a sonnet about the sea" }],
    [{ role: "user", content: "what should I do next" }],
    [{ role: "user", content: "thanks" }],
  ];
}

export async function runJitSoak(opts: { compileCampaign?: boolean } = {}): Promise<JitSoakResult> {
  const compileCampaign = opts.compileCampaign !== false;
  const live: StretchProgram[] = [GH, KUBECTL, NAME_ONLY];
  let campaign: JitSoakResult["campaign"] = compileCampaign ? "skip" : "off";
  let campaignName: string | undefined;
  if (compileCampaign) {
    try {
      const prog = await compileDesk();
      if (prog) {
        live.push(prog);
        campaign = "compiled";
        campaignName = prog.name;
      }
    } catch {
      campaign = "skip";
    }
  }

  const turns = fixtureTurns();
  if (campaign === "compiled") {
    const first = live.find((p) => p.name === campaignName)?.sequence?.[0] ?? "getAccount";
    for (const id of DESK_IDS) {
      turns.push({
        label: "campaign",
        messages: [{ role: "user", content: `please handle account ${id} requesting a refund` }],
        call: call(first, { id, text: "requesting refund for outage" }),
      });
    }
  }

  let hits = 0;
  let misses = 0;
  let n = 0;
  let jitShadowMatch = true;
  const byLabel: Record<string, { n: number; hits: number }> = {};
  for (const t of turns) {
    const steered = steeringPick(t.call, live);
    if (!steered) continue;
    n++;
    const bucket = (byLabel[t.label] ??= { n: 0, hits: 0 });
    bucket.n++;
    const top = scorerTop1(t.messages, live);
    if (top === steered) {
      hits++;
      bucket.hits++;
    } else misses++;
    const jit = surfaceNames("jit", t.messages, live);
    const shadow = surfaceNames("jit-shadow", t.messages, live);
    if (jit[0] !== shadow[0]) jitShadowMatch = false;
  }

  const precision = n ? hits / n : 0;
  const byLine = Object.entries(byLabel)
    .map(([k, v]) => `${k}:${v.hits}/${v.n}`)
    .join(" ");

  let uniqueWorkSchemas = 0;
  for (const messages of uniqueWorkMessages()) {
    uniqueWorkSchemas += surfaceNames("jit", messages, live).length;
    uniqueWorkSchemas += surfaceNames("jit-shadow", messages, live).length;
  }
  let vagueSchemas = 0;
  for (const messages of vagueMessages()) {
    vagueSchemas += surfaceNames("jit", messages, live).length;
    vagueSchemas += surfaceNames("jit-shadow", messages, live).length;
  }

  const oldSurface = process.env.EDEN_SURFACE;
  delete process.env.EDEN_SURFACE;
  const unsetMode = surfaceMode();
  if (oldSurface === undefined) delete process.env.EDEN_SURFACE;
  else process.env.EDEN_SURFACE = oldSurface;

  const reasons: string[] = [];
  if (!(precision >= PRECISION_BAR && n > 0)) {
    reasons.push(`precision ${precision.toFixed(3)} < ${PRECISION_BAR} (n=${n})`);
  }
  if (uniqueWorkSchemas !== 0) reasons.push(`unique-work surfaced ${uniqueWorkSchemas} schemas`);
  if (vagueSchemas !== 0) reasons.push(`vague/no-evidence surfaced ${vagueSchemas} schemas`);
  if (!jitShadowMatch) reasons.push("jit and jit-shadow disagreed on top-1");
  const pass = reasons.length === 0;
  const defaultMayFlip = pass;
  const jitDefault = pass ? "jit" : "all";
  const why = pass ? "soak green" : "soak not green";

  const lines = [
    `precision=${precision.toFixed(3)} n=${n} hits=${hits} misses=${misses}`,
    `by=${byLine}`,
    `unique_work_schemas=${uniqueWorkSchemas}`,
    `vague_schemas=${vagueSchemas}`,
    `unique_work_cents=n/a (not billed)`,
    `campaign=${campaign}${campaignName ? ` name=${campaignName}` : ""}`,
    `jit_shadow_match=${jitShadowMatch}`,
    `surfaceMode_unset=${unsetMode}`,
    `verdict=${pass ? "PASS" : "FAIL"}`,
    ...reasons.map((r) => `reason=${r}`),
    `JIT_DEFAULT=${jitDefault} (${why})`,
  ];

  return {
    precision,
    n,
    hits,
    misses,
    uniqueWorkSchemas,
    vagueSchemas,
    jitShadowMatch,
    campaign,
    campaignName,
    uniqueWorkCents: "n/a",
    pass,
    reasons,
    defaultMayFlip,
    lines,
  };
}

if (import.meta.main) {
  const r = await runJitSoak({ compileCampaign: true });
  for (const line of r.lines) console.log(line);
  process.exit(r.pass ? 0 : 1);
}
