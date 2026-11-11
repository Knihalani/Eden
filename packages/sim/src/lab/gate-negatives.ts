/**
 * P2 (Q6): user messages that ask Eden's push for nothing: pasted log lines, chatter, remarks, statements and
 * questions for information. A change to the push's request gate (`isOpenRequest`, `indirectRest`) is read against
 * them as well as against the reworded train requests (`reword.ts`): more acting requests must not mean more of
 * these. Written for the gate, not drawn from any suite; sim text only.
 */
export const GATE_NEGATIVES: { kind: "log" | "chatter" | "statement" | "question"; text: string }[] = [
  { kind: "log", text: "2026-11-10T09:14:02Z ERROR payment-worker: timeout after 30000ms (job 88213)" },
  { kind: "log", text: "WARN [scheduler] retrying task sync-calendar in 60s, attempt 3 of 5" },
  { kind: "log", text: "Traceback (most recent call last): File app.py, line 42, in handler KeyError: 'user_id'" },
  { kind: "log", text: "npm ERR! code ERESOLVE unable to resolve dependency tree while resolving react" },
  { kind: "log", text: "build #4821 failed on main: 3 tests failed in packages/billing after 4m12s" },
  { kind: "log", text: "INFO 200 GET /api/v2/invoices?page=3 118ms user=4412" },
  { kind: "log", text: "Exit code 137 container killed oom while running migrations on staging" },
  { kind: "log", text: "connection refused 10.0.4.17:5432 pg pool exhausted, 20 of 20 in use" },
  { kind: "chatter", text: "ok so anyway the weather is nice today" },
  { kind: "chatter", text: "haha that meeting went on forever didn't it" },
  { kind: "chatter", text: "morning! long weekend coming up finally" },
  { kind: "chatter", text: "ugh traffic was terrible on the way in this morning" },
  { kind: "chatter", text: "just back from lunch, the new place on the corner is decent" },
  { kind: "chatter", text: "brb grabbing a coffee before the next call" },
  { kind: "chatter", text: "lovely, thanks so much for sorting that out earlier" },
  { kind: "chatter", text: "oh well never mind, maybe next time then" },
  { kind: "chatter", text: "fun fact the office plants have been watered twice today" },
  { kind: "chatter", text: "good morning, hope you had a good weekend" },
  { kind: "statement", text: "I think the quarterly numbers look better than last time" },
  { kind: "statement", text: "We had a great offsite last year at the lake house" },
  { kind: "statement", text: "The boiler is making that noise again" },
  { kind: "statement", text: "My sister is coming to stay next weekend with the kids" },
  { kind: "statement", text: "I need to think about the kitchen quote a bit longer" },
  { kind: "statement", text: "We should probably catch up properly at some point" },
  { kind: "statement", text: "I want to say the launch went really well overall" },
  { kind: "statement", text: "I'd like to know more about how the pension works first" },
  { kind: "statement", text: "Let's see how the week goes before deciding anything" },
  { kind: "statement", text: "I have to admit the new dashboard is growing on me" },
  { kind: "question", text: "What time is my dentist appointment on Thursday?" },
  { kind: "question", text: "How much did we spend on travel last quarter?" },
  { kind: "question", text: "Who is covering support this weekend?" },
  { kind: "question", text: "Is the Halden SIPP transfer done yet?" },
  { kind: "question", text: "Did Fiona ever send the rental income totals?" },
  { kind: "question", text: "Should I be worried about the build failures this week?" },
  { kind: "question", text: "Can I see last month's electricity bill somewhere?" },
  { kind: "question", text: "Is it OK if I take Friday off next week?" },
];
