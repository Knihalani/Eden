import type { StretchTrace } from "@eden/ir";

export type IslandAt = "before-write" | "between" | "tail";

export type CorpusExpect =
  | {
      kind: "program";
      seqLen?: number;
      minSeqLen?: number;
      hasLoop?: boolean;
      /** Inner loop whose id is in an outer loop's body — flattening still hasLoop. */
      hasNestedLoop?: boolean;
      hasBranch?: boolean;
      hasIsland?: boolean;
      /** Registry names that must emit as tool steps, never islands. */
      toolsNotIslands?: string[];
      islandAt?: IslandAt;
      hasAssert?: boolean;
      loopOverPath?: string;
      /** String values that must appear in the program envelope (flattened). */
      envelopeHas?: string[];
      /** String values that must not appear — the pin a poison check can fail. */
      envelopeNot?: string[];
      /** Child program count on a composed handoff parent (Wave 7.3). */
      composedOf?: number;
      originMode?: "handoff";
      manifestNull?: boolean;
    }
  | {
      kind: "refusal";
      code: string;
      reasonIncludes?: string[];
      readSet?: number;
      repeats?: number;
    };

export type CorpusFixture = {
  name: string;
  traces: StretchTrace[];
  expect: CorpusExpect;
};

function nTraces(
  n: number,
  events: (i: number) => StretchTrace["events"],
  extra?: Partial<StretchTrace> | ((i: number) => Partial<StretchTrace>),
): StretchTrace[] {
  return Array.from({ length: n }, (_, i) => {
    const more = typeof extra === "function" ? extra(i) : extra;
    return {
      id: `${more?.id ?? "f"}-${i}`,
      llmCalls: 4,
      duration_ms: 40,
      cost_cents: 4,
      complete: true,
      input: more?.input ?? { id: `I-${i}` },
      events: events(i),
      output: more?.output ?? { ok: true },
    };
  });
}

export function etlWidth(n: number, width: number): StretchTrace[] {
  return Array.from({ length: n }, (_, i) => {
    const ids = Array.from({ length: width }, (_, j) => `row-${i}-${j}`);
    return {
      id: `etl-${i}`,
      llmCalls: 2 + width,
      duration_ms: 50,
      cost_cents: 2 + width,
      complete: true,
      input: { batch: `B${i}` },
      output: { wrote: true },
      events: [
        { name: "listRows", args: { batch: `B${i}` }, result: { ids }, ok: true },
        ...ids.map((id) => ({ name: "transformRow", args: { id }, result: { id, ok: true }, ok: true })),
        { name: "writeReport", args: { batch: `B${i}` }, result: { wrote: true }, ok: true },
      ],
    } satisfies StretchTrace;
  });
}

