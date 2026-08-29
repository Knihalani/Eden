import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { rolloutPartition, toolsInventoryLine } from "@eden/ir";
import { autoApproveCheck, renderTreeLetter, treeCheck, treeSnapshot } from "@eden/measure";
export { autoApproveCheck, renderTreeLetter, treeCheck, treeSnapshot };
import { liveToolsPath, readConfig, wrapPlaneUrl, keyFingerprint, edenHome } from "./home";
import { hookdPidAlive, readHookdPid } from "./hookd";

export type DoctorCheck = { name: string; ok: boolean; detail: string; count?: number | null };

/** install → record → mine → knock → approve → serving */
export const FUNNEL_STAGES = ["install", "record", "mine", "knock", "approve", "serving"] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

const WRAP_DOWN = "unknown · wrap is down";

type InboxCandidate = { verdict?: string; refusal?: { reason?: string } | null };
type InboxLive = { stats?: { n?: number } };

/** Count + fix sentence. Wrap-down (`count === null`) is always `unknown · wrap is down`. */
export function funnelCheck(name: FunnelStage, ok: boolean, count: number | null, fix: string): DoctorCheck {
  if (count === null) return { name, ok, detail: WRAP_DOWN, count: null };
  return { name, ok, detail: `${count} · ${fix}`, count };
}

/** Redacted: stage names and counts only. */
export function funnelSnapshot(checks: DoctorCheck[]): Array<{ name: FunnelStage; count: number | null }> {
  return FUNNEL_STAGES.map((name) => {
    const c = checks.find((x) => x.name === name);
    return { name, count: typeof c?.count === "number" ? c.count : null };
  });
}

export function doctorPayload(checks: DoctorCheck[]): { checks: DoctorCheck[]; funnel: Array<{ name: FunnelStage; count: number | null }> } {
  return { checks, funnel: funnelSnapshot(checks) };
}

/**
 * Same split as wrap's `EDEN_NET_ALLOW` hatch: comma-separated binary names.
 * Empty/unset is refuse (count 0), never “all hosts.” Array, not an object —
 * hostile `__proto__` stays a listed name.
 */
