/* throwaway audit probe — delete after run */
import { createState, wrapTools } from "../src/index";
import { createTicketShip, ticketShipProgram, OOD_ID } from "../../runtime/src/ticketship";
import type { StretchProgram } from "@eden/ir";

const liveManifest = {
  llmReduction: 8, latencyReduction: 8, costReduction: 8,
  skipRateBefore: 0.2, skipRateAfter: 0, nShadow: 6,
};
const live = (): StretchProgram => ({ ...ticketShipProgram(), manifest: liveManifest }) as StretchProgram;

function head(s: string) { console.log(`\n================ ${s}`); }
const R: Record<string, string> = {};
function say(k: string, ok: boolean, msg: string) {
  R[k] = ok ? `CONFIRMED  ${msg}` : `not-repro  ${msg}`;
  console.log(`  [${ok ? "CONFIRMED" : "no-repro "}] ${k}: ${msg}`);
}

// ---------------------------------------------------------------- B1
// skipRest swallows a genuine later call with DIFFERENT payload,
// because extractInput() projects args down to just {id}.
head("B1 skipRest mis-fire: different payload, same id");
{
  const w = createTicketShip({ llmMs: 0 });
  const st = createState({ programs: [live()], island: w.island });
  const t = wrapTools(w.tools, st);
  await t.lookupTicket.execute({ id: "T-100" });
  const before = JSON.stringify(w.writes.get("T-100"));
  // agent genuinely wants a DIFFERENT record written for the same ticket
  const out = await t.writeRecord.execute({
    id: "T-100", customer: "ESCALATION", issue: "second, unrelated write", reply: "urgent",
  });
  const after = JSON.stringify(w.writes.get("T-100"));
  say("B1", JSON.stringify(out).includes("steered") && before === after,
    `writeRecord swallowed -> ${JSON.stringify(out)}; record unchanged=${before === after}`);
}

// ---------------------------------------------------------------- B2
// skipRest never expires. A genuine re-notify long after the stretch
// (many unrelated calls later) is still swallowed.
head("B2 skipRest never expires");
{
  const w = createTicketShip({ llmMs: 0 });
  const st = createState({ programs: [live()], island: w.island });
  const t = wrapTools(w.tools, st);
  await t.lookupTicket.execute({ id: "T-100" });
  w.notified.delete("T-100");
  for (let i = 0; i < 50; i++) await t.parseFields.execute({ details: { body: "x" }, nonce: i });
  const out = await t.notify.execute({ id: "T-100" });
  say("B2", JSON.stringify(out).includes("steered") && !w.notified.has("T-100"),
    `notify 50 calls later still swallowed -> ${JSON.stringify(out)}, notified=${w.notified.has("T-100")}`);
}

// ---------------------------------------------------------------- I1
// Disarm is scoped by programId, not by invocation: a LATER failing
// stretch for a different input wipes the arming of an EARLIER
// successful stretch -> the earlier stretch's raw tail replays
// mutations the compiled program already performed. DOUBLE WRITE.
head("I1 later deopt wipes an earlier stretch's arming -> double mutation");
{
  const w = createTicketShip({ llmMs: 0 });
  let calls = 0;
  const island = async (a: Parameters<typeof w.island>[0]) => {
    calls++;
    if (calls > 1) throw new (await import("../../runtime/src/deopt")).DeoptError("no island caller");
    return w.island(a);
  };
  const st = createState({ programs: [live()], island: island as typeof w.island, failOpen: true });
  const t = wrapTools(w.tools, st);
  await t.lookupTicket.execute({ id: "T-100" });          // compiles, arms rest for T-100
  const rec1 = JSON.stringify(w.writes.get("T-100"));
  w.notified.delete("T-100");
  await t.lookupTicket.execute({ id: "T-101" });          // deopts -> clears ALL T-100 armings
  // now the agent finishes its ORIGINAL T-100 stretch raw
  const wr = await t.writeRecord.execute({ id: "T-100", customer: "Acme", issue: "dup", reply: "dup" });
  const nf = await t.notify.execute({ id: "T-100" });
  const rec2 = JSON.stringify(w.writes.get("T-100"));
  say("I1", !JSON.stringify(wr).includes("steered") && rec1 !== rec2 && w.notified.has("T-100"),
    `after unrelated T-101 deopt, T-100 tail replayed raw: writeRecord=${JSON.stringify(wr)} notify=${JSON.stringify(nf)} record ${rec1} -> ${rec2}`);
}

