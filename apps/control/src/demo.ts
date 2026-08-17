import { join } from "node:path";
import { homedir } from "node:os";
import { Store } from "./store";
import { createHandler } from "./server";
import { registryFrom } from "@eden/runtime";
import { createTicketShip, runNaive, underdeterminedSiblingTraces, WITNESS_IDS } from "../../../packages/runtime/src/ticketship";
import type { StretchTrace } from "@eden/ir";

const PORT = Number(process.env.PORT || 8788);
const token = process.env.EDEN_API_KEY || "eden_dev";
const explicitDb = process.env.EDEN_DB;
const db = explicitDb || join(process.env.EDEN_HOME || join(homedir(), ".eden"), "demo.sqlite");

// The demo tells a story from an empty database: ten runs come in, one stretch
// compiles, it ships, then a sibling is refused. Replaying that narrative onto
// leftover state does not reproduce it — the traces are already ingested and
// the program is already shipped, so nothing lands in the inbox as a fresh PASS
// candidate and the script reports "Compile mined nothing". That made `bun run
// demo` work exactly once per machine and look broken every time after.
//
// An explicit EDEN_DB is left alone; it is the caller saying they want their
// own store.
if (!explicitDb) {
  const { rmSync, mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  mkdirSync(dirname(db), { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${db}${suffix}`, { force: true });
}

const world = createTicketShip({ llmMs: 0 });
const store = new Store(db);
const fetchHandler = createHandler({
  store,
  token,
  registry: registryFrom(world.tools),
  island: world.island,
});

async function naiveTraces(n: number): Promise<StretchTrace[]> {
  const out: StretchTrace[] = [];
  for (let i = 0; i < n; i++) {
    const id = WITNESS_IDS[i % WITNESS_IDS.length]!;
    const run = await runNaive(createTicketShip({ llmMs: 0 }), id, {
      skipVerifyP: i % 5 === 0 ? 1 : 0,
      seed: 7 + i,
    });
    out.push({
      id: `demo-${i}`,
      events: run.events,
      input: { id },
      output: run.output,
      llmCalls: run.stats.llmCalls,
      duration_ms: 200 * run.stats.llmCalls,
      cost_cents: run.stats.cost_cents,
      skipped: run.stats.skipped,
      complete: run.stats.complete,
    });
  }
  return out;
}

function auth(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:${PORT}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

type InboxCand = {
  id: string;
  verdict: string;
  refusal?: { reason: string };
  program?: { name: string; sequence?: string[] };
  manifest?: { llmReduction?: number; latencyReduction?: number; costReduction?: number };
};

const traces = await naiveTraces(10);
const server = Bun.serve({ port: PORT, hostname: "127.0.0.1", fetch: fetchHandler });

await fetchHandler(auth("/v1/traces", { method: "POST", body: JSON.stringify({ traces }) }));
await fetchHandler(auth("/v1/compile", { method: "POST", body: "{}" }));

const inbox = (await (await fetchHandler(new Request(new URL("/v1/inbox", server.url).href))).json()) as { candidates: InboxCand[] };
const pass = inbox.candidates.find((c) => c.verdict === "PASS" && c.program);

let shipped: { name?: string; id?: string } | null = null;
if (pass) {
  const approved = await fetchHandler(auth(`/v1/tools/${pass.id}/approve`, { method: "POST", body: "{}" }));
  shipped = (await approved.json()) as { name?: string; id?: string };
}

const runOk = shipped?.id
  ? await fetchHandler(auth("/v1/wrap-run", { method: "POST", body: JSON.stringify({ toolId: shipped.id, input: { id: "T-100" } }) }))
  : null;
const runOod = shipped?.id
  ? await fetchHandler(auth("/v1/wrap-run", { method: "POST", body: JSON.stringify({ toolId: shipped.id, input: { id: "T-999" } }) }))
  : null;
const okBody = runOk ? ((await runOk.json()) as { value?: unknown; stats?: { llmCalls?: number; ms?: number } }) : null;
const oodBody = runOod ? ((await runOod.json()) as { error?: string; reason?: string; deopt?: boolean }) : null;

await fetchHandler(auth("/v1/traces", { method: "POST", body: JSON.stringify({ traces: underdeterminedSiblingTraces(3) }) }));
await fetchHandler(auth("/v1/compile", { method: "POST", body: "{}" }));
const after = (await (await fetchHandler(new Request(new URL("/v1/inbox", server.url).href))).json()) as { candidates: InboxCand[] };
const refused = after.candidates.find((c) => c.refusal);

const savings = (await (await fetchHandler(auth("/v1/savings"))).json()) as {
  live?: number;
  runs?: number;
  fail?: number;
  llmReductionMean?: number;
};

console.log(`
Eden demo is up
  Inbox     ${server.url}
  Live      ${new URL("/live", server.url).href}
  OpenAI    ${new URL("/v1", server.url).href}

What just happened
  10 TicketShip agent runs: lookupTicket → fetchDetails → parseFields → validate → draftReply → writeRecord → verifyWrite → notify.
  Compile mined ${pass ? pass.program?.name : "nothing"}${pass?.manifest?.llmReduction ? ` · ${pass.manifest.llmReduction.toFixed(1)}× LLM (ships from 2×)` : ""}.
  Sequence: ${(pass?.program?.sequence ?? []).join(" → ")}
  ${shipped?.name ? `Approved and shipped ${shipped.name}.` : "No PASS candidate to ship."}
  Then a sibling stretch with an unbound writeRecord.id was refused${refused ? ` · ${refused.refusal?.reason}` : ""}.

Compiled run T-100 (in witness envelope)
  ${runOk ? `HTTP ${runOk.status} · ${JSON.stringify(okBody?.value)} · ${okBody?.stats?.llmCalls ?? "?"} island call(s)` : "skipped"}

Unseen ticket T-999 (out of distribution)
  ${runOod ? `HTTP ${runOod.status} · ${oodBody?.error ?? ""} · ${oodBody?.reason ?? ""}` : "skipped"}

Savings
  live ${savings.live ?? 0} · runs ${savings.runs ?? 0} · fails ${savings.fail ?? 0} · ${savings.llmReductionMean ? savings.llmReductionMean.toFixed(1) + "× LLM mean" : "n/a"}

Point an agent at OPENAI_BASE_URL=${new URL("/v1", server.url).href}
Token ${token}  ·  press c in the inbox to recompile
`);

await new Promise(() => undefined);
