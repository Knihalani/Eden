/**
 * Haiku calls for the synth factory (D880), LAB ONLY: a job is one prompt whose reply is stored under its key, so
 * a run resumes where a restart left it. Two runners share the job format: `direct` (a concurrency pool over the
 * Messages API, for pilots) and `batch` (the Message Batches API at half price, for scale). Both book every call on
 * the spend ledger, and a batch reserves its worst case before it is sent.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AnthropicModel, anthropicBody, anthropicCost, anthropicPrice } from "@eden/llm";
import { keyFor } from "../free";
import { SpendCapReached, type SpendLedger } from "../spend";

export interface Job {
  key: string;
  role: string;
  system: string;
  user: string;
  maxTokens: number;
}
export interface JobResult {
  key: string;
  text: string;
  usd: number;
  stop: string;
}

export const MODEL = "claude-haiku-5-5";
const keyFile = (dir: string, key: string) => join(dir, "parts", `${key}.json`);

export function readResult(dir: string, key: string): JobResult | undefined {
  const f = keyFile(dir, key);
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as JobResult) : undefined;
}
function saveResult(dir: string, r: JobResult) {
  const f = keyFile(dir, r.key);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(r));
}
/** Forgets a stored reply (one that failed to parse), so the next run asks again. */
export function dropResult(dir: string, key: string) {
  const f = keyFile(dir, key);
  if (existsSync(f)) renameSync(f, f.replace(/\.json$/, `.bad-${Date.now()}.json`));
}

/** Parses a JSON reply, tolerating a code fence or prose around one object. */
export function parseJson(text: string): unknown {
  const t = text
    .trim()
    .replace(/^```(?:json)?\s*/, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf("{");
    const b = t.lastIndexOf("}");
    if (a < 0 || b <= a) throw new Error("no JSON object in reply");
    const body = t.slice(a, b + 1);
    try {
      return JSON.parse(body);
    } catch {
      return JSON.parse(repairEarlyClose(body));
    }
  }
}

/**
 * Haiku sometimes closes the top-level object too early (`..."people": [...]}, "items": [...]}`): a brace that brings
 * the depth to zero with more members after it. Each such brace is removed (outside strings), which balances the text;
 * stray closers after the end are dropped.
 */
export function repairEarlyClose(text: string): string {
  let out = "";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      if (depth === 1 && c === "}" && /^\s*,/.test(text.slice(i + 1))) continue;
      depth--;
      // Closed, with only stray closers after it: the object ends here.
      if (depth === 0 && /^[\s}\]]*$/.test(text.slice(i + 1))) return out + c;
    }
    out += c;
  }
  return out;
}

const has = (dir: string, key: string) => existsSync(keyFile(dir, key));

/** Runs the jobs that have no stored result yet, `concurrency` at a time; returns how many ran and their cost. */
export async function runDirect(dir: string, jobs: Job[], ledger: SpendLedger, concurrency: number, model = MODEL) {
  const todo = jobs.filter((j) => !has(dir, j.key));
  const models = new Map<string, AnthropicModel>();
  const modelFor = (role: string) => {
    if (!models.has(role))
      models.set(
        role,
        new AnthropicModel({ apiKey: keyFor(model), model, meter: ledger.meter(role), timeoutMs: 240_000 }),
      );
    return models.get(role)!;
  };
  let usd = 0;
  let done = 0;
  let failed = 0;
  let capped = false;
  const queue = [...todo];
  const one = async (j: Job) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const r = await modelFor(j.role).chat({
          messages: [
            { role: "system", content: j.system },
            { role: "user", content: j.user },
          ],
          maxTokens: j.maxTokens,
          json: true,
        });
        usd += r.costUsd ?? 0;
        saveResult(dir, { key: j.key, text: r.text, usd: r.costUsd ?? 0, stop: r.truncated ? "max_tokens" : "end" });
        done++;
        if (done % 50 === 0) console.log(`  ${done}/${todo.length} done, $${usd.toFixed(4)}`);
        return;
      } catch (e) {
        if (e instanceof SpendCapReached) {
          capped = true;
          return;
        }
        if (attempt === 3) {
          failed++;
          console.log(`  ${j.key}: ${String(e).slice(0, 200)}`);
          return;
        }
        await new Promise((r) => setTimeout(r, 2_000 * 2 ** attempt + Math.random() * 1_000));
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, concurrency) }, async () => {
      for (let j = queue.shift(); j && !capped; j = queue.shift()) await one(j);
    }),
  );
  if (capped) console.log("spend cap reached: stopped");
  return { ran: todo.length, done, failed, usd, capped };
}

interface BatchState {
  id: string;
  keys: [string, string][];
  worst: number;
  role: string;
  booked?: boolean;
}

/**
 * Sends the jobs without a stored result as Message Batches of at most `chunk` requests, waits for each and stores
 * its results. The worst case (prompt at 3 characters a token, every output token used, at the batch's half price) is
 * reserved on the ledger before a batch is sent and released when its real usage is booked. A batch sent by an
 * earlier run (a restart) is collected, not sent again.
 */
export async function runBatch(dir: string, jobs: Job[], ledger: SpendLedger, chunk = 4_000, model = MODEL) {
  const key = keyFor(model);
  const headers = { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" };
  const base = "https://api.anthropic.com/v1/messages/batches";
  const price = anthropicPrice(model);
  const half = { ...price, input: price.input / 2, output: price.output / 2 };
  const stateDir = join(dir, "batches");
  mkdirSync(stateDir, { recursive: true });
  const index = join(stateDir, "index.txt");
  const read = (id: string) => JSON.parse(readFileSync(join(stateDir, `${id}.json`), "utf8")) as BatchState;
  const pending = (existsSync(index) ? readFileSync(index, "utf8").split("\n").filter(Boolean) : []).filter(
    (id) => !read(id).booked,
  );
  const inFlight = new Set(pending.flatMap((id) => read(id).keys.map((k) => k[1])));
  const todo = jobs.filter((j) => !has(dir, j.key) && !inFlight.has(j.key));
  const release = new Map<string, () => void>();
  for (let s = 0; s < todo.length; s += chunk) {
    const part = todo.slice(s, s + chunk);
    const worst = part.reduce(
      (n, j) => n + (((j.system.length + j.user.length) / 3) * half.input + j.maxTokens * half.output) / 1e6,
      0,
    );
    const meter = ledger.meter(part[0]!.role);
    meter.reserve(worst);
    const requests = part.map((j, i) => ({
      custom_id: `j${i}`,
      params: anthropicBody(
        { apiKey: key, model },
        {
          messages: [
            { role: "system", content: j.system },
            { role: "user", content: j.user },
          ],
          maxTokens: j.maxTokens,
          json: true,
        },
        false,
      ),
    }));
    const res = await fetch(base, { method: "POST", headers, body: JSON.stringify({ requests }) });
    if (!res.ok) {
      meter.release(worst);
      throw new Error(`batch create ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const id = ((await res.json()) as { id: string }).id;
    const st: BatchState = { id, keys: part.map((j, i) => [`j${i}`, j.key]), worst, role: part[0]!.role };
    writeFileSync(join(stateDir, `${id}.json`), JSON.stringify(st));
    appendFileSync(index, `${id}\n`);
    release.set(id, () => meter.release(worst));
    pending.push(id);
    console.log(`batch ${id}: ${part.length} requests, worst case $${worst.toFixed(3)} reserved`);
  }
  let usd = 0;
  for (const id of pending) {
    usd += await collect(dir, read(id), headers, base, half, ledger, stateDir);
    release.get(id)?.();
  }
  return { sent: todo.length, usd };
}

