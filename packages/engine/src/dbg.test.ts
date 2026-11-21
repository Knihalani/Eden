import { test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import type { Source } from "@eden/sources";
import { ItemCache } from "./cache";
import { ContextPartner, type PushPoolReport } from "./partner";
import { CORE_CONFIG } from "./parts";
const NOW = Date.parse("2026-10-27T09:00:00Z");
const ITEMS: ContextItem[] = [
  { id:"mail:webb", sourceId:"mail", ref:"webb", title:"Contract renewal", text:"Payments to Webb are on hold until the contract countersigns.", updatedAt: NOW-3600e3 },
  { id:"mail:seed", sourceId:"mail", ref:"seed", title:"Project notes", text:"Notes on the venue deposit work.", updatedAt: NOW-400*3600e3, meta:{people:"Marcus Webb <m.webb@webb.example>"} },
];
const source: Source = { id:"mail", kind:"test", description:"Mail", search: async () => ITEMS };
test("dbg", async () => {
  for (const text of ["Sign the Marcus Webb contract.", "Sign the Anish Patel contract."]) {
    const p = new ContextPartner({
      sources: async () => [source], sourceMap: new SourceMap(), cache: new ItemCache(), budget: new Budget(),
      model: null, now: () => NOW,
      config: { ...CORE_CONFIG, askReader:true, readerPush:true, readerGate:true, confidentScore:99, fallbackMatchedTerms:99, askNudge:true, pushCandidates:1 },
      onPushPool: (r: PushPoolReport) => console.log(text, "=>", JSON.stringify(r)),
    });
    await p.observe({tenantId:"t",userId:"u1",sessionId:"s1",at:NOW,kind:"user_message",text} as AgentEvent, {waitMs:2000});
  }
});