export function parseNetAllow(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const NET_ALLOW_EMPTY = "EDEN_NET_ALLOW empty · piped network binaries stay refused";
const SURFACE_ALL = "EDEN_SURFACE all · jit-soak FAIL precision=0.789 n=38 · default stays all";

/** Same split as wrap `surfaceMode()`. Empty/unknown is `all`, never a silent jit flip. */
export function surfaceModeOf(raw: string | undefined = process.env.EDEN_SURFACE): "all" | "none" | "jit" | "jit-shadow" {
  const v = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (v === "none") return "none";
  if (v === "jit") return "jit";
  if (v === "jit-shadow" || v === "shadow") return "jit-shadow";
  return "all";
}

export function surfaceCheck(raw: string | undefined = process.env.EDEN_SURFACE): DoctorCheck {
  const mode = surfaceModeOf(raw);
  if (mode === "all") {
    return { name: "surface", ok: true, detail: SURFACE_ALL };
  }
  return {
    name: "surface",
    ok: true,
    detail: `EDEN_SURFACE ${mode} · opt-in · default all until soak PASS`,
  };
}

/** Listener up, pid file missing/stale/wrong — operator can `eden hookd --stop`. */
export function hookdOrphanDetail(healthPid: number | null, filePid: number | null): string {
  const live = healthPid != null ? String(healthPid) : "?";
  const recorded = filePid != null ? String(filePid) : "missing";
  return `orphan · /health pid ${live} · pid file ${recorded} · eden hookd --stop`;
}

export function netAllowCheck(raw: string | undefined = process.env.EDEN_NET_ALLOW): DoctorCheck {
  const names = parseNetAllow(raw);
  if (names.length === 0) {
    return { name: "net-allow", ok: true, count: 0, detail: NET_ALLOW_EMPTY };
  }
  return { name: "net-allow", ok: true, count: names.length, detail: `EDEN_NET_ALLOW ${names.join(", ")}` };
}

function installState(): { ok: boolean; count: 0 | 1; fix: string } {
  const settings = join(homedir(), ".claude", "settings.json");
  if (!existsSync(settings)) return { ok: false, count: 0, fix: "run eden setup" };
  try {
    const j = JSON.parse(readFileSync(settings, "utf8")) as { hooks?: Record<string, unknown> };
    const has = Boolean(j.hooks && (j.hooks.PostToolUse || j.hooks.Stop));
    return has ? { ok: true, count: 1, fix: "hooks installed" } : { ok: false, count: 0, fix: "run eden setup" };
  } catch {
    return { ok: false, count: 0, fix: "run eden setup" };
  }
}

function waitingCount(cands: InboxCandidate[]): number {
  return cands.filter((c) => !c.refusal && c.verdict !== "FAIL").length;
}

function servedCount(live: InboxLive[]): number {
  return live.reduce((n, t) => n + (Number(t.stats?.n) > 0 ? 1 : 0), 0);
}

/** Traces when wrap reported them. Never a fake 1 from hookd-up + wrap-down. */
export function recordState(
  traces: number | undefined,
  wrapUp: boolean,
  hookdUp: boolean,
): { count: number | null; fix: string } {
  if (typeof traces === "number") {
    return {
      count: traces,
      fix: traces > 0 ? "recording" : hookdUp ? "wrap more runs" : "start with eden hookd",
    };
  }
  if (!wrapUp) {
    return hookdUp ? { count: null, fix: WRAP_DOWN } : { count: 0, fix: "start with eden hookd" };
  }
  return { count: 0, fix: hookdUp ? "wrap more runs" : "start with eden hookd" };
}

function mineFix(mined: number, stuck: number): string {
  if (!mined) return "wrap more runs";
  if (stuck) return `${stuck} pending/uncovered · eden explain`;
  return "eden explain";
}

export async function collectDoctor(opts?: { fetch?: typeof fetch }): Promise<DoctorCheck[]> {
  const fetchFn = opts?.fetch ?? fetch;
  const health: DoctorCheck[] = [];
  const cfg = readConfig();
  if (!cfg) health.push({ name: "config", ok: false, detail: "missing · run eden login --dev" });
  else health.push({ name: "config", ok: true, detail: `${cfg.base_url} · key ${keyFingerprint(cfg.api_key)}` });
  health.push(netAllowCheck());
  health.push(surfaceCheck());
  health.push(treeCheck());
  health.push(autoApproveCheck());

  const configured = (cfg?.base_url || "http://127.0.0.1:8788").replace(/\/$/, "");
  const base = wrapPlaneUrl(configured);
  if (base !== configured) {
    health.push({
      name: "planes",
      ok: false,
      detail: `hooks/MCP config is site ${configured}; compiled tools live on wrap ${base}. Run eden setup so traces hit /v1/traces.`,
    });
  }

  let wrapUp = false;
  let tracesKnown: number | undefined;
  try {
    const r = await fetchFn(`${base}/health`, { signal: AbortSignal.timeout(800) });
    const j = r.ok
      ? ((await r.json()) as {
          traces?: number;
          live?: number;
          candidates?: number;
          registry?: boolean;
          island?: boolean;
        })
      : null;
    wrapUp = r.ok;
    if (r.ok && typeof j?.traces === "number") tracesKnown = j.traces;
    health.push({
      name: "wrap",
      ok: r.ok,
      detail: r.ok ? `up · traces ${j?.traces ?? "?"} · live ${j?.live ?? "?"}` : `HTTP ${r.status}`,
    });
    if (r.ok && j && "registry" in j) {
      health.push({
        name: "registry",
        ok: Boolean(j.registry),
        detail: j.registry ? "present" : "missing · start eden wrap without --no-coding",
      });
    }
    if (r.ok && j && "island" in j) {
      health.push({
        name: "island",
        ok: true,
        detail: j.island ? "wired" : "none · set OPENAI_API_KEY so island steps can run",
      });
    }
  } catch {
    wrapUp = false;
    health.push({
      name: "wrap",
      ok: false,
      detail: `down · control wrap is ${base} (8788); site ingest/play is 8787`,
    });
  }

  let mined = 0;
  let waiting = 0;
  let served = 0;
  let stuck = 0;
  if (wrapUp) {
    try {
      const r = await fetchFn(`${base}/v1/inbox`, { signal: AbortSignal.timeout(800) });
      if (r.ok) {
        const inbox = (await r.json()) as { candidates?: InboxCandidate[]; live?: InboxLive[] };
        const cands = inbox.candidates ?? [];
        mined = cands.length;
        waiting = waitingCount(cands);
        served = servedCount(inbox.live ?? []);
        stuck = cands.filter(
          (c) => c.verdict === "pending" || c.refusal?.reason?.startsWith("uncovered"),
        ).length;
      }
    } catch {
      /* wrap already reported */
    }
  }

  const hookdPort = process.env.EDEN_HOOKD_PORT || "8794";
  let hookdUp = false;
  try {
    const r = await fetchFn(`http://127.0.0.1:${hookdPort}/health`, { signal: AbortSignal.timeout(800) });
    hookdUp = r.ok;
    if (r.ok) {
      let healthPid: number | null = null;
      try {
        const j = (await r.json()) as { pid?: unknown; service?: string };
        const n = Number(j.pid);
        if (Number.isFinite(n) && n > 0) healthPid = Math.round(n);
      } catch {
        /* body optional */
      }
      const filePid = readHookdPid();
      const owned = Boolean(filePid && hookdPidAlive(filePid) && (healthPid == null || filePid === healthPid));
      health.push({
        name: "hookd",
        ok: owned,
        detail: owned ? "up · record" : hookdOrphanDetail(healthPid, filePid),
      });
    } else {
      health.push({ name: "hookd", ok: false, detail: `HTTP ${r.status}` });
    }
  } catch {
    hookdUp = false;
    const pid = readHookdPid();
    if (pid && !hookdPidAlive(pid)) {
      health.push({ name: "hookd", ok: false, detail: `stale pid ${pid} · start with eden hookd` });
    } else {
      health.push({ name: "hookd", ok: false, detail: "down · start with eden hookd" });
    }
  }

  health.push({
    name: "lanes",
    ok: true,
    detail: `wrap ${base} · site ingest ${configured.includes("8787") ? configured : "http://127.0.0.1:8787"} · hookd :${hookdPort}`,
  });

  const live = liveToolsPath();
  if (existsSync(live)) {
    try {
      const tools = JSON.parse(readFileSync(live, "utf8")) as unknown;
      health.push({ name: "live-tools", ok: true, detail: liveToolsDetail(tools) });
    } catch {
      health.push({ name: "live-tools", ok: false, detail: "unreadable JSON" });
    }
  } else health.push({ name: "live-tools", ok: false, detail: "none yet · approve is the gate" });

  const recorded = recordState(tracesKnown, wrapUp, hookdUp);
  const knocked = existsSync(join(edenHome(), "knock.json")) ? 1 : 0;
  const install = installState();

  const funnel: DoctorCheck[] = [
    funnelCheck("install", install.count === 1, install.count, install.fix),
    funnelCheck("record", (recorded.count ?? 0) > 0, recorded.count, recorded.fix),
    wrapUp ? funnelCheck("mine", mined > 0, mined, mineFix(mined, stuck)) : funnelCheck("mine", false, null, ""),
    funnelCheck("knock", true, knocked, knocked ? "eden open or eden approve" : "none waiting"),
    wrapUp
      ? funnelCheck("approve", waiting > 0, waiting, waiting ? "eden approve <id>" : "eden approve after a PASS card")
      : funnelCheck("approve", false, null, ""),
    wrapUp
      ? funnelCheck("serving", served > 0, served, served ? "live with receipts" : "first serving after Approve")
      : funnelCheck("serving", false, null, ""),
  ];

  return [...health, ...funnel];
}

/** Same words as Home/canvas/explain: Canary vs Live. Missing rollout stays Live (already-shipped 100%). */
export function liveToolsDetail(tools: unknown): string {
  if (!Array.isArray(tools)) return "unreadable JSON";
  const rows = tools.map((raw) => {
    const t = raw && typeof raw === "object" ? (raw as { rollout?: unknown }) : {};
    return { rollout: typeof t.rollout === "string" ? t.rollout : undefined };
  });
  const p = rolloutPartition(rows);
  return toolsInventoryLine(p);
}

function lineOf(c: DoctorCheck): string {
  return `${c.ok ? "ok" : "!!"}  ${c.name}: ${c.detail}`;
}

export function formatDoctor(checks: DoctorCheck[]): string {
  const names = new Set<string>(FUNNEL_STAGES);
  const health = checks.filter((c) => !names.has(c.name));
  const funnel = FUNNEL_STAGES.map((name) => checks.find((c) => c.name === name)).filter(
    (c): c is DoctorCheck => Boolean(c),
  );
  return [...health.map(lineOf), "", ...funnel.map(lineOf)].join("\n");
}

const REQUIRED = new Set(["config", "wrap", "approve-gate"]);

export function doctorHelp(): string {
  return `eden doctor — wrap, recording, kill-switches, tree close

  eden doctor            Health letter (default)
  eden doctor --json    Same checks as JSON
  eden doctor --tree     Wave 16–20 leftover letter (no network)

NET_ALLOW empty refuses piped network binaries. A live hookd without a
matching pid file is named orphan · eden hookd --stop. EDEN_AUTO_APPROVE=1
prints as a bypass, never a default. Wave 21–22 leftovers stay Next/Later.
`;
}

export async function doctor(args: string[] = []): Promise<number> {
  if (args.includes("-h") || args.includes("--help")) {
    console.log(doctorHelp());
    return 0;
  }
  if (args.includes("--tree")) {
    if (args.includes("--json")) console.log(JSON.stringify(treeSnapshot(), null, 2));
    else console.log(renderTreeLetter());
    return treeCheck().ok ? 0 : 1;
  }
  const checks = await collectDoctor();
  if (args.includes("--json")) console.log(JSON.stringify(doctorPayload(checks), null, 2));
  else console.log(formatDoctor(checks));
  return checks.filter((c) => REQUIRED.has(c.name)).every((c) => c.ok) ? 0 : 1;
}

if (import.meta.main) process.exit(await doctor(process.argv.slice(2)));
