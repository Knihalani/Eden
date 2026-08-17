/* throwaway audit probe 2 — delete after run */
import { createState, wrapTools, steerToolCalls, handleChatCompletions } from "../src/index";
import { createTicketShip, ticketShipProgram } from "../../runtime/src/ticketship";
import { withVersion } from "@eden/ir";
import type { StretchProgram } from "@eden/ir";

const liveManifest = {
  llmReduction: 8, latencyReduction: 8, costReduction: 8,
  skipRateBefore: 0.2, skipRateAfter: 0, nShadow: 6,
};
const live = (): StretchProgram => ({ ...ticketShipProgram(), manifest: liveManifest }) as StretchProgram;
const R: Record<string, string> = {};
function say(k: string, ok: boolean, msg: string) {
  R[k] = ok ? `CONFIRMED  ${msg}` : `not-repro  ${msg}`;
  console.log(`[${ok ? "CONFIRMED" : "no-repro "}] ${k}: ${msg}`);
}

// ---------------------------------------------------------------- C1
// EARLY-DEOPT DOUBLE WRITE. A program that mutates BEFORE an island
// step, run with no island caller: runCompiled performs the mutation,
// then throws "no island caller", which isEarlyDeopt() classifies as
// safe-to-retry -> wrapTools falls through and runs the raw tool again.
{
  const w = createTicketShip({ llmMs: 0 });
  const prog = withVersion({
    id: "mutate_first",
    name: "mutate_first_tool",
    description: "write then draft then notify",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    sequence: ["writeRecord", "notify"],
    steps: [
      { id: "write", kind: "tool", tool: "writeRecord", args: { id: { kind: "input", path: "id" }, customer: { kind: "literal", value: "C" }, issue: { kind: "literal", value: "I" }, reply: { kind: "literal", value: "R" } } },
      { id: "draft", kind: "island", input: { kind: "input", path: "id" }, system: "s", outputSchema: { type: "object" } },
      { id: "notify", kind: "tool", tool: "notify", args: { id: { kind: "input", path: "id" } } },
    ],
    returns: { kind: "from", step: "notify", path: "" },
    contract: { witnesses: 3, minLlmReduction: 2, allowExact: false, envelope: { inputs: { id: ["T-100"] } } },
    manifest: liveManifest,
  }) as StretchProgram;

  let writes = 0;
  const orig = w.tools.writeRecord.execute;
  w.tools.writeRecord.execute = (a, c) => { writes++; return orig(a, c); };
  const st = createState({ programs: [prog], island: undefined, failOpen: true }); // NO island caller
  const t = wrapTools(w.tools, st);
  const out = await t.writeRecord.execute({ id: "T-100", customer: "AGENT", issue: "agent-issue", reply: "agent-reply" });
  say("C1", writes === 2,
    `writeRecord ran ${writes}x for one agent call (compiled leg mutated, then early-deopt fell through to the raw tool). final=${JSON.stringify(out)} record=${JSON.stringify(w.writes.get("T-100"))}`);
}

// ---------------------------------------------------------------- C2
// Same class, via the compiled-name entry point (compiledDef, line 226).
{
  const w = createTicketShip({ llmMs: 0 });
  const prog = withVersion({
    id: "mutate_first2", name: "mf2", description: "d",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    sequence: ["notify", "writeRecord"],
    steps: [
      { id: "n", kind: "tool", tool: "notify", args: { id: { kind: "input", path: "id" } } },
      { id: "draft", kind: "island", input: { kind: "input", path: "id" }, system: "s", outputSchema: { type: "object" } },
    ],
    returns: { kind: "from", step: "n", path: "" },
    contract: { witnesses: 3, minLlmReduction: 2, allowExact: false, envelope: { inputs: { id: ["T-100"] } } },
    manifest: liveManifest,
  }) as StretchProgram;
  let n = 0;
  const orig = w.tools.notify.execute;
  w.tools.notify.execute = (a, c) => { n++; return orig(a, c); };
  const st = createState({ programs: [prog], island: undefined, failOpen: true });
  const t = wrapTools(w.tools, st) as Record<string, { execute: (a: Record<string, unknown>) => Promise<unknown> }>;
  await t["mf2"]!.execute({ id: "T-100" });
  say("C2", n === 2, `compiledDef path: notify ran ${n}x for one call`);
}

