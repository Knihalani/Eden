export type Original = (name: string, args: Record<string, unknown>) => Promise<unknown> | unknown;

type WrapResponse = { action: "play"; facts?: unknown; text?: string } | { action: "original" };

type Opts = { baseUrl?: string; apiKey?: string; runId?: string };

function cfg(opts?: Opts) {
  return {
    base: opts?.baseUrl || process.env.EDEN_BASE_URL || "http://127.0.0.1:8787",
    key: opts?.apiKey || process.env.EDEN_API_KEY || "eden_dev",
  };
}

const seqByRun = new Map<string, number>();

export async function runTool(
  name: string,
  args: Record<string, unknown>,
  original: Original,
  opts?: Opts & { stretchEnd?: boolean },
): Promise<unknown> {
  const { base, key } = cfg(opts);
  const runId = opts?.runId || `sdk-${Date.now()}`;
  const headers = { Authorization: `Bearer ${key}`, "content-type": "application/json" };

  const wrapRes = await fetch(`${base}/v1/wrap`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name, args, run_id: runId }),
  }).catch(() => undefined);
  if (wrapRes?.ok) {
    const wrap = (await wrapRes.json()) as WrapResponse;
    if (wrap.action === "play") return wrap.facts ?? wrap.text;
  }

  const result = await original(name, args);
  const seq = (seqByRun.get(runId) || 0) + 1;
  seqByRun.set(runId, seq);
  await fetch(`${base}/v1/ingest`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      agent_id: "sdk_ts",
      run_id: runId,
      stretch_end: Boolean(opts?.stretchEnd),
      events: [
        {
          event_id: crypto.randomUUID(),
          seq,
          name,
          args,
          ok: true,
        },
      ],
    }),
  }).catch(() => undefined);
  return result;
}

export async function endStretch(runId: string, opts?: Opts): Promise<void> {
  const { base, key } = cfg(opts);
  await fetch(`${base}/v1/ingest`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ agent_id: "sdk_ts", run_id: runId, stretch_end: true, events: [] }),
  }).catch(() => undefined);
}

export class Eden {
  constructor(private opts: Opts = {}) {
    this.opts.runId = this.opts.runId || `sdk-${Date.now()}`;
  }
  runTool(name: string, args: Record<string, unknown>, original: Original) {
    return runTool(name, args, original, this.opts);
  }
  end() {
    return endStretch(this.opts.runId!, this.opts);
  }
}
