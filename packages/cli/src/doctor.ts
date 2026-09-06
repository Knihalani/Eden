import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { rolloutPartition, toolsInventoryLine } from "@eden/ir";
import { autoApproveCheck, renderTreeLetter, treeCheck, treeSnapshot } from "@eden/measure";
export { autoApproveCheck, renderTreeLetter, treeCheck, treeSnapshot };
import { liveToolsPath, readConfig, wrapPlaneUrl, keyFingerprint, edenHome } from "./home";
import { hookdPidAlive, readHookdPid } from "./hookd";

export type DoctorCheck = { name: string; ok: boolean; detail: string; count?: number | null };

export const FUNNEL_STAGES = ["install", "record", "mine", "knock", "approve", "serving"] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

const WRAP_DOWN = "unknown · wrap is down";

type InboxCandidate = { verdict?: string; refusal?: { reason?: string } | null };
type InboxLive = { stats?: { n?: number } };

export function funnelCheck(name: FunnelStage, ok: boolean, count: number | null, fix: string): DoctorCheck {
  if (count === null) return { name, ok, detail: WRAP_DOWN, count: null };
  return { name, ok, detail: `${count} · ${fix}`, count };
}

export function funnelSnapshot(checks: DoctorCheck[]): Array<{ name: FunnelStage; count: number | null }> {
  return FUNNEL_STAGES.map((name) => {
    const c = checks.find((x) => x.name === name);
    return { name, count: typeof c?.count === "number" ? c.count : null };
  });
}

export function doctorPayload(checks: DoctorCheck[]): { checks: DoctorCheck[]; funnel: Array<{ name: FunnelStage; count: number | null }> } {
  return { checks, funnel: funnelSnapshot(checks) };
}

export function parseNetAllow(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const NET_ALLOW_EMPTY = "EDEN_NET_ALLOW empty · piped network binaries stay refused";
const SURFACE_JIT = "EDEN_SURFACE jit · default after soak PASS precision=1.000 n=38";
const SURFACE_ALL = "EDEN_SURFACE all · opt-out · default jit after soak PASS precision=1.000 n=38";
export const PROBE_MS = 800;

export async function probeJson(
  url: string,
  fetchFn: typeof fetch = fetch,
  ms = PROBE_MS,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; body: unknown } | null> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new Error("probe-deadline"));
    }, ms);
  });
  try {
    const pending = fetchFn(url, { ...init, signal: ac.signal });
    void pending.catch(() => {});
    const r = await Promise.race([pending, deadline]);
    const text = await Promise.race([r.text(), deadline]);
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = null;
      }
    }
    return { ok: r.ok, status: r.status, body };
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function surfaceModeOf(raw: string | undefined = process.env.EDEN_SURFACE): "all" | "none" | "jit" | "jit-shadow" {
  const v = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (v === "none") return "none";
  if (v === "all") return "all";
  if (v === "jit-shadow" || v === "shadow") return "jit-shadow";
  if (v === "jit") return "jit";
  if (!v) return "jit";
  return "all";
}

