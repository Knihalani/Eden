import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { liveToolsPath, readConfig, wrapPlaneUrl } from "./home";

export type DoctorCheck = { name: string; ok: boolean; detail: string };

export async function collectDoctor(opts?: { fetch?: typeof fetch }): Promise<DoctorCheck[]> {
  const fetchFn = opts?.fetch ?? fetch;
  const checks: DoctorCheck[] = [];
  const cfg = readConfig();
  if (!cfg) checks.push({ name: "config", ok: false, detail: "missing · run eden login --dev" });
  else checks.push({ name: "config", ok: true, detail: `${cfg.base_url} · ${cfg.api_key.slice(0, 8)}…` });

  const configured = (cfg?.base_url || "http://127.0.0.1:8788").replace(/\/$/, "");
  const base = wrapPlaneUrl(configured);
  if (base !== configured) {
    checks.push({
      name: "planes",
      ok: false,
      detail: `hooks/MCP config is site ${configured}; compiled tools live on wrap ${base}. Run eden setup so traces hit /v1/traces.`,
    });
  }

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
    checks.push({
      name: "wrap",
      ok: r.ok,
      detail: r.ok ? `up · traces ${j?.traces ?? "?"} · live ${j?.live ?? "?"}` : `HTTP ${r.status}`,
    });
    if (r.ok && j && "registry" in j) {
      checks.push({
        name: "registry",
        ok: Boolean(j.registry),
        detail: j.registry ? "present" : "missing · start eden wrap without --no-coding",
      });
    }
    if (r.ok && j && "island" in j) {
      checks.push({
        name: "island",
        ok: true,
        detail: j.island ? "wired" : "none · set OPENAI_API_KEY so island steps can run",
      });
    }
  } catch {
    checks.push({
      name: "wrap",
      ok: false,
      detail: `down · control wrap is ${base} (8788); site ingest/play is 8787`,
    });
  }

  try {
    const r = await fetchFn(`${base}/v1/inbox`, { signal: AbortSignal.timeout(800) });
    if (r.ok) {
      const inbox = (await r.json()) as {
        candidates?: Array<{ verdict?: string; refusal?: { reason?: string } | null }>;
      };
      const stuck = (inbox.candidates ?? []).filter(
        (c) => c.verdict === "pending" || c.refusal?.reason?.startsWith("uncovered"),
      );
      if (stuck.length) {
        checks.push({
          name: "candidates",
          ok: true,
          detail: `${stuck.length} pending/uncovered · open wrap inbox to see why they did not ship`,
        });
      }
    }
  } catch {
    /* wrap already reported */
  }

  const hookdPort = process.env.EDEN_HOOKD_PORT || "8794";
  try {
    const r = await fetchFn(`http://127.0.0.1:${hookdPort}/health`, { signal: AbortSignal.timeout(800) });
    checks.push({ name: "hookd", ok: r.ok, detail: r.ok ? "up" : `HTTP ${r.status}` });
  } catch {
    checks.push({ name: "hookd", ok: false, detail: "down · start with eden hookd" });
  }

  const live = liveToolsPath();
  if (existsSync(live)) {
    try {
      const tools = JSON.parse(readFileSync(live, "utf8")) as unknown;
      const n = Array.isArray(tools) ? tools.length : 0;
      checks.push({ name: "live-tools", ok: true, detail: `${n} programs` });
    } catch {
      checks.push({ name: "live-tools", ok: false, detail: "unreadable JSON" });
    }
  } else checks.push({ name: "live-tools", ok: false, detail: "none yet" });

  const settings = join(homedir(), ".claude", "settings.json");
  if (existsSync(settings)) {
    try {
      const j = JSON.parse(readFileSync(settings, "utf8")) as { hooks?: Record<string, unknown> };
      const has = Boolean(j.hooks && (j.hooks.PostToolUse || j.hooks.Stop));
      checks.push({ name: "claude-hooks", ok: has, detail: has ? "installed" : "settings.json has no Eden hooks" });
    } catch {
      checks.push({ name: "claude-hooks", ok: false, detail: "unreadable" });
    }
  } else checks.push({ name: "claude-hooks", ok: false, detail: "no ~/.claude/settings.json · run eden setup" });

  return checks;
}

export function formatDoctor(checks: DoctorCheck[]): string {
  return checks.map((c) => `${c.ok ? "ok" : "!!"}  ${c.name}: ${c.detail}`).join("\n");
}

const REQUIRED = new Set(["config", "wrap"]);

export async function doctor(args: string[] = []): Promise<number> {
  const checks = await collectDoctor();
  if (args.includes("--json")) console.log(JSON.stringify({ checks }, null, 2));
  else console.log(formatDoctor(checks));
  return checks.filter((c) => REQUIRED.has(c.name)).every((c) => c.ok) ? 0 : 1;
}

if (import.meta.main) process.exit(await doctor(process.argv.slice(2)));
