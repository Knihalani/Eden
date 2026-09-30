import {
  canaryPct,
  envelopeLine,
  formatDiffCard,
  llmBadge,
  type ProgramDiff,
  type Refusal,
  type StretchProgram,
} from "@eden/ir";
import { readConfig, resolveApiKey, wrapBase } from "./home";

export function approveHelp(): string {
  return `eden approve — ship a compiled tool from the terminal

  eden approve              List PASS cards; if none, FAIL / INCONCLUSIVE / pending rows (cannot ship)
  eden approve <id>         Print the card; does not ship
  eden approve <id> --yes   POST /v1/tools/:id/approve (canary, 10% of sessions)
  eden approve <id> --yes --live   Ship 100% (still human; not the default)
  eden approve <id> --yes --pin    Pin islands on ship (memo-only; miss deopts)
  eden promote <id>         POST /v1/tools/:id/promote — canary becomes Live

Human gate unchanged. Without --yes nothing turns On.
FAIL / INCONCLUSIVE cannot be approved. Wrap down prints a sentence.
Write-inclusive transparency still needs EDEN_TRANSPARENT_WRITES=1 and --writes.
`;
}

type CandidateRow = {
  id: string;
  sequence?: string[];
  program?: StretchProgram | null;
  refusal?: Refusal | null;
  verdict?: string;
  diff?: ProgramDiff | null;
};

function argFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function idOf(args: string[]): string | undefined {
  return args.find((a) => a !== "--yes" && a !== "--writes" && a !== "--help" && a !== "-h" && !a.startsWith("-"));
}

async function fetchJson(
  url: string,
  init: RequestInit,
  fetchFn: typeof fetch,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  try {
    const r = await fetchFn(url, { ...init, signal: AbortSignal.timeout(8_000) });
    const body = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, body };
  } catch {
    return { ok: false, status: 0, body: { error: "wrap is down" } };
  }
}

function cardFor(c: CandidateRow): string {
  const name = c.program?.name || c.id;
  const card = formatDiffCard(c.diff ?? null, {
    name,
    id: c.id,
    sequence: c.sequence ?? c.program?.sequence,
    witnesses: c.program?.contract?.witnesses,
    first: !c.diff,
  });
  if (!c.program) return card;
  return `${card}\n${envelopeLine(c.program.contract?.envelope)}\n${llmBadge({ steps: c.program.steps ?? [] })}\nCanary · ${canaryPct()}% of sessions until promote.`;
}

function nonPassRows(all: CandidateRow[]): CandidateRow[] {
  return all.filter((c) => c.verdict === "FAIL" || c.verdict === "INCONCLUSIVE" || c.verdict === "pending");
}

function rowLine(c: CandidateRow): string {
  const reason = c.refusal?.reason ?? "";
  return reason ? `${c.id}  ${c.verdict}  ${reason}` : `${c.id}  ${c.verdict}`;
}

export async function approveCli(args: string[] = [], opts?: { fetch?: typeof fetch }): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(approveHelp());
    return 0;
  }
  const cfg = readConfig();
  if (!cfg) {
    console.log("approve: no config · start eden wrap or run eden login");
    return 1;
  }
  const base = wrapBase(cfg);
  const key = resolveApiKey();
  const fetchFn = opts?.fetch ?? fetch;
  const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };
  const id = idOf(args);
  const yes = argFlag(args, "--yes");
  const writes = argFlag(args, "--writes");

  if (!id) {
    const listed = await fetchJson(`${base}/v1/candidates`, { headers }, fetchFn);
    if (!listed.ok) {
      console.log("approve: wrap is down · start eden wrap");
      return listed.status === 0 ? 0 : 1;
    }
    const all = (listed.body as { candidates?: CandidateRow[] }).candidates ?? [];
    const rows = all.filter((c) => c.verdict === "PASS" && c.program);
    if (!rows.length) {
      const shown = nonPassRows(all);
      if (!shown.length) {
        console.log("approve: 0 PASS candidates\neden explain");
        return 0;
      }
      console.log("approve: 0 PASS candidates · cannot ship FAIL / INCONCLUSIVE");
      for (const c of shown) console.log(rowLine(c));
      return 0;
    }
    for (const c of rows) {
      const one = await fetchJson(`${base}/v1/candidates/${encodeURIComponent(c.id)}`, { headers }, fetchFn);
      const row = (one.ok ? (one.body as CandidateRow) : c) ?? c;
      console.log(cardFor(row));
      console.log("");
    }
    return 0;
  }

  const one = await fetchJson(`${base}/v1/candidates/${encodeURIComponent(id)}`, { headers }, fetchFn);
  if (!one.ok) {
    if (one.status === 0) {
      console.log("approve: wrap is down · start eden wrap");
      return 0;
    }
    const err = (one.body as { error?: string }).error || `HTTP ${one.status}`;
    console.log(`approve: ${err}`);
    return 1;
  }
  const c = one.body as CandidateRow;
  if (c.verdict && c.verdict !== "PASS") {
    console.log(cardFor(c));
    console.log(`approve: ${c.verdict} cannot be shipped`);
    return 1;
  }
  console.log(cardFor(c));
  if (!yes) return 2;
  const body: { transparent_writes?: boolean; rollout?: "live"; pinIslands?: boolean } = {};
  if (writes && process.env.EDEN_TRANSPARENT_WRITES === "1") body.transparent_writes = true;
  if (argFlag(args, "--live")) body.rollout = "live";
  if (argFlag(args, "--pin")) body.pinIslands = true;
  const shipped = await fetchJson(
    `${base}/v1/tools/${encodeURIComponent(c.program?.id || id)}/approve`,
    { method: "POST", headers, body: JSON.stringify(body) },
    fetchFn,
  );
  if (!shipped.ok) {
    const err = (shipped.body as { error?: string }).error || `HTTP ${shipped.status}`;
    console.log(`approve: ${err}`);
    return 1;
  }
  const name = (shipped.body as { name?: string }).name || c.program?.name || id;
  if (argFlag(args, "--live")) {
    console.log(`approved ${name} · Live`);
  } else {
    console.log(`approved ${name} · Canary · ${canaryPct()}% of sessions`);
    console.log(`eden promote ${c.program?.id || id}`);
  }
  return 0;
}

export async function promoteCli(args: string[] = [], opts?: { fetch?: typeof fetch }): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(approveHelp());
    return 0;
  }
  const cfg = readConfig();
  if (!cfg) {
    console.log("promote: no config · start eden wrap or run eden login");
    return 1;
  }
  const id = idOf(args);
  if (!id) {
    console.log("promote: id required\neden promote <id>");
    return 1;
  }
  const base = wrapBase(cfg);
  const key = resolveApiKey();
  const fetchFn = opts?.fetch ?? fetch;
  const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };
  const shipped = await fetchJson(
    `${base}/v1/tools/${encodeURIComponent(id)}/promote`,
    { method: "POST", headers, body: "{}" },
    fetchFn,
  );
  if (!shipped.ok) {
    if (shipped.status === 0) {
      console.log("promote: wrap is down · start eden wrap");
      return 0;
    }
    const err = (shipped.body as { error?: string }).error || `HTTP ${shipped.status}`;
    console.log(`promote: ${err}`);
    return 1;
  }
  console.log(`promoted ${id} · Live`);
  return 0;
}