// ---------------------------------------------------------------- D1
// Parallel tool calls (what real hosts emit): the compiled prefix and a
// raw tail member race. Raw one lands before skipRest is armed.
head("D1 parallel batch -> compiled program AND raw tail both mutate");
{
  const w = createTicketShip({ llmMs: 25 });
  const st = createState({ programs: [live()], island: w.island });
  const t = wrapTools(w.tools, st);
  let rawWrites = 0;
  const origWrite = w.tools.writeRecord.execute;
  w.tools.writeRecord.execute = (a, c) => { rawWrites++; return origWrite(a, c); };
  const t2 = wrapTools(w.tools, st);
  const [a, b] = await Promise.all([
    t2.lookupTicket.execute({ id: "T-100" }),
    t2.writeRecord.execute({ id: "T-100", customer: "Acme", issue: "parallel", reply: "p" }),
  ]);
  void a; void t;
  say("D1", rawWrites >= 2 && !JSON.stringify(b).includes("steered"),
    `writeRecord executed ${rawWrites}x (compiled + raw); raw returned ${JSON.stringify(b)}`);
}

// ---------------------------------------------------------------- G1
// compiledCache is keyed by program id and never invalidated: after
// pullLive ships a new version of the same id, the wrap keeps running
// the OLD program forever.
head("G1 compiledCache serves a stale program version");
{
  const w = createTicketShip({ llmMs: 0 });
  const v1 = live();
  const st = createState({ programs: [v1], island: w.island });
  const t = wrapTools(w.tools, st);
  const r1 = await t[v1.name]!.execute({ id: "T-100" });
  // ship v2: same id/name, but it must NOT notify (say the notify step was pulled)
  const v2 = { ...live(), version: "v2", steps: live().steps.filter((s) => s.id !== "notify"), returns: { kind: "from", step: "verify", path: "" } } as StretchProgram;
  st.programs = [v2];
  w.notified.delete("T-101");
  await t[v2.name]!.execute({ id: "T-101" });
  say("G1", w.notified.has("T-101"),
    `after swapping to v2 (no notify step), notify still fired for T-101 = ${w.notified.has("T-101")}; receipts versions=${st.receipts.map((r) => r.version).join(",")} (r1=${JSON.stringify(r1)})`);
}

// ---------------------------------------------------------------- E1
// receipts array is only trimmed on the success path.
head("E1 receipts unbounded on the failure path");
{
  const w = createTicketShip({ llmMs: 0 });
  const st = createState({ programs: [live()], island: undefined, failOpen: true });
  const t = wrapTools(w.tools, st);
  for (let i = 0; i < 2100; i++) {
    await t[live().name]!.execute({ id: "T-100" }).catch(() => {});
  }
  say("E1", st.receipts.length > 2000, `receipts=${st.receipts.length} (MAX_TRACES=2000, cap only applied on ok:true)`);
}

// ---------------------------------------------------------------- H1
// `in` trap vs get trap disagree (id vs name).
head("H1 proxy has/get disagree on program id");
{
  const w = createTicketShip({ llmMs: 0 });
  const st = createState({ programs: [live()], island: w.island });
  const t = wrapTools(w.tools, st) as Record<string, unknown>;
  const hasById = "ticketship" in t;
  const getById = t["ticketship"] !== undefined;
  say("H1", hasById !== getById, `"ticketship" in tools = ${hasById}, tools["ticketship"] !== undefined = ${getById}`);
}

// ---------------------------------------------------------------- F1
// emitTrace after a compiled hit mislabels pre-existing raw events
head("F1 compiled hit emits a trace of unrelated raw events under the stretch input");
{
  const w = createTicketShip({ llmMs: 0 });
  const st = createState({ programs: [live()], island: w.island });
  const t = wrapTools(w.tools, st);
  await t.parseFields.execute({ details: { body: "totally unrelated task" } });
  await t.validate.execute({ fields: { customer: "Z", issue: "unrelated" } });
  await t.lookupTicket.execute({ id: "T-100" });
  const tr = st.traces[0];
  say("F1", !!tr && JSON.stringify(tr.input) === '{"id":"T-100"}' && tr.events.every((e) => e.name !== "lookupTicket"),
    `trace input=${JSON.stringify(tr?.input)} but events=${JSON.stringify(tr?.events.map((e) => e.name))}`);
}

// ---------------------------------------------------------------- OOD
head("A1 OOD_ID sanity (control)");
{
  const w = createTicketShip({ llmMs: 0 });
  const st = createState({ programs: [live()], island: w.island, failOpen: true });
  const t = wrapTools(w.tools, st);
  const r = await t.lookupTicket.execute({ id: OOD_ID });
  say("A1", JSON.stringify(w.mutationsFor(OOD_ID)) === '{"wrote":false,"verified":false,"notified":false}',
    `ood passes through cleanly -> ${JSON.stringify(r)}`);
}

console.log("\n\n=================== SUMMARY ===================");
for (const [k, v] of Object.entries(R)) console.log(`${k}: ${v}`);
