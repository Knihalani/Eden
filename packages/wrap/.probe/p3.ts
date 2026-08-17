/* throwaway audit probe 3 — delete after run */
import { createState, wrapTools, handleChatCompletions } from "../src/index";
import { pullLive } from "../src/wrap-tools";
import { createTicketShip, ticketShipProgram } from "../../runtime/src/ticketship";
import type { StretchProgram } from "@eden/ir";

const liveManifest = { llmReduction: 8, latencyReduction: 8, costReduction: 8, skipRateBefore: 0.2, skipRateAfter: 0, nShadow: 6 };
const live = (): StretchProgram => ({ ...ticketShipProgram(), manifest: liveManifest }) as StretchProgram;
const R: Record<string, string> = {};
function say(k: string, ok: boolean, msg: string) {
  R[k] = ok ? `CONFIRMED  ${msg}` : `not-repro  ${msg}`;
  console.log(`[${ok ? "CONFIRMED" : "no-repro "}] ${k}: ${msg}`);
}

// ------------------------------------------------- K1
// Late deopt (timeout) returns an {eden:"deopt"} STUB as the result of the
// raw tool the agent actually called — it never falls through to the real
// tool. And the compiled leg already mutated before timing out.
{
  const w = createTicketShip({ llmMs: 0 });
  const slowIsland = async (a: Parameters<typeof w.island>[0]) => { await Bun.sleep(300); return w.island(a); };
  const st = createState({ programs: [live()], island: slowIsland as typeof w.island, failOpen: true, timeoutMs: 40 });
  const t = wrapTools(w.tools, st);
  const out = await t.lookupTicket.execute({ id: "T-100" });
  say("K1", JSON.stringify(out).includes('"eden":"deopt"'),
    `late deopt (timeout) -> lookupTicket returned ${JSON.stringify(out)} instead of the real lookup result or a fall-through; failOpen=true`);
}

// ------------------------------------------------- K2
// Late deopt AFTER a mutation: compiled leg wrote, then the assert/timeout
// deopted; the wrap returns a stub and clears nothing, so the agent's
// natural retry of the stretch re-applies the mutation.
{
  const w = createTicketShip({ llmMs: 0 });
  let n = 0;
  const island = (async (a: Parameters<typeof w.island>[0]) => { n++; return w.island(a); }) as typeof w.island;
  // make verifyWrite fail so the `verified == true` assert (onFail:"error") trips AFTER writeRecord
  const orig = w.tools.verifyWrite.execute;
  w.tools.verifyWrite.execute = () => ({ verified: false });
  const st = createState({ programs: [live()], island, failOpen: true });
  const t = wrapTools(w.tools, st);
  let threw = "";
  try { await t.lookupTicket.execute({ id: "T-100" }); } catch (e) { threw = String((e as Error).message); }
  void orig; void n;
  say("K2", threw.includes("assert failed") && w.writes.has("T-100"),
    `assert(onFail:"error") after writeRecord: wrap re-threw ${JSON.stringify(threw)} to the agent while the record WAS already written (${w.writes.has("T-100")}) — no compensation, and failOpen did not fall through`);
}

// ------------------------------------------------- L1
// pullLive silently deletes locally-registered shadow programs
// (manifest === null) on the first successful pull.
{
  const shadow = { ...ticketShipProgram(), id: "local_shadow", name: "local_shadow" } as StretchProgram; // manifest: null
  const st = createState({
    programs: [shadow], apiKey: "k", baseUrl: "http://x",
    fetch: (async () => new Response(JSON.stringify({ tools: [] }), { status: 200 })) as unknown as typeof fetch,
  });
  await pullLive(st);
  say("L1", st.programs.length === 0,
    `local manifest:null program dropped by pullLive (localOnly filter requires p.manifest) -> programs=${st.programs.length}`);
}