export function surfaceCheck(raw: string | undefined = process.env.EDEN_SURFACE): DoctorCheck {
  const mode = surfaceModeOf(raw);
  const v = String(raw ?? "").trim();
  if (!v) {
    return { name: "surface", ok: true, detail: SURFACE_JIT };
  }
  if (mode === "all") {
    return { name: "surface", ok: true, detail: SURFACE_ALL };
  }
  return {
    name: "surface",
    ok: true,
    detail: `EDEN_SURFACE ${mode} · soak PASS precision=1.000 n=38 · default jit`,
  };
}

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
  return "eden approve";
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
  let wrapCandidates: number | undefined;
  let wrapLive: number | undefined;
  const wrap = await probeJson(`${base}/health`, fetchFn);
  if (wrap) {
    const j = wrap.body && typeof wrap.body === "object" ? (wrap.body as {
      traces?: number;
      live?: number;
      candidates?: number;
      registry?: boolean;
      island?: boolean;
    }) : null;
    wrapUp = wrap.ok;
    if (wrap.ok && typeof j?.traces === "number") tracesKnown = j.traces;
    if (wrap.ok && typeof j?.candidates === "number") wrapCandidates = j.candidates;
    if (wrap.ok && typeof j?.live === "number") wrapLive = j.live;
    health.push({
      name: "wrap",
      ok: wrap.ok,
      detail: wrap.ok ? `up · traces ${j?.traces ?? "?"} · live ${j?.live ?? "?"}` : `HTTP ${wrap.status}`,
    });
    if (wrap.ok) {
      const key = cfg?.api_key;
      const agent = await probeJson(`${base}/v1/wrap`, fetchFn, PROBE_MS, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify({ name: "eden_doctor_probe", args: {} }),
      });
      const stale = !agent || agent.status === 404;
      const keyedReject = Boolean(key) && agent?.status === 401;
      health.push({
        name: "agent-http",
        ok: !stale && !keyedReject,
        detail: stale
          ? "POST /v1/wrap is 404 · restart eden wrap"
          : keyedReject
            ? "POST /v1/wrap HTTP 401 with the configured key"
            : `POST /v1/wrap HTTP ${agent.status}`,
      });
    }
    if (wrap.ok && j && "registry" in j) {
      health.push({
        name: "registry",
        ok: Boolean(j.registry),
        detail: j.registry ? "present" : "missing · start eden wrap without --no-coding",
      });
    }
    if (wrap.ok && j && "island" in j) {
      health.push({
        name: "island",
        ok: true,
        detail: j.island ? "wired" : "none · set OPENAI_API_KEY so island steps can run",
      });
    }
  } else {
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
    const key = cfg?.api_key;
    const inbox = await probeJson(
      `${base}/v1/inbox`,
      fetchFn,
      PROBE_MS,
      key ? { headers: { Authorization: `Bearer ${key}` } } : undefined,
    );
    if (inbox?.ok && inbox.body && typeof inbox.body === "object") {
      const box = inbox.body as { candidates?: InboxCandidate[]; live?: InboxLive[] };
      const cands = box.candidates ?? [];
      mined = cands.length;
      waiting = waitingCount(cands);
      served = servedCount(box.live ?? []);
      stuck = cands.filter(
        (c) => c.verdict === "pending" || c.refusal?.reason?.startsWith("uncovered"),
      ).length;
    } else if (inbox?.status === 401 && typeof wrapCandidates === "number") {
      mined = wrapCandidates;
    }
  }

  const hookdPort = process.env.EDEN_HOOKD_PORT || "8794";
  let hookdUp = false;
  const hookd = await probeJson(`http://127.0.0.1:${hookdPort}/health`, fetchFn);
  if (hookd?.ok) {
    hookdUp = true;
    let healthPid: number | null = null;
    const j = hookd.body && typeof hookd.body === "object" ? (hookd.body as { pid?: unknown }) : null;
    const n = Number(j?.pid);
    if (Number.isFinite(n) && n > 0) healthPid = Math.round(n);
    const filePid = readHookdPid();
    const owned = Boolean(filePid && hookdPidAlive(filePid) && (healthPid == null || filePid === healthPid));
    health.push({
      name: "hookd",
      ok: owned,
      detail: owned ? "up · record" : hookdOrphanDetail(healthPid, filePid),
    });
  } else if (hookd) {
    health.push({ name: "hookd", ok: false, detail: `HTTP ${hookd.status}` });
  } else {
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
      health.push({ name: "live-tools", ok: true, detail: liveToolsDoctorLine(tools, wrapLive) });
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

export function liveToolsDoctorLine(tools: unknown, wrapLive?: number): string {
  const disk = liveToolsDetail(tools);
  if (typeof wrapLive === "number" && wrapLive === 0 && Array.isArray(tools) && tools.length > 0) {
    return `${disk} on disk · wrap serving 0`;
  }
  return disk;
}

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
prints as a bypass, never a default. Wave 21 honesty files shipped. Wave 22 stays Later.
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