export const CORPUS: CorpusFixture[] = [
  {
    name: "mixed-width-fanout",
    traces: [4, 4, 4, 5].map((w, i) => {
      const ids = Array.from({ length: w }, (_, j) => `s${i}-${j}`);
      return {
        id: `width${i}`,
        llmCalls: w + 4,
        duration_ms: 40,
        cost_cents: w,
        complete: true,
        input: { orderId: `O-${i}` },
        output: { sent: true },
        events: [
          { name: "findOrder", args: { orderId: `O-${i}` }, result: { orderId: `O-${i}`, items: ids, paid: true }, ok: true },
          ...ids.map((id) => ({ name: "checkStock", args: { itemId: id }, result: { itemId: id, inStock: true }, ok: true })),
          { name: "issueRefund", args: { orderId: `O-${i}` }, result: { refunded: true }, ok: true },
          { name: "sendReceipt", args: { orderId: `O-${i}` }, result: { sent: true }, ok: true },
        ],
      };
    }),
    expect: { kind: "program", hasLoop: true, loopOverPath: "items" },
  },
  {
    name: "period-loop",
    traces: nTraces(3, (i) => {
      const ids = [`a${i}`, `b${i}`, `c${i}`];
      const q = `open-${i}`;
      return [
        { name: "listItems", args: { q }, result: { ids }, ok: true },
        ...ids.flatMap((id) => [
          { name: "getItem", args: { id }, result: { id, ok: true }, ok: true },
          { name: "tagItem", args: { id }, result: { tagged: true }, ok: true },
        ]),
        { name: "notify", args: { q }, result: { notified: true }, ok: true },
      ];
    }, (i) => ({ input: { q: `open-${i}` } })),
    expect: { kind: "program", hasLoop: true, toolsNotIslands: ["listItems"] },
  },
  {
    name: "nested-loop",
    traces: nTraces(3, (i) => {
      const orgs = [`o${i}a`, `o${i}b`];
      const q = `open-${i}`;
      return [
        { name: "listOrgs", args: { q }, result: { orgs }, ok: true },
        ...orgs.flatMap((org) => {
          const ids = [`${org}-1`, `${org}-2`];
          return [
            { name: "listItems", args: { id: org }, result: { ids }, ok: true },
            ...ids.map((id) => ({ name: "getItem", args: { id }, result: { id, org }, ok: true })),
          ];
        }),
        { name: "notify", args: { q }, result: { notified: true }, ok: true },
      ];
    }, (i) => ({ input: { q: `open-${i}` } })),
    expect: {
      kind: "program",
      hasLoop: true,
      hasNestedLoop: true,
      toolsNotIslands: ["listOrgs", "listItems"],
    },
  },
  {
    name: "branch-ci-gate",
    traces: [
      ...[10, 11, 12].map((pr, i) => ({
        id: `g${i}`,
        llmCalls: 3,
        duration_ms: 30,
        cost_cents: 3,
        complete: true,
        input: { pr },
        output: { done: true },
        events: [
          { name: "get_ci", args: { pr }, result: { state: "green", pr }, ok: true },
          { name: "merge_pr", args: { pr }, result: { done: true }, ok: true },
          { name: "notify", args: { pr }, result: { done: true }, ok: true },
        ],
      })),
      ...[20, 21, 22].map((pr, i) => ({
        id: `r${i}`,
        llmCalls: 3,
        duration_ms: 30,
        cost_cents: 3,
        complete: true,
        input: { pr },
        output: { done: true },
        events: [
          { name: "get_ci", args: { pr }, result: { state: "red", pr }, ok: true },
          { name: "comment_pr", args: { pr }, result: { done: true }, ok: true },
          { name: "notify", args: { pr }, result: { done: true }, ok: true },
        ],
      })),
    ],
    expect: { kind: "program", hasBranch: true },
  },
  {
    name: "island-before-write",
    traces: nTraces(3, (i) => [
      { name: "lookupTicket", args: { id: `T-${i}` }, result: { ok: true, id: `T-${i}` }, ok: true },
      { name: "draftReply", args: { id: `T-${i}` }, result: { text: `hi-${i}` }, ok: true },
      { name: "writeRecord", args: { id: `T-${i}`, text: `hi-${i}` }, result: { wrote: true }, ok: true },
      { name: "verifyWrite", args: { id: `T-${i}` }, result: { verified: true }, ok: true },
    ]),
    expect: { kind: "program", hasIsland: true, islandAt: "before-write", hasAssert: true },
  },
  {
    name: "island-between",
    traces: nTraces(3, (i) => [
      { name: "lookupTicket", args: { id: `T-${i}` }, result: { ok: true, id: `T-${i}` }, ok: true },
      { name: "fetchDetails", args: { id: `T-${i}` }, result: { id: `T-${i}`, body: "x" }, ok: true },
      { name: "draftReply", args: { id: `T-${i}` }, result: { text: `hi-${i}` }, ok: true },
      { name: "writeRecord", args: { id: `T-${i}`, text: `hi-${i}` }, result: { wrote: true }, ok: true },
      { name: "verifyWrite", args: { id: `T-${i}` }, result: { verified: true }, ok: true },
      { name: "notify", args: { id: `T-${i}` }, result: { ok: true }, ok: true },
    ]),
    expect: { kind: "program", hasIsland: true, islandAt: "between" },
  },
  {
    name: "island-tail",
    traces: nTraces(3, (i) => [
      { name: "lookupTicket", args: { id: `T-${i}` }, result: { ok: true, id: `T-${i}` }, ok: true },
      { name: "writeRecord", args: { id: `T-${i}` }, result: { wrote: true }, ok: true },
      { name: "verifyWrite", args: { id: `T-${i}` }, result: { verified: true }, ok: true },
      { name: "draftReply", args: { id: `T-${i}` }, result: { text: `hi-${i}` }, ok: true },
    ]),
    expect: { kind: "program", hasIsland: true, islandAt: "tail" },
  },
  {
    name: "shell-kubectl-logs",
    traces: ["prod", "staging", "dev"].map((ns, i) => ({
      id: `sh-${i}`,
      llmCalls: 4,
      duration_ms: 40,
      cost_cents: 4,
      complete: true,
      input: { namespace: ns, app: `api-${ns}` },
      output: { ns },
      events: [
        { name: "Bash", args: { command: `kubectl get pods -n ${ns}` }, result: { pods: [`api-${ns}`] }, ok: true },
        { name: "Bash", args: { command: `kubectl get svc -n ${ns}` }, result: { svc: [`api-svc-${ns}`] }, ok: true },
        { name: "Bash", args: { command: `kubectl get deployments -n ${ns}` }, result: { deployments: [`api-dep-${ns}`] }, ok: true },
        { name: "Bash", args: { command: `kubectl logs api-${ns} -n ${ns}` }, result: { lines: 12 }, ok: true },
      ],
    })),
    expect: { kind: "program", minSeqLen: 3 },
  },
  {
    name: "retry-variants-shape-vote",
    traces: [
      ...nTraces(4, (i) => [
        { name: "searchLogs", args: { key: `K-${i}` }, result: { hits: 2 }, ok: true },
        { name: "pageOncall", args: { key: `K-${i}` }, result: { paged: true }, ok: true },
        { name: "fileIncident", args: { key: `K-${i}` }, result: { filed: true }, ok: true },
      ], (i) => ({ input: { key: `K-${i}` } })),
      ...nTraces(2, (i) => [
        { name: "searchLogs", args: { key: `K-r${i}` }, result: { hits: 0 }, ok: false },
        { name: "searchLogs", args: { key: `K-r${i}` }, result: { hits: 2 }, ok: true },
        { name: "pageOncall", args: { key: `K-r${i}` }, result: { paged: true }, ok: true },
        { name: "fileIncident", args: { key: `K-r${i}` }, result: { filed: true }, ok: true },
      ], (i) => ({ id: "retry", input: { key: `K-r${i}` } })),
    ],
    expect: {
      kind: "program",
      minSeqLen: 3,
      envelopeHas: ["K-0", "K-1", "K-2", "K-3"],
      envelopeNot: ["K-r0", "K-r1"],
    },
  },
  {
    name: "pagination-cursor-refuse",
    traces: nTraces(3, (i) => [
      { name: "listPage", args: { cursor: null, batch: `C${i}` }, result: { items: ["P-a", "P-b"], nextCursor: "1" }, ok: true },
      { name: "listPage", args: { cursor: "1", batch: `C${i}` }, result: { items: ["P-c", "P-d"], nextCursor: "2" }, ok: true },
      { name: "listPage", args: { cursor: "2", batch: `C${i}` }, result: { items: ["P-e", "P-f"], nextCursor: null }, ok: true },
      ...["P-a", "P-b", "P-c", "P-d", "P-e", "P-f"].flatMap((id) => [
        { name: "getItem", args: { id }, result: { id, ok: true }, ok: true },
        { name: "writeItem", args: { id }, result: { written: true, id }, ok: true },
      ]),
      { name: "sealBatch", args: { batch: `C${i}` }, result: { sealed: true }, ok: true },
    ], { input: { batch: "C" } }),
    expect: { kind: "refusal", code: "unbound_foreach", reasonIncludes: ["listPage", "without a bindable foreach"] },
  },
  {
    name: "pagination-bindable-foreach",
    traces: nTraces(3, (i) => {
      const items = ["P-a", "P-b", "P-c", "P-d", "P-e", "P-f"];
      return [
        { name: "listAll", args: { batch: `B${i}` }, result: { items }, ok: true },
        ...items.flatMap((id) => [
          { name: "getItem", args: { id }, result: { id, ok: true }, ok: true },
          { name: "writeItem", args: { id }, result: { written: true, id }, ok: true },
        ]),
        { name: "sealBatch", args: { batch: `B${i}` }, result: { sealed: true }, ok: true },
      ];
    }, { input: { batch: "B" } }),
    expect: { kind: "program", hasLoop: true },
  },
  {
    name: "read-set-mismatch",
    traces: nTraces(3, (i) => {
      const hits = Array.from({ length: 12 }, (_, j) => `src/m${j}/impl.ts`);
      const read = hits.slice(0, 6);
      return [
        { name: "grepCode", args: { pattern: `p${i}` }, result: { hits, more: hits.slice(6) }, ok: true },
        ...read.map((path) => ({ name: "readFile", args: { path }, result: { path, lines: ["ok"] }, ok: true })),
        { name: "writeNotes", args: { topic: `p${i}` }, result: { notesWritten: true }, ok: true },
      ];
    }, { input: { topic: "t" } }),
    expect: { kind: "refusal", code: "read_set_mismatch", readSet: 12, repeats: 6, reasonIncludes: ["without a bindable foreach"] },
  },
  {
    name: "etl-width-18-default",
    traces: etlWidth(8, 18),
    expect: { kind: "program", seqLen: 20, hasLoop: true },
  },
  {
    name: "desk-short-unfragmented",
    traces: nTraces(4, (i) => [
      { name: "getAccount", args: { id: `A-${i}` }, result: { id: `A-${i}`, mrr: 400 }, ok: true },
      { name: "listInvoices", args: { id: `A-${i}` }, result: { invoices: [1, 2, 3] }, ok: true },
      { name: "composeCredit", args: { id: `A-${i}` }, result: { amount: 50 }, ok: true },
      { name: "applyCredit", args: { id: `A-${i}`, amount: 50 }, result: { applied: true }, ok: true },
      { name: "auditWrite", args: { id: `A-${i}` }, result: { audited: true }, ok: true },
      { name: "emailCustomer", args: { id: `A-${i}` }, result: { emailed: true }, ok: true },
    ]),
    expect: { kind: "program", seqLen: 6, hasIsland: true },
  },
  {
    name: "underdetermined-write",
    traces: nTraces(3, (i) => [
      { name: "lookupTicket", args: { id: `T-${i}` }, result: { ok: true }, ok: true },
      { name: "writeRecord", args: { id: `OTHER-${i}` }, result: { wrote: true }, ok: true },
      { name: "notify", args: { id: `T-${i}` }, result: { ok: true }, ok: true },
    ]),
    expect: { kind: "refusal", code: "underdetermined_write", reasonIncludes: ["under-determined"] },
  },
  {
    name: "handoff-intake-billing",
    traces: intakeBillingHandoffTraces(3),
    expect: { kind: "program", composedOf: 2, originMode: "handoff", manifestNull: true },
  },
];