// ---------------------------------------------------------------- J1
// Duplicate tool inside a sequence: rest is a Set so the dupe collapses,
// only ONE of the two raw follow-ups is swallowed.
{
  const w = createTicketShip({ llmMs: 0 });
  const p = { ...live(), sequence: ["lookupTicket", "notify", "verifyWrite", "notify"] } as StretchProgram;
  const st = createState({ programs: [p], island: w.island });
  const t = wrapTools(w.tools, st);
  await t.lookupTicket.execute({ id: "T-100" });
  const a = await t.notify.execute({ id: "T-100" });
  const b = await t.notify.execute({ id: "T-100" });
  say("J1", JSON.stringify(a).includes("steered") && !JSON.stringify(b).includes("steered"),
    `sequence has notify twice; first raw notify -> ${JSON.stringify(a)}, second -> ${JSON.stringify(b)} (Set<string> collapsed the dupe)`);
}

// ---------------------------------------------------------------- S1
// steerToolCalls silently DROPS unrelated calls in the same batch.
{
  const p = live();
  const out = steerToolCalls([
    { id: "a", function: { name: "lookupTicket", arguments: JSON.stringify({ id: "T-100" }) } },
    { id: "b", function: { name: "sendEmailToCeo", arguments: JSON.stringify({ to: "ceo@x", body: "unrelated" }) } },
  ], [p]);
  say("S1", out.length === 1 && out[0]!.function!.name === "resolve_ticket",
    `batch of 2 (one unrelated to the stretch) collapsed to ${out.length} call(s): ${out.map((c) => c.function?.name).join(",")} — "sendEmailToCeo" dropped, not in any sequence`);
}

// ---------------------------------------------------------------- S2
// steerToolCalls reuses the FIRST call's id for the steered call. If the
// host correlates tool_call ids, the dropped calls' ids are never answered.
{
  const p = live();
  const out = steerToolCalls([
    { id: "call_1", function: { name: "lookupTicket", arguments: JSON.stringify({ id: "T-100" }) } },
    { id: "call_2", function: { name: "fetchDetails", arguments: JSON.stringify({ id: "T-100" }) } },
  ], [p]);
  say("S2", out.length === 1 && out[0]!.id === "call_1",
    `ids in=[call_1,call_2] out=[${out.map((c) => c.id).join(",")}] — call_2 will never get a tool result message`);
}

// ---------------------------------------------------------------- P1
// proxy: streaming + live programs + client tools -> forced non-stream
// upstream, then re-wrapped as a single SSE frame. Any real streaming
// field (delta) is gone: the frame carries `message`, not `delta`.
{
  const p = live();
  const st = createState({
    programs: [p],
    fetch: (async () => new Response(JSON.stringify({
      id: "x", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    }))) as unknown as typeof fetch,
  });
  const res = await handleChatCompletions(new Request("http://l/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "m", messages: [], stream: true, tools: [{ type: "function", function: { name: "lookupTicket" } }] }),
  }), { state: st, getPrograms: () => [p] });
  const text = await res.text();
  const frame = JSON.parse(text.split("\n")[0]!.replace(/^data: /, ""));
  say("P1", !!frame.choices[0].message && !frame.choices[0].delta && frame.object === "chat.completion",
    `SSE frame is a chat.completion (message/finish_reason), not chat.completion.chunk with delta -> ${JSON.stringify(frame.choices[0])}. Strict OpenAI stream clients will not parse this.`);
}

// ---------------------------------------------------------------- P2
// proxy: upstream error body is forwarded with content-type json even
// when it was SSE/text; and on the STREAM passthrough branch, a non-ok
// upstream is returned with content-type text/event-stream.
{
  const st = createState({
    fetch: (async () => new Response("upstream exploded", { status: 500, headers: { "content-type": "text/plain" } })) as unknown as typeof fetch,
  });
  const res = await handleChatCompletions(new Request("http://l/v1/chat/completions", {
    method: "POST", body: JSON.stringify({ model: "m", messages: [], stream: true }),
  }), { state: st, getPrograms: () => [] });
  say("P2", res.status === 500 && (res.headers.get("content-type") || "").includes("event-stream"),
    `stream passthrough of a 500 text/plain error -> status ${res.status} content-type ${res.headers.get("content-type")} body ${JSON.stringify(await res.text())}`);
}

