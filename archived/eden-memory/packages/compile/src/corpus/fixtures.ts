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
      /** Envelope input keys that must all be present (two-key tenant, …). */
      envelopeKeys?: string[];
      /** String values that must not appear — the pin a poison check can fail. */
      envelopeNot?: string[];
      /** Foreach body tool args that must bind from the loop item. */
      loopArgKeys?: string[];
      /** A step after a foreach whose arg binds from the loop's collected results. */
      bindFromLoop?: { tool: string; arg: string };
      /** Foreach `over` is a flatten of page arrays (cursor walk). */
      loopOverFlatten?: boolean;
      /** Foreach `over` is a filter transform. */
      loopOverFilter?: boolean;
      /** Foreach `over` is a zip of two prior arrays. */
      loopOverZip?: boolean;
      /** Foreach `over` is a chunk transform. */
      loopOverChunk?: boolean;
      /** Foreach `over` is a group-by transform. */
      loopOverGroup?: boolean;
      /** Foreach `over` is a slice of a prior array. */
      loopOverSlice?: boolean;
      /** Foreach body has a lookup transform arg (join). */
      loopArgLookup?: boolean;
      /** Poll loop with `until` on the last body result. */
      hasUntil?: boolean;
      /** Child program count on a composed handoff parent (Wave 7.3). */
      composedOf?: number;
      originMode?: "handoff";
      manifestNull?: boolean;
      /** Exact compiled program count — optional-middle must not mint a sibling. */
      programCount?: number;
    }
  | {
      kind: "refusal";
      code: string;
      reasonIncludes?: string[];
      readSet?: number;
      repeats?: number;
    }
  | {
      /** Unique-work: nothing repeats, so compileTraces returns no program and no refusal. */
      kind: "empty";
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
          {
            name: "findOrder",
            args: { orderId: `O-${i}` },
            result: { orderId: `O-${i}`, items: ids, paid: true },
            ok: true,
          },
          ...ids.map((id) => ({
            name: "checkStock",
            args: { itemId: id },
            result: { itemId: id, inStock: true },
            ok: true,
          })),
          { name: "issueRefund", args: { orderId: `O-${i}` }, result: { refunded: true }, ok: true },
          { name: "sendReceipt", args: { orderId: `O-${i}` }, result: { sent: true }, ok: true },
        ],
      };
    }),
    expect: { kind: "program", hasLoop: true, loopOverPath: "items" },
  },
  {
    name: "period-loop",
    traces: nTraces(
      3,
      (i) => {
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
      },
      (i) => ({ input: { q: `open-${i}` } }),
    ),
    expect: { kind: "program", hasLoop: true, toolsNotIslands: ["listItems"] },
  },
  {
    name: "nested-loop",
    traces: nTraces(
      3,
      (i) => {
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
      },
      (i) => ({ input: { q: `open-${i}` } }),
    ),
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
        {
          name: "Bash",
          args: { command: `kubectl get deployments -n ${ns}` },
          result: { deployments: [`api-dep-${ns}`] },
          ok: true,
        },
        { name: "Bash", args: { command: `kubectl logs api-${ns} -n ${ns}` }, result: { lines: 12 }, ok: true },
      ],
    })),
    expect: { kind: "program", minSeqLen: 3 },
  },
  {
    name: "retry-variants-shape-vote",
    traces: [
      ...nTraces(
        4,
        (i) => [
          { name: "searchLogs", args: { key: `K-${i}` }, result: { hits: 2 }, ok: true },
          { name: "pageOncall", args: { key: `K-${i}` }, result: { paged: true }, ok: true },
          { name: "fileIncident", args: { key: `K-${i}` }, result: { filed: true }, ok: true },
        ],
        (i) => ({ input: { key: `K-${i}` } }),
      ),
      ...nTraces(
        2,
        (i) => [
          { name: "searchLogs", args: { key: `K-r${i}` }, result: { hits: 0 }, ok: false },
          { name: "searchLogs", args: { key: `K-r${i}` }, result: { hits: 2 }, ok: true },
          { name: "pageOncall", args: { key: `K-r${i}` }, result: { paged: true }, ok: true },
          { name: "fileIncident", args: { key: `K-r${i}` }, result: { filed: true }, ok: true },
        ],
        (i) => ({ id: "retry", input: { key: `K-r${i}` } }),
      ),
    ],
    expect: {
      kind: "program",
      minSeqLen: 3,
      envelopeHas: ["K-0", "K-1", "K-2", "K-3"],
      envelopeNot: ["K-r0", "K-r1"],
    },
  },
  {
    name: "pagination-cursor-pages",
    traces: nTraces(
      3,
      (i) => [
        {
          name: "listPage",
          args: { cursor: null, batch: `C${i}` },
          result: { items: ["P-a", "P-b"], nextCursor: "1" },
          ok: true,
        },
        {
          name: "listPage",
          args: { cursor: "1", batch: `C${i}` },
          result: { items: ["P-c", "P-d"], nextCursor: "2" },
          ok: true,
        },
        {
          name: "listPage",
          args: { cursor: "2", batch: `C${i}` },
          result: { items: ["P-e", "P-f"], nextCursor: null },
          ok: true,
        },
        ...["P-a", "P-b", "P-c", "P-d", "P-e", "P-f"].flatMap((id) => [
          { name: "getItem", args: { id }, result: { id, ok: true }, ok: true },
          { name: "writeItem", args: { id }, result: { written: true, id }, ok: true },
        ]),
        { name: "sealBatch", args: { batch: `C${i}` }, result: { sealed: true }, ok: true },
      ],
      { input: { batch: "C" } },
    ),
    expect: { kind: "program", hasLoop: true, hasUntil: true, loopOverFlatten: true },
  },
  {
    name: "pagination-offset-pages",
    traces: nTraces(
      3,
      (i) => [
        {
          name: "listPage",
          args: { page: 0, q: `Q${i}` },
          result: { items: ["O-a", "O-b"], nextPage: 1, page: 0 },
          ok: true,
        },
        {
          name: "listPage",
          args: { page: 1, q: `Q${i}` },
          result: { items: ["O-c", "O-d"], nextPage: 2, page: 1 },
          ok: true,
        },
        {
          name: "listPage",
          args: { page: 2, q: `Q${i}` },
          result: { items: ["O-e"], nextPage: null, page: 2 },
          ok: true,
        },
        ...["O-a", "O-b", "O-c", "O-d", "O-e"].map((id) => ({
          name: "indexDoc",
          args: { id },
          result: { indexed: true, id },
          ok: true,
        })),
        { name: "flushIndex", args: { q: `Q${i}` }, result: { flushed: true }, ok: true },
      ],
      (i) => ({ input: { q: `Q${i}` } }),
    ),
    expect: { kind: "program", hasLoop: true, hasUntil: true, loopOverFlatten: true },
  },
  {
    name: "pagination-random-pages-refuse",
    traces: nTraces(
      3,
      (i) => [
        {
          name: "listPage",
          args: { cursor: "2", batch: `C${i}` },
          result: { items: ["P-e", "P-f"], nextCursor: "0" },
          ok: true,
        },
        {
          name: "listPage",
          args: { cursor: "0", batch: `C${i}` },
          result: { items: ["P-a", "P-b"], nextCursor: "1" },
          ok: true,
        },
        {
          name: "listPage",
          args: { cursor: "1", batch: `C${i}` },
          result: { items: ["P-c", "P-d"], nextCursor: null },
          ok: true,
        },
        ...["P-a", "P-b", "P-c", "P-d", "P-e", "P-f"].map((id) => ({
          name: "writeItem",
          args: { id },
          result: { written: true, id },
          ok: true,
        })),
      ],
      { input: { batch: "C" } },
    ),
    expect: { kind: "refusal", code: "unbound_foreach", reasonIncludes: ["listPage"] },
  },
  {
    name: "pagination-bindable-foreach",
    traces: nTraces(
      3,
      (i) => {
        const items = ["P-a", "P-b", "P-c", "P-d", "P-e", "P-f"];
        return [
          { name: "listAll", args: { batch: `B${i}` }, result: { items }, ok: true },
          ...items.flatMap((id) => [
            { name: "getItem", args: { id }, result: { id, ok: true }, ok: true },
            { name: "writeItem", args: { id }, result: { written: true, id }, ok: true },
          ]),
          { name: "sealBatch", args: { batch: `B${i}` }, result: { sealed: true }, ok: true },
        ];
      },
      { input: { batch: "B" } },
    ),
    expect: { kind: "program", hasLoop: true },
  },
  {
    name: "read-set-mismatch",
    traces: nTraces(
      3,
      (i) => {
        const hits = Array.from({ length: 12 }, (_, j) => `src/m${j}/impl.ts`);
        const read = [1, 3, 5, 7, 9, 11].map((j) => hits[j]!);
        return [
          { name: "grepCode", args: { pattern: `p${i}` }, result: { hits }, ok: true },
          ...read.map((path) => ({ name: "readFile", args: { path }, result: { path, lines: ["ok"] }, ok: true })),
          { name: "writeNotes", args: { topic: `p${i}` }, result: { notesWritten: true }, ok: true },
        ];
      },
      { input: { topic: "t" } },
    ),
    expect: {
      kind: "refusal",
      code: "read_set_mismatch",
      readSet: 12,
      repeats: 6,
      reasonIncludes: ["without a bindable foreach"],
    },
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
  {
    name: "crm-pipeline",
    traces: nTraces(
      4,
      (i) => {
        const lead = `L-${i}`;
        return [
          {
            name: "getLead",
            args: { leadId: lead },
            result: { leadId: lead, email: `a${i}@co.com`, company: `Co${i}` },
            ok: true,
          },
          {
            name: "enrichCompany",
            args: { company: `Co${i}` },
            result: { company: `Co${i}`, domain: `co${i}.com` },
            ok: true,
          },
          { name: "createDeal", args: { leadId: lead, company: `Co${i}` }, result: { dealId: `D-${i}` }, ok: true },
          { name: "assignOwner", args: { dealId: `D-${i}`, owner: "ae-7" }, result: { assigned: true }, ok: true },
          { name: "notifySlack", args: { dealId: `D-${i}` }, result: { posted: true }, ok: true },
        ];
      },
      (i) => ({ input: { leadId: `L-${i}` } }),
    ),
    expect: { kind: "program", seqLen: 5, toolsNotIslands: ["getLead", "createDeal"] },
  },
  {
    name: "calendar-rsvp",
    traces: nTraces(
      4,
      (i) => {
        const when = `2026-09-0${i + 1}T15:00:00Z`;
        return [
          { name: "listBusy", args: { cal: "team", day: when.slice(0, 10) }, result: { busy: [] }, ok: true },
          { name: "createEvent", args: { title: "standup", when }, result: { eventId: `E-${i}`, when }, ok: true },
          { name: "sendInvite", args: { eventId: `E-${i}`, to: "eng@" }, result: { sent: true }, ok: true },
          { name: "addReminder", args: { eventId: `E-${i}`, minutes: 10 }, result: { reminded: true }, ok: true },
        ];
      },
      (i) => ({ input: { when: `2026-09-0${i + 1}T15:00:00Z`, title: "standup" } }),
    ),
    expect: { kind: "program", minSeqLen: 4 },
  },
  {
    name: "payments-nested-json",
    traces: nTraces(
      4,
      (i) => {
        const cid = `cus_${i}`;
        return [
          {
            name: "getCustomer",
            args: { email: `u${i}@x.com` },
            result: { customer: { billing: { id: cid }, email: `u${i}@x.com` } },
            ok: true,
          },
          {
            name: "createInvoice",
            args: { customerId: cid, cents: 1999 },
            result: { invoiceId: `in_${i}`, customerId: cid },
            ok: true,
          },
          {
            name: "createCharge",
            args: { invoiceId: `in_${i}`, customerId: cid },
            result: { charged: true },
            ok: true,
          },
          { name: "sendReceipt", args: { invoiceId: `in_${i}` }, result: { emailed: true }, ok: true },
        ];
      },
      (i) => ({ input: { email: `u${i}@x.com` } }),
    ),
    expect: { kind: "program", minSeqLen: 4 },
  },
  {
    name: "two-phase-reserve-confirm",
    traces: nTraces(
      4,
      (i) => {
        const seat = `S-${i}`;
        return [
          { name: "lookupSeat", args: { seat }, result: { seat, free: true }, ok: true },
          { name: "reserveSeat", args: { seat }, result: { reservationId: `R-${i}`, seat }, ok: true },
          { name: "confirmSeat", args: { reservationId: `R-${i}` }, result: { confirmed: true }, ok: true },
          { name: "emailGuest", args: { reservationId: `R-${i}` }, result: { emailed: true }, ok: true },
        ];
      },
      (i) => ({ input: { seat: `S-${i}` } }),
    ),
    expect: { kind: "program", minSeqLen: 4 },
  },
  {
    name: "array-of-objects-foreach",
    traces: nTraces(
      4,
      (i) => {
        const items = [
          { sku: `a${i}`, qty: 1 },
          { sku: `b${i}`, qty: 2 },
          { sku: `c${i}`, qty: 1 },
        ];
        return [
          { name: "listCart", args: { cart: `CART-${i}` }, result: { items, cart: `CART-${i}` }, ok: true },
          ...items.map((it) => ({ name: "reserveSku", args: { sku: it.sku }, result: { reserved: it.sku }, ok: true })),
          { name: "checkoutCart", args: { cart: `CART-${i}` }, result: { paid: true }, ok: true },
        ];
      },
      (i) => ({ input: { cart: `CART-${i}` } }),
    ),
    expect: { kind: "program", hasLoop: true, loopOverPath: "items" },
  },
  {
    name: "unique-work-crm",
    traces: [
      {
        id: "u0",
        llmCalls: 3,
        duration_ms: 30,
        cost_cents: 3,
        complete: true,
        input: { id: "U-0" },
        events: [
          { name: "alpha", args: { id: "U-0" }, result: { ok: true }, ok: true },
          { name: "bravo", args: { id: "U-0" }, result: { ok: true }, ok: true },
          { name: "charlie", args: { id: "U-0" }, result: { ok: true }, ok: true },
        ],
      },
      {
        id: "u1",
        llmCalls: 3,
        duration_ms: 30,
        cost_cents: 3,
        complete: true,
        input: { id: "U-1" },
        events: [
          { name: "delta", args: { id: "U-1" }, result: { ok: true }, ok: true },
          { name: "echo", args: { id: "U-1" }, result: { ok: true }, ok: true },
          { name: "foxtrot", args: { id: "U-1" }, result: { ok: true }, ok: true },
        ],
      },
      {
        id: "u2",
        llmCalls: 3,
        duration_ms: 30,
        cost_cents: 3,
        complete: true,
        input: { id: "U-2" },
        events: [
          { name: "golf", args: { id: "U-2" }, result: { ok: true }, ok: true },
          { name: "hotel", args: { id: "U-2" }, result: { ok: true }, ok: true },
          { name: "india", args: { id: "U-2" }, result: { ok: true }, ok: true },
        ],
      },
    ],
    expect: { kind: "empty" },
  },
  {
    name: "underdetermined-charge",
    traces: nTraces(
      3,
      (i) => [
        { name: "getCustomer", args: { email: `u${i}@x.com` }, result: { customerId: `cus_${i}` }, ok: true },
        { name: "createCharge", args: { customerId: `OTHER_${i}`, cents: 500 }, result: { charged: true }, ok: true },
        { name: "sendReceipt", args: { email: `u${i}@x.com` }, result: { emailed: true }, ok: true },
      ],
      (i) => ({ input: { email: `u${i}@x.com` } }),
    ),
    expect: { kind: "refusal", code: "underdetermined_write" },
  },
  {
    name: "optional-enrich-majority",
    traces: [
      ...nTraces(
        4,
        (i) => [
          { name: "getLead", args: { leadId: `L-${i}` }, result: { leadId: `L-${i}` }, ok: true },
          { name: "enrichCompany", args: { leadId: `L-${i}` }, result: { domain: `c${i}.com` }, ok: true },
          { name: "createDeal", args: { leadId: `L-${i}` }, result: { dealId: `D-${i}` }, ok: true },
          { name: "notifySlack", args: { dealId: `D-${i}` }, result: { posted: true }, ok: true },
        ],
        (i) => ({ input: { leadId: `L-${i}` } }),
      ),
      ...nTraces(
        2,
        (i) => [
          { name: "getLead", args: { leadId: `L-s${i}` }, result: { leadId: `L-s${i}` }, ok: true },
          { name: "createDeal", args: { leadId: `L-s${i}` }, result: { dealId: `D-s${i}` }, ok: true },
          { name: "notifySlack", args: { dealId: `D-s${i}` }, result: { posted: true }, ok: true },
        ],
        (i) => ({ id: `skip${i}`, input: { leadId: `L-s${i}` } }),
      ),
    ],
    expect: { kind: "program", programCount: 1, toolsNotIslands: ["enrichCompany"] },
  },
  {
    name: "two-key-tenant",
    traces: nTraces(
      4,
      (i) => {
        const orgId = `org-${i}`;
        const plan = i % 2 === 0 ? "pro" : "team";
        return [
          { name: "getOrg", args: { orgId }, result: { orgId, name: orgId }, ok: true },
          { name: "getPlan", args: { plan }, result: { plan, seats: 8 }, ok: true },
          { name: "createSeat", args: { orgId, plan }, result: { granted: true, orgId, plan }, ok: true },
        ];
      },
      (i) => ({ input: { orgId: `org-${i}`, plan: i % 2 === 0 ? "pro" : "team" } }),
    ),
    expect: {
      kind: "program",
      minSeqLen: 3,
      envelopeKeys: ["orgId", "plan"],
      envelopeHas: ["org-0", "org-1", "pro", "team"],
    },
  },
  {
    name: "inventory-three-field",
    traces: nTraces(
      4,
      (i) => {
        const items = [
          { sku: `sku-${i}-a`, qty: 2, warehouse: "east" },
          { sku: `sku-${i}-b`, qty: 5, warehouse: "west" },
          { sku: `sku-${i}-c`, qty: 3, warehouse: "east" },
        ];
        return [
          { name: "listStock", args: { loc: `LOC-${i}` }, result: { items }, ok: true },
          ...items.map((it) => ({
            name: "insertStock",
            args: { sku: it.sku, qty: it.qty, warehouse: it.warehouse },
            result: { allocated: it.sku, qty: it.qty },
            ok: true,
          })),
          { name: "commitStock", args: { loc: `LOC-${i}` }, result: { committed: true }, ok: true },
        ];
      },
      (i) => ({ input: { loc: `LOC-${i}` } }),
    ),
    expect: {
      kind: "program",
      hasLoop: true,
      loopOverPath: "items",
      loopArgKeys: ["sku", "qty", "warehouse"],
    },
  },
  {
    name: "map-reduce-merge",
    traces: nTraces(
      4,
      (i) => {
        const rows = [
          { id: `r${i}-0`, src: `s${i}-0` },
          { id: `r${i}-1`, src: `s${i}-1` },
          { id: `r${i}-2`, src: `s${i}-2` },
        ];
        const mapped = rows.map((r) => ({ id: r.id, out: `m-${r.id}` }));
        return [
          { name: "listRows", args: { batch: `B${i}` }, result: { rows }, ok: true },
          ...rows.map((r, j) => ({ name: "mapRow", args: { id: r.id }, result: mapped[j], ok: true })),
          { name: "writeRows", args: { rows: mapped }, result: { merged: true, n: mapped.length }, ok: true },
        ];
      },
      (i) => ({ input: { batch: `B${i}` } }),
    ),
    expect: {
      kind: "program",
      hasLoop: true,
      loopOverPath: "rows",
      bindFromLoop: { tool: "writeRows", arg: "rows" },
    },
  },
  {
    name: "graphql-relay-edges",
    traces: nTraces(
      4,
      (i) => {
        const edges = [0, 1, 2].map((j) => ({
          node: { id: `ISSUE-${i}-${j}`, title: `t-${i}-${j}`, number: j + 1 },
        }));
        return [
          { name: "listIssues", args: { repo: `r-${i}` }, result: { edges }, ok: true },
          ...edges.map((e) => ({
            name: "updateIssue",
            args: { id: e.node.id, title: e.node.title },
            result: { id: e.node.id, updated: true },
            ok: true,
          })),
          { name: "publishDigest", args: { repo: `r-${i}` }, result: { published: true }, ok: true },
        ];
      },
      (i) => ({ input: { repo: `r-${i}` } }),
    ),
    expect: {
      kind: "program",
      hasLoop: true,
      loopOverPath: "edges",
      loopArgKeys: ["id", "title"],
    },
  },
  {
    name: "json-post-sso",
    traces: nTraces(
      4,
      (i) => {
        const orgId = `org-${i}`;
        const email = `u${i}@co.com`;
        const name = `User ${i}`;
        return [
          { name: "getOrg", args: { orgId }, result: { orgId, name: `Org ${i}` }, ok: true },
          {
            name: "createUser",
            args: { body: { user: { email, name }, orgId } },
            result: { userId: `U-${i}` },
            ok: true,
          },
          { name: "grantRole", args: { userId: `U-${i}`, role: "member" }, result: { granted: true }, ok: true },
          { name: "sendInvite", args: { userId: `U-${i}`, email }, result: { sent: true }, ok: true },
        ];
      },
      (i) => ({ input: { orgId: `org-${i}`, email: `u${i}@co.com`, name: `User ${i}` } }),
    ),
    expect: {
      kind: "program",
      minSeqLen: 4,
      envelopeHas: ["org-0", "u0@co.com"],
    },
  },
  {
    name: "search-topk-prefix",
    traces: nTraces(
      4,
      (i) => {
        const hits = Array.from({ length: 10 }, (_, j) => ({ id: `h${i}-${j}`, score: 10 - j }));
        const top = hits.slice(0, 3);
        return [
          { name: "searchHits", args: { q: `q${i}` }, result: { hits }, ok: true },
          ...top.map((h) => ({ name: "takeHit", args: { id: h.id }, result: { id: h.id, took: true }, ok: true })),
          { name: "writeDigest", args: { q: `q${i}` }, result: { wrote: true }, ok: true },
        ];
      },
      (i) => ({ input: { q: `q${i}` } }),
    ),
    expect: { kind: "program", hasLoop: true, loopOverSlice: true },
  },
  {
    name: "search-random-subset",
    traces: nTraces(
      4,
      (i) => {
        const hits = Array.from({ length: 10 }, (_, j) => ({ id: `h${i}-${j}` }));
        const picked = [hits[1], hits[4], hits[7]];
        return [
          { name: "searchHits", args: { q: `q${i}` }, result: { hits }, ok: true },
          ...picked.map((h) => ({ name: "takeHit", args: { id: h!.id }, result: { took: true }, ok: true })),
          { name: "writeDigest", args: { q: `q${i}` }, result: { wrote: true }, ok: true },
        ];
      },
      (i) => ({ input: { q: `q${i}` } }),
    ),
    expect: { kind: "refusal", code: "read_set_mismatch" },
  },
  {
    name: "k8s-poll-ready",
    traces: nTraces(
      4,
      (i) => {
        const deploy = `d-${i}`;
        return [
          { name: "getRollout", args: { deploy }, result: { deploy, ready: false }, ok: true },
          { name: "getRollout", args: { deploy }, result: { deploy, ready: false }, ok: true },
          { name: "getRollout", args: { deploy }, result: { deploy, ready: true }, ok: true },
          { name: "verifyRollout", args: { deploy }, result: { verified: true }, ok: true },
        ];
      },
      (i) => ({ input: { deploy: `d-${i}` } }),
    ),
    expect: { kind: "program", hasLoop: true, hasUntil: true },
  },
  {
    name: "k8s-poll-never-ready",
    traces: nTraces(
      3,
      (i) => {
        const deploy = `d-${i}`;
        return [
          { name: "getRollout", args: { deploy }, result: { deploy, ready: false }, ok: true },
          { name: "getRollout", args: { deploy }, result: { deploy, ready: false }, ok: true },
          { name: "getRollout", args: { deploy }, result: { deploy, ready: false }, ok: true },
          { name: "verifyRollout", args: { deploy }, result: { verified: true }, ok: true },
        ];
      },
      (i) => ({ input: { deploy: `d-${i}` } }),
    ),
    expect: { kind: "refusal", code: "unbound_foreach" },
  },
  {
    name: "saga-hold-compensate",
    traces: [
      ...nTraces(
        3,
        (i) => [
          { name: "getHold", args: { hold: `H-${i}` }, result: { state: "ok", hold: `H-${i}` }, ok: true },
          { name: "captureFunds", args: { hold: `H-${i}` }, result: { captured: true }, ok: true },
          { name: "notifyLedger", args: { hold: `H-${i}` }, result: { notified: true }, ok: true },
        ],
        (i) => ({ input: { hold: `H-${i}` } }),
      ),
      ...nTraces(
        3,
        (i) => [
          { name: "getHold", args: { hold: `H-f${i}` }, result: { state: "fail", hold: `H-f${i}` }, ok: true },
          { name: "cancelHold", args: { hold: `H-f${i}` }, result: { cancelled: true }, ok: true },
          { name: "notifyLedger", args: { hold: `H-f${i}` }, result: { notified: true }, ok: true },
        ],
        (i) => ({ id: `fail${i}`, input: { hold: `H-f${i}` } }),
      ),
    ],
    expect: { kind: "program", hasBranch: true },
  },
  {
    name: "sentry-filter-level",
    traces: nTraces(
      3,
      (i) => {
        const events = [
          { id: `e${i}-0`, level: "info" },
          { id: `e${i}-1`, level: "error" },
          { id: `e${i}-2`, level: "warn" },
          { id: `e${i}-3`, level: "error" },
          { id: `e${i}-4`, level: "debug" },
        ];
        const taken = events.filter((e) => e.level === "error");
        return [
          { name: "listEvents", args: { q: `svc-${i}` }, result: { events }, ok: true },
          ...taken.map((e) => ({
            name: "pageOncall",
            args: { id: e.id },
            result: { paged: true, id: e.id },
            ok: true,
          })),
          { name: "writeDigest", args: { q: `svc-${i}` }, result: { wrote: true }, ok: true },
        ];
      },
      (i) => ({ input: { q: `svc-${i}` } }),
    ),
    expect: { kind: "program", hasLoop: true, loopOverFilter: true },
  },
  {
    name: "hris-lookup-join",
    traces: nTraces(
      3,
      (i) => {
        const teams = [
          { id: `t${i}-eng`, name: "Eng" },
          { id: `t${i}-sales`, name: "Sales" },
        ];
        const people = [
          { id: `p${i}-a`, deptId: teams[0]!.id },
          { id: `p${i}-b`, deptId: teams[1]!.id },
          { id: `p${i}-c`, deptId: teams[0]!.id },
        ];
        return [
          { name: "listPeople", args: { org: `org-${i}` }, result: { people }, ok: true },
          { name: "listTeams", args: { org: `org-${i}` }, result: { teams }, ok: true },
          ...people.map((p) => {
            const team = teams.find((t) => t.id === p.deptId)!;
            return {
              name: "assignSeat",
              args: { person: p.id, teamName: team.name },
              result: { assigned: true },
              ok: true,
            };
          }),
          { name: "ackHris", args: { org: `org-${i}` }, result: { ok: true }, ok: true },
        ];
      },
      (i) => ({ input: { org: `org-${i}` } }),
    ),
    expect: { kind: "program", hasLoop: true, loopArgKeys: ["person"], loopArgLookup: true },
  },
  {
    name: "oauth-token-carry",
    traces: nTraces(
      4,
      (i) => {
        const u = i % 2;
        const token = `tok-${u}`;
        return [
          { name: "login", args: { user: `u${u}` }, result: { token, seq: 1000 + i * 17 }, ok: true },
          { name: "getProfile", args: { token }, result: { user: `u${u}` }, ok: true },
          { name: "getBilling", args: { token }, result: { plan: "pro" }, ok: true },
          { name: "getUsage", args: { token }, result: { calls: 9 }, ok: true },
          { name: "revokeToken", args: { token }, result: { revoked: true }, ok: true },
        ];
      },
      (i) => ({ input: { user: `u${i % 2}` } }),
    ),
    expect: { kind: "program", minSeqLen: 5, toolsNotIslands: ["login"] },
  },
  {
    name: "transcode-chunk",
    traces: nTraces(
      3,
      (i) => {
        const files = Array.from({ length: 8 }, (_, j) => `f${i}-${j}.mov`);
        const chunks = [files.slice(0, 4), files.slice(4, 8)];
        return [
          { name: "listAssets", args: { job: `job-${i}` }, result: { files }, ok: true },
          ...chunks.map((items) => ({ name: "processBatch", args: { items }, result: { n: items.length }, ok: true })),
          { name: "publishJob", args: { job: `job-${i}` }, result: { ok: true }, ok: true },
        ];
      },
      (i) => ({ input: { job: `job-${i}` } }),
    ),
    expect: { kind: "program", hasLoop: true, loopOverChunk: true },
  },
  {
    name: "catalog-zip",
    traces: nTraces(
      3,
      (i) => {
        const skus = [{ sku: `s${i}-a` }, { sku: `s${i}-b` }, { sku: `s${i}-c` }];
        const prices = [{ cents: 100 + i }, { cents: 200 + i }, { cents: 300 + i }];
        return [
          { name: "listSkus", args: { cat: `c${i}` }, result: { skus }, ok: true },
          { name: "listPrices", args: { cat: `c${i}` }, result: { prices }, ok: true },
          ...skus.map((s, j) => ({
            name: "setPrice",
            args: { sku: s.sku, cents: prices[j]!.cents },
            result: { ok: true },
            ok: true,
          })),
          { name: "ackCatalog", args: { cat: `c${i}` }, result: { ok: true }, ok: true },
        ];
      },
      (i) => ({ input: { cat: `c${i}` } }),
    ),
    expect: { kind: "program", hasLoop: true, loopOverZip: true, loopArgKeys: ["sku", "cents"] },
  },
  {
    name: "cms-flatten-blocks",
    traces: nTraces(
      3,
      (i) => {
        const sections = [{ blocks: [{ id: `b${i}-0` }, { id: `b${i}-1` }] }, { blocks: [{ id: `b${i}-2` }] }];
        const blocks = sections.flatMap((s) => s.blocks);
        return [
          { name: "listPage", args: { site: `s${i}` }, result: { sections }, ok: true },
          ...blocks.map((b) => ({
            name: "publishBlock",
            args: { id: b.id },
            result: { ok: true, id: b.id },
            ok: true,
          })),
          { name: "ackSite", args: { site: `s${i}` }, result: { ok: true }, ok: true },
        ];
      },
      (i) => ({ input: { site: `s${i}` } }),
    ),
    expect: { kind: "program", hasLoop: true, loopOverFlatten: true },
  },
  {
    name: "logs-group-by-level",
    traces: nTraces(
      3,
      (i) => {
        const events = [
          { id: `e${i}-0`, level: "info" },
          { id: `e${i}-1`, level: "error" },
          { id: `e${i}-2`, level: "info" },
          { id: `e${i}-3`, level: "error" },
          { id: `e${i}-4`, level: "info" },
          { id: `e${i}-5`, level: "error" },
        ];
        const groups = [
          { items: events.filter((e) => e.level === "info") },
          { items: events.filter((e) => e.level === "error") },
        ];
        return [
          { name: "listLogs", args: { svc: `svc-${i}` }, result: { events }, ok: true },
          ...groups.map((g) => ({
            name: "flushLevel",
            args: { items: g.items, level: g.items[0]!.level },
            result: { flushed: true, n: g.items.length },
            ok: true,
          })),
          { name: "ackLogs", args: { svc: `svc-${i}` }, result: { acked: true }, ok: true },
        ];
      },
      (i) => ({ input: { svc: `svc-${i}` } }),
    ),
    expect: { kind: "program", hasLoop: true, loopOverGroup: true, loopArgKeys: ["items", "level"] },
  },
  {
    name: "unique-work-horizon",
    traces: [
      {
        id: "h0",
        llmCalls: 5,
        duration_ms: 40,
        cost_cents: 5,
        complete: true,
        input: { id: "H-0" },
        events: [
          { name: "scanInbox", args: { id: "H-0" }, result: { ok: true }, ok: true },
          { name: "triageTicket", args: { id: "H-0" }, result: { ok: true }, ok: true },
          { name: "pageOwner", args: { id: "H-0" }, result: { ok: true }, ok: true },
          { name: "closeTicket", args: { id: "H-0" }, result: { ok: true }, ok: true },
        ],
      },
      {
        id: "h1",
        llmCalls: 5,
        duration_ms: 40,
        cost_cents: 5,
        complete: true,
        input: { id: "H-1" },
        events: [
          { name: "pullMetrics", args: { id: "H-1" }, result: { ok: true }, ok: true },
          { name: "plotChart", args: { id: "H-1" }, result: { ok: true }, ok: true },
          { name: "writeMemo", args: { id: "H-1" }, result: { ok: true }, ok: true },
          { name: "shareDeck", args: { id: "H-1" }, result: { ok: true }, ok: true },
        ],
      },
      {
        id: "h2",
        llmCalls: 5,
        duration_ms: 40,
        cost_cents: 5,
        complete: true,
        input: { id: "H-2" },
        events: [
          { name: "cloneRepo", args: { id: "H-2" }, result: { ok: true }, ok: true },
          { name: "runTests", args: { id: "H-2" }, result: { ok: true }, ok: true },
          { name: "openPr", args: { id: "H-2" }, result: { ok: true }, ok: true },
          { name: "mergePr", args: { id: "H-2" }, result: { ok: true }, ok: true },
        ],
      },
      {
        id: "h3",
        llmCalls: 5,
        duration_ms: 40,
        cost_cents: 5,
        complete: true,
        input: { id: "H-3" },
        events: [
          { name: "bookRoom", args: { id: "H-3" }, result: { ok: true }, ok: true },
          { name: "inviteGuests", args: { id: "H-3" }, result: { ok: true }, ok: true },
          { name: "orderCatering", args: { id: "H-3" }, result: { ok: true }, ok: true },
          { name: "sendAgenda", args: { id: "H-3" }, result: { ok: true }, ok: true },
        ],
      },
    ],
    expect: { kind: "empty" },
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