/**
 * ≥3 orchestrator runs. Parent/intake: lookupTicket → fetchDetails →
 * classifyIssue. Child billing: fetchInvoice → getBalance → applyCredit.
 * Children carry parentRunId = parent stretch id.
 */
export function intakeBillingHandoffTraces(n = 3): StretchTrace[] {
  const traces: StretchTrace[] = [];
  for (let i = 0; i < n; i++) {
    const id = `T-${i}`;
    const parentId = `orch-${i}`;
    traces.push({
      id: parentId,
      agentId: "intake",
      spanId: `span-intake-${i}`,
      llmCalls: 3,
      duration_ms: 30,
      cost_cents: 3,
      complete: true,
      input: { id },
      output: { class: "billing", id },
      events: [
        { name: "lookupTicket", args: { id }, result: { ok: true, id }, ok: true, agentId: "intake" },
        { name: "fetchDetails", args: { id }, result: { id, body: "open" }, ok: true, agentId: "intake" },
        { name: "classifyIssue", args: { id }, result: { class: "billing", id }, ok: true, agentId: "intake" },
      ],
    });
    traces.push({
      id: `bill-${i}`,
      agentId: "billing",
      parentRunId: parentId,
      spanId: `span-billing-${i}`,
      llmCalls: 3,
      duration_ms: 30,
      cost_cents: 3,
      complete: true,
      input: { id },
      output: { applied: true, id },
      events: [
        { name: "fetchInvoice", args: { id }, result: { id, total: 40 }, ok: true, agentId: "billing" },
        { name: "getBalance", args: { id }, result: { id, due: 40 }, ok: true, agentId: "billing" },
        { name: "applyCredit", args: { id, amount: 40 }, result: { applied: true, id }, ok: true, agentId: "billing" },
      ],
    });
  }
  return traces;
}
