import { readConfig, resolveApiKey, wrapPlaneUrl } from "./home";

export function scheduleHelp(): string {
  return `eden schedule — operator cron for an already live tool

  eden schedule <id> --cron "30 14 * * 1-5"   POST /v1/tools/:id/schedule
  eden schedule <id>                          Show the schedule; does not fire
  eden schedule <id> --delete                 Remove the schedule
  eden schedule tick                          POST /v1/schedule/tick (due runs only)

Wrap ticks due rows every minute unless EDEN_SCHEDULE_CLOCK=0. Pause ≡ disabled:
a paused tool never fires. Approve / compile / live does not create a cron.
Schedule does not Approve. Human gate unchanged.
`;
}

function takeFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  return args[i + 1];
}

function idOf(args: string[]): string | undefined {
  const skip = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--cron" || a === "--now") {
      skip.add(a);
      if (args[i + 1]) skip.add(args[i + 1]!);
      i++;
      continue;
    }
  }
  return args.find((a) => a !== "tick" && !a.startsWith("-") && !skip.has(a));
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

export async function scheduleCli(
  args: string[] = [],
  opts?: { fetch?: typeof fetch },
): Promise<number> {
  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    console.log(scheduleHelp());
    return args.length === 0 ? 1 : 0;
  }
  const cfg = readConfig();
  if (!cfg) {
    console.log("schedule: no config · run eden login --dev");
    return 1;
  }
  const base = wrapPlaneUrl(cfg.base_url);
  const key = resolveApiKey();
  const fetchFn = opts?.fetch ?? fetch;
  const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };

  if (args[0] === "tick") {
    const now = takeFlag(args, "--now");
    const body: { now?: string } = {};
    if (now) body.now = now;
    const res = await fetchJson(`${base}/v1/schedule/tick`, { method: "POST", headers, body: JSON.stringify(body) }, fetchFn);
    if (!res.ok) {
      if (res.status === 0) {
        console.log("schedule: wrap is down · start eden wrap");
        return 0;
      }
      const err = (res.body as { error?: string }).error || `HTTP ${res.status}`;
      console.log(`schedule: ${err}`);
      return 1;
    }
    const out = res.body as { fired?: number; paused?: number };
    console.log(`schedule tick · fired ${out.fired ?? 0} · paused ${out.paused ?? 0}`);
    return 0;
  }

  const id = idOf(args);
  if (!id) {
    console.log("schedule: id required\neden schedule <id> --cron \"30 14 * * *\"");
    return 1;
  }

  if (args.includes("--delete")) {
    const res = await fetchJson(`${base}/v1/tools/${encodeURIComponent(id)}/schedule`, { method: "DELETE", headers }, fetchFn);
    if (!res.ok) {
      if (res.status === 0) {
        console.log("schedule: wrap is down · start eden wrap");
        return 0;
      }
      const err = (res.body as { error?: string }).error || `HTTP ${res.status}`;
      console.log(`schedule: ${err}`);
      return 1;
    }
    console.log(`schedule ${id} removed`);
    return 0;
  }

  const cron = takeFlag(args, "--cron");
  if (cron) {
    const res = await fetchJson(
      `${base}/v1/tools/${encodeURIComponent(id)}/schedule`,
      { method: "POST", headers, body: JSON.stringify({ cron }) },
      fetchFn,
    );
    if (!res.ok) {
      if (res.status === 0) {
        console.log("schedule: wrap is down · start eden wrap");
        return 0;
      }
      const err = (res.body as { error?: string }).error || `HTTP ${res.status}`;
      console.log(`schedule: ${err}`);
      return 1;
    }
    console.log(`scheduled ${id} · ${cron}\nPause ≡ disabled. Schedule does not Approve.`);
    return 0;
  }

  const res = await fetchJson(`${base}/v1/tools/${encodeURIComponent(id)}/schedule`, { headers }, fetchFn);
  if (!res.ok) {
    if (res.status === 0) {
      console.log("schedule: wrap is down · start eden wrap");
      return 0;
    }
    const err = (res.body as { error?: string }).error || `HTTP ${res.status}`;
    console.log(`schedule: ${err}`);
    return 1;
  }
  const row = (res.body as { schedule?: { cron?: string } | null }).schedule;
  if (!row) {
    console.log(`schedule ${id}: none`);
    return 0;
  }
  console.log(`schedule ${id} · ${row.cron}`);
  return 0;
}