// ------------------------------------------------- L2
// pullLive fail-open: a 200 with a malformed shape wipes programs.
{
  const st = createState({
    programs: [live()], apiKey: "k", baseUrl: "http://x",
    fetch: (async () => new Response(JSON.stringify({ oops: true }), { status: 200 })) as unknown as typeof fetch,
  });
  await pullLive(st);
  say("L2", st.programs.length === 0,
    `control returned 200 with no "tools" key -> all live programs silently dropped (programs=${st.programs.length}); no distinction between "no tools" and "bad response"`);
}

// ------------------------------------------------- M1
// proxy: upstream 200 with a non-JSON body -> unhandled throw out of
// handleChatCompletions (the try/catch only covers the fetch itself).
{
  const p = live();
  const st = createState({
    programs: [p],
    fetch: (async () => new Response("<html>gateway</html>", { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch,
  });
  let msg = "";
  try {
    await handleChatCompletions(new Request("http://l/v1/chat/completions", {
      method: "POST", body: JSON.stringify({ model: "m", messages: [], tools: [] }),
    }), { state: st, getPrograms: () => [p] });
  } catch (e) { msg = String((e as Error).message); }
  say("M1", msg !== "", `upstream 200 + non-JSON body throws out of handleChatCompletions: ${JSON.stringify(msg)} — no 502 fail-open, the caller's server 500s`);
}

// ------------------------------------------------- M2
// proxy: skipRest/deopt aside — a non-ok upstream loses CORS too.
{
  const st = createState({
    fetch: (async () => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 })) as unknown as typeof fetch,
  });
  const res = await handleChatCompletions(new Request("http://l/v1/chat/completions", {
    method: "POST", headers: { origin: "http://localhost:5173" }, body: JSON.stringify({ model: "m", messages: [] }),
  }), { state: st, getPrograms: () => [] });
  say("M2", res.status === 401 && !res.headers.get("access-control-allow-origin"),
    `upstream 401 relayed with status ${res.status} and no CORS header (success path sets one)`);
}

// ------------------------------------------------- N1
// skipRest grows without bound: every compiled hit adds a Map entry that
// is only removed when the agent replays EVERY remaining sequence member.
{
  const w = createTicketShip({ llmMs: 0 });
  const st = createState({ programs: [live()], island: w.island });
  const t = wrapTools(w.tools, st);
  for (let i = 0; i < 300; i++) await t.lookupTicket.execute({ id: ["T-100", "T-101", "T-102"][i % 3] });
  // probe the leak indirectly: a fresh genuine call to a tail tool for a
  // long-past id is still swallowed after 300 stretches
  w.notified.delete("T-100");
  const out = await t.notify.execute({ id: "T-100" });
  say("N1", JSON.stringify(out).includes("steered"),
    `after 300 compiled stretches, ~300 skipRest entries are still armed (none expire); notify for the very first id is still swallowed -> ${JSON.stringify(out)}`);
}

// ------------------------------------------------- N2
// state.pulls is initialised and never used; state.opts.shadow is never read.
{
  const st = createState({ shadow: true });
  say("N2", st.pulls === 0, `WrapState.pulls stays ${st.pulls} forever (the pull counter is a wrapTools-local \`calls\`), and opts.shadow is never read anywhere in packages/wrap`);
}

// ------------------------------------------------- N3
// failure receipts always report ms:0
{
  const w = createTicketShip({ llmMs: 30 });
  const slow = async (a: Parameters<typeof w.island>[0]) => { await Bun.sleep(120); throw new Error("island down"); };
  const st = createState({ programs: [live()], island: slow as unknown as typeof w.island, failOpen: true });
  const t = wrapTools(w.tools, st) as Record<string, { execute: (a: Record<string, unknown>) => Promise<unknown> }>;
  await t["resolve_ticket"]!.execute({ id: "T-100" }).catch(() => {});
  say("N3", st.receipts[0]?.ms === 0, `failed run took >100ms of real work but its receipt records ms=${st.receipts[0]?.ms}, llmCalls=${st.receipts[0]?.llmCalls}, cents=${st.receipts[0]?.cents}`);
}

console.log("\n=================== SUMMARY ===================");
for (const [k, v] of Object.entries(R)) console.log(`${k}: ${v}`);