async function collect(
  dir: string,
  st: BatchState,
  headers: Record<string, string>,
  base: string,
  half: { input: number; output: number },
  ledger: SpendLedger,
  stateDir: string,
): Promise<number> {
  const keys = new Map(st.keys);
  for (;;) {
    const s = (await (await fetch(`${base}/${st.id}`, { headers })).json()) as {
      processing_status: string;
      request_counts: Record<string, number>;
      results_url?: string;
    };
    console.log(`batch ${st.id}: ${s.processing_status} ${JSON.stringify(s.request_counts)}`);
    if (s.processing_status === "ended" && s.results_url) {
      const text = await (await fetch(s.results_url, { headers })).text();
      let usd = 0;
      for (const line of text.split("\n").filter((l) => l.trim())) {
        const r = JSON.parse(line) as {
          custom_id: string;
          result: {
            type: string;
            message?: { content: { type: string; text?: string }[]; usage: Record<string, number>; stop_reason: string };
          };
        };
        const k = keys.get(r.custom_id);
        if (!k || r.result.type !== "succeeded" || !r.result.message) {
          console.log(`  ${r.custom_id} ${k}: ${r.result.type}`);
          continue;
        }
        const u = r.result.message.usage;
        const usage = {
          inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
          cachedInputTokens: u.cache_read_input_tokens ?? 0,
          cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
        };
        const costUsd = anthropicCost(usage, { ...anthropicPrice(MODEL), ...half });
        usd += costUsd;
        ledger.write(`${st.role}.batch`, {
          model: MODEL,
          usage,
          costUsd,
          latencyMs: 0,
          ttftMs: null,
          stopReason: "batch",
        });
        const reply = r.result.message.content.find((c) => c.type === "text")?.text ?? "";
        saveResult(dir, { key: k, text: unfence(reply), usd: costUsd, stop: r.result.message.stop_reason });
      }
      writeFileSync(join(stateDir, `${st.id}.json`), JSON.stringify({ ...st, booked: true }));
      console.log(`batch ${st.id}: $${usd.toFixed(4)} booked; ledger total $${ledger.committedUsd.toFixed(4)}`);
      return usd;
    }
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

const unfence = (t: string) => {
  const m = /^\s*```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/.exec(t);
  return m ? m[1]! : t;
};