// ---------------------------------------------------------------- P3
// proxy: streaming branch forwards the whole body incl. `stream_options`
// but the non-stream branch overwrites stream:false while leaving
// stream_options intact -> OpenAI 400s on stream_options without stream.
{
  let sent: Record<string, unknown> = {};
  const p = live();
  const st = createState({
    programs: [p],
    fetch: (async (_u: string, i: RequestInit) => {
      sent = JSON.parse(String(i.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    }) as unknown as typeof fetch,
  });
  await handleChatCompletions(new Request("http://l/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "m", messages: [], stream: true, stream_options: { include_usage: true }, tools: [{ type: "function", function: { name: "lookupTicket" } }] }),
  }), { state: st, getPrograms: () => [p] });
  say("P3", sent.stream === false && !!sent.stream_options,
    `forwarded body has stream=${sent.stream} but stream_options=${JSON.stringify(sent.stream_options)} — OpenAI rejects stream_options when stream is not true`);
}

// ---------------------------------------------------------------- P4
// proxy: CORS headers are attached to the success paths but NOT to the
// 400/502/upstream-error paths, and there is no OPTIONS preflight handler.
{
  const st = createState({});
  const res = await handleChatCompletions(new Request("http://l/v1/chat/completions", {
    method: "POST", headers: { origin: "http://localhost:3000" }, body: "not json",
  }), { state: st, getPrograms: () => [] });
  say("P4", res.status === 400 && !res.headers.get("access-control-allow-origin"),
    `400 invalid-json response has no access-control-allow-origin (success path does) — browser sees a CORS failure instead of the error`);
}

// ---------------------------------------------------------------- X1
// Two "sessions" sharing one WrapState via two wrapTools() calls:
// per-run closure state is NOT shared (good) but state.traces/receipts
// and state.programs are, and skipRest in session A cannot protect
// session B — B replays the mutation.
{
  const w = createTicketShip({ llmMs: 0 });
  const st = createState({ programs: [live()], island: w.island });
  const sessionA = wrapTools(w.tools, st);
  const sessionB = wrapTools(w.tools, st);
  await sessionA.lookupTicket.execute({ id: "T-100" });
  const rec1 = JSON.stringify(w.writes.get("T-100"));
  const bOut = await sessionB.writeRecord.execute({ id: "T-100", customer: "B", issue: "B", reply: "B" });
  const rec2 = JSON.stringify(w.writes.get("T-100"));
  say("X1", !JSON.stringify(bOut).includes("steered") && rec1 !== rec2,
    `skipRest is per-wrapTools() closure, so a second wrap over the same state re-executes the mutation: ${rec1} -> ${rec2}`);
}

// ---------------------------------------------------------------- X2
// ...and the converse: state.opts.island / programs are global, so a
// second session's pullLive mutation of state.programs immediately
// re-targets the first session (already shown in G1 to be half-cached).
{
  const w = createTicketShip({ llmMs: 0 });
  const st = createState({ programs: [], island: w.island });
  const a = wrapTools(w.tools, st);
  const before = await a.lookupTicket.execute({ id: "T-100" });
  st.programs = [live()];                       // "session B" pulled a live tool
  const after = await a.lookupTicket.execute({ id: "T-101" });
  say("X2", JSON.stringify(before).includes('"ok":true') && JSON.stringify(after).includes("notified"),
    `session A's already-built tool object changed behaviour mid-session when state.programs was replaced: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
}

// ---------------------------------------------------------------- Y1
// run.events grows across *unrelated* stretches and only flushes on a
// heuristic; interleaved parallel calls scramble one trace.
{
  const w = createTicketShip({ llmMs: 5 });
  const st = createState({});
  const t = wrapTools(w.tools, st);
  await Promise.all([
    t.parseFields.execute({ details: { body: "A" } }),
    t.parseFields.execute({ details: { body: "B" } }),
    t.notify.execute({ id: "T-1" }),
    t.parseFields.execute({ details: { body: "C" } }),
  ]);
  const tr = st.traces[0];
  say("Y1", !!tr && tr.events.length < 4,
    `4 parallel calls, notify triggered a flush mid-flight: trace holds ${tr?.events.length} event(s) ${JSON.stringify(tr?.events.map((e) => e.name))}, remaining events landed in the next (reset) recorder; total traces=${st.traces.length}`);
}

console.log("\n=================== SUMMARY ===================");
for (const [k, v] of Object.entries(R)) console.log(`${k}: ${v}`);
