import { join } from "node:path";
import { homedir } from "node:os";
import { Store } from "./store";
import { createHandler } from "./server";
import { registryFrom } from "@eden/runtime";
import { replayRegistry } from "@eden/shadow";
import {
  createTicketShip,
  runNaive,
  underdeterminedSiblingTraces,
  WITNESS_IDS,
} from "../../../packages/runtime/src/ticketship";
import {
  parseInbox,
  parseLiveTools,
  pickPlayTool,
  demoPortBusyMessage,
  demoChildEnv,
  demoListenLines,
  demoListenFooter,
} from "../../../packages/cli/src/demo";
import type { StretchTrace } from "@eden/ir";

// Same as `eden demo`: a clone sitting uses the local key unless the operator
// already set one. bun run demo used to skip this and then fail inbox auth on
// a managed-looking env (DATABASE_URL / VERCEL).
{
  const env = demoChildEnv(process.env);
  if (!process.env.EDEN_API_KEY) {
    process.env.EDEN_DEV = env.EDEN_DEV;
    process.env.EDEN_API_KEY = env.EDEN_API_KEY;
  }
}

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
  // Shadowing replays a candidate once per held-out trace to decide whether
  // it should ship. The replay sandbox answers every call from the trace's
  // own recording, so a write-performing stretch validates without performing
  // its writes — same wiring as `eden wrap`.
  sandboxFor: (t) => replayRegistry(registryFrom(world.tools), t),
  island: world.island,
  scheduleClock: true,
});

async function naiveTraces(n: number): Promise<StretchTrace[]> {
  const llmMs = Number(process.env.LLM_MS || 25);
  const out: StretchTrace[] = [];
  for (let i = 0; i < n; i++) {
    const id = WITNESS_IDS[i % WITNESS_IDS.length]!;
    const run = await runNaive(createTicketShip({ llmMs }), id, {
      skipVerifyP: i % 5 === 0 ? 1 : 0,
      seed: 7 + i,
    });
    // duration_ms is the real wall clock of this run (the synthetic
    // `200 * llmCalls` spelling used to be rejected by the ship gate as an
    // estimate wearing measurement's clothes — correctly).
    out.push({
      id: `demo-${i}`,
      events: run.events,
      input: { id },
      output: run.output,
      llmCalls: run.stats.llmCalls,
      duration_ms: run.stats.duration_ms,
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

async function readInbox(): Promise<ReturnType<typeof parseInbox>> {
  try {
    return parseInbox(await (await fetchHandler(auth("/v1/inbox"))).json());
  } catch {
    return parseInbox(undefined);
  }
}

let server: ReturnType<typeof Bun.serve>;
try {
  const hosts = [`http://127.0.0.1:${PORT}/health`, `http://localhost:${PORT}/health`];
  let taken = false;
  for (const url of hosts) {
    const prior = await fetch(url, { signal: AbortSignal.timeout(400) }).catch(() => null);
    if (prior) {
      taken = true;
      break;
    }
  }
  if (taken) {
    console.error(demoPortBusyMessage(PORT));
    process.exit(1);
  }
  server = Bun.serve({ port: PORT, hostname: "127.0.0.1", fetch: fetchHandler });
} catch {
  console.error(demoPortBusyMessage(PORT));
  process.exit(1);
}

const traces = await naiveTraces(10);
await fetchHandler(auth("/v1/traces", { method: "POST", body: JSON.stringify({ traces }) }));
await fetchHandler(auth("/v1/compile", { method: "POST", body: "{}" }));

const inbox = await readInbox();
if (inbox.notice) console.error(inbox.notice);
const pass = inbox.candidates.find((c) => c.verdict === "PASS" && c.program);

let shipped: { name?: string; id?: string; reused?: boolean } | null = null;
if (pass) {
  const approved = await fetchHandler(auth(`/v1/tools/${pass.id}/approve`, { method: "POST", body: "{}" }));
  shipped = { ...((await approved.json()) as { name?: string; id?: string }), reused: false };
} else {
  const listed = parseLiveTools(await (await fetchHandler(auth("/v1/tools?state=live"))).json());
  const play = pickPlayTool(undefined, listed);
  if (play) shipped = { id: play.id, name: play.name, reused: true };
}

const runOk = shipped?.id
  ? await fetchHandler(
      auth("/v1/wrap-run", { method: "POST", body: JSON.stringify({ toolId: shipped.id, input: { id: "T-100" } }) }),
    )
  : null;
const runOod = shipped?.id
  ? await fetchHandler(
      auth("/v1/wrap-run", { method: "POST", body: JSON.stringify({ toolId: shipped.id, input: { id: "T-999" } }) }),
    )
  : null;
const okBody = runOk ? ((await runOk.json()) as { value?: unknown; stats?: { llmCalls?: number; ms?: number } }) : null;
const oodBody = runOod ? ((await runOod.json()) as { error?: string; reason?: string; deopt?: boolean }) : null;

await fetchHandler(
  auth("/v1/traces", { method: "POST", body: JSON.stringify({ traces: underdeterminedSiblingTraces(3) }) }),
);
await fetchHandler(auth("/v1/compile", { method: "POST", body: "{}" }));
const after = await readInbox();
if (after.notice) console.error(after.notice);
const refused = after.candidates.find((c) => c.refusal);

const savings = (await (await fetchHandler(auth("/v1/savings"))).json()) as {
  live?: number;
  runs?: number;
  fail?: number;
  llmReductionMean?: number;
};

const minedName = pass ? pass.program?.name : "nothing";
const minedLlm = pass?.manifest?.llmReduction ? ` · ${pass.manifest.llmReduction.toFixed(1)}× LLM (ships from 2×)` : "";
const minedReuse = shipped?.reused ? " this sitting (a live TicketShip tool was already shipped)" : "";
const shippedLine = shipped?.reused
  ? `Playing T-100 on already-shipped ${shipped.name ?? shipped.id}.`
  : shipped?.name
    ? `Approved and shipped ${shipped.name}.`
    : "No PASS candidate to ship.";
const runOkLine = runOk
  ? `HTTP ${runOk.status} · ${JSON.stringify(okBody?.value)} · ${okBody?.stats?.llmCalls ?? "?"} island call(s)`
  : "skipped";
console.log(`
${demoListenLines(String(server.url), token)}

What just happened
  10 TicketShip agent runs: lookupTicket → fetchDetails → parseFields → validate → draftReply → writeRecord → verifyWrite → notify.
  Compile mined ${minedName}${minedLlm}${minedReuse}.
  Sequence: ${(pass?.program?.sequence ?? []).join(" → ")}
  ${shippedLine}
  Then a sibling stretch with an unbound writeRecord.id was refused${refused ? ` · ${refused.refusal?.reason}` : ""}.

Compiled run T-100 (in witness envelope)
  ${runOkLine}

Unseen ticket T-999 (out of distribution)
  ${runOod ? `HTTP ${runOod.status} · ${oodBody?.error ?? ""} · ${oodBody?.reason ?? ""}` : "skipped"}

Savings
  live ${savings.live ?? 0} · runs ${savings.runs ?? 0} · fails ${savings.fail ?? 0} · ${savings.llmReductionMean ? savings.llmReductionMean.toFixed(1) + "× LLM mean" : "n/a"}

${demoListenFooter(String(server.url), token)}
`);

await new Promise(() => undefined);
