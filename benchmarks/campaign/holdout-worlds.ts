/**
 * Holdout campaign worlds: CRM / calendar / payments / cart.
 *
 * Deliberately NOT a retune of desk, orders, etl, incident, research, or
 * thrash. These exist so compiling is scored on shapes the original
 * campaign never trained: a sales pipeline, a two-field calendar goal,
 * a nested billing id, and a loop over `{ sku, qty }` objects (not a
 * string array).
 *
 * Same World contract as worlds.ts: tools, island, script, done, terminal,
 * check, optional fidelity.
 */
import type { IslandCaller } from "@eden/ir";
import { hashStr, type CallResult, type World } from "./worlds";

const THINK_NOTE = "agent think time is charged by the driver, not the world";
void THINK_NOTE;

function ok(v: unknown): CallResult {
  return { ok: true, value: v };
}

/** Per-process ordinal so identical-entity stretches do not hash-collapse. */
let holdoutOrd = 0;
function nextOrd(): number {
  return ++holdoutOrd;
}

function occurrences(goals: Array<Record<string, unknown>>, key: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const g of goals) {
    const k = String(g[key]);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

function occurrencesBy(goals: Array<Record<string, unknown>>, keyOf: (g: Record<string, unknown>) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const g of goals) {
    const k = keyOf(g);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

function dupCheck(
  label: string,
  goals: Array<Record<string, unknown>>,
  key: string,
  counters: Array<{ name: string; get: (id: string) => number }>,
): string[] {
  const bad: string[] = [];
  const occ = occurrences(goals, key);
  for (const [id, n] of occ) {
    for (const c of counters) {
      const got = c.get(id);
      if (got > n) bad.push(`${label}:${id}: ${c.name} ran ${got}x across ${n} stretch(es) — duplicated`);
    }
  }
  return bad;
}

function stubIsland(): IslandCaller {
  return async () => ({ ok: false });
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ */
/* CRM — getLead → enrichCompany → createDeal → assignOwner → slack   */
/* Linear pipeline. Goal { leadId }. No judgment island, no skip.   */
/* ------------------------------------------------------------------ */

export const CRM_IDS = ["L-4101", "L-4102", "L-4103", "L-4104"] as const;

type CrmState = {
  deals: Map<string, number>;
  assigns: Map<string, number>;
  slacks: Map<string, number>;
};

export function createCrm(): World {
  const st: CrmState = { deals: new Map(), assigns: new Map(), slacks: new Map() };
  const leads: Record<string, { company: string; email: string }> = {};
  for (const id of CRM_IDS) {
    leads[id] = { company: `Co ${id}`, email: `${id.toLowerCase()}@holdout.example` };
  }
  return {
    name: "crm",
    island: () => stubIsland(),
    tools: () => ({
      getLead: {
        description: "Fetch a CRM lead by id.",
        execute: async ({ leadId }) => {
          await Bun.sleep(12);
          const row = leads[String(leadId)] ?? { company: "unknown", email: "" };
          return { leadId, company: row.company, email: row.email, seq: nextOrd() };
        },
      },
      enrichCompany: {
        description: "Enrich firmographics for the lead's company.",
        execute: async ({ company }) => {
          await Bun.sleep(18);
          return { company, employees: 40 + (nextOrd() % 90), seq: nextOrd() };
        },
      },
      createDeal: {
        description: "Open a deal for the lead. Mutating.",
        execute: async ({ leadId }, ctx) => {
          await Bun.sleep(22);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          const id = String(leadId);
          st.deals.set(id, (st.deals.get(id) ?? 0) + 1);
          return { dealId: `D-${id}`, created: true, leadId };
        },
      },
      assignOwner: {
        description: "Assign an owner to the deal. Mutating.",
        execute: async ({ leadId }, ctx) => {
          await Bun.sleep(16);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          const id = String(leadId);
          st.assigns.set(id, (st.assigns.get(id) ?? 0) + 1);
          return { assigned: true, leadId };
        },
      },
      notifySlack: {
        description: "Notify the sales channel. Mutating.",
        execute: async ({ leadId }, ctx) => {
          await Bun.sleep(20);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          const id = String(leadId);
          st.slacks.set(id, (st.slacks.get(id) ?? 0) + 1);
          return { slacked: true, leadId };
        },
      },
    }),
    async *script(goal) {
      const leadId = String(goal.leadId);
      const lead = yield { tool: "getLead", args: { leadId } };
      const company = (lead.value as { company?: string })?.company ?? "unknown";
      yield { tool: "enrichCompany", args: { company, leadId } };
      yield { tool: "createDeal", args: { leadId } };
      yield { tool: "assignOwner", args: { leadId } };
      const slack = yield { tool: "notifySlack", args: { leadId } };
      void slack;
    },
    done: (v) => Boolean((v as { slacked?: boolean })?.slacked),
    terminal: "notifySlack",
    check(doneGoals) {
      return dupCheck("crm", doneGoals, "leadId", [
        { name: "createDeal", get: (id) => st.deals.get(id) ?? 0 },
        { name: "assignOwner", get: (id) => st.assigns.get(id) ?? 0 },
        { name: "notifySlack", get: (id) => st.slacks.get(id) ?? 0 },
      ]);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Calendar — listBusy → createEvent → sendInvite → addReminder       */
/* Goal { when, title }. Exactly-once events. Two-field input.      */
/* ------------------------------------------------------------------ */

export const CAL_SLOTS = [
  { when: "2026-09-02T10:00:00Z", title: "Q3 planning" },
  { when: "2026-09-03T14:30:00Z", title: "Design review" },
  { when: "2026-09-04T09:00:00Z", title: "Customer onboard" },
  { when: "2026-09-05T16:00:00Z", title: "Holdout retro" },
] as const;

function calKey(when: unknown, title: unknown): string {
  return `${String(when)}|${String(title)}`;
}

type CalState = {
  events: Map<string, number>;
  invites: Map<string, number>;
  reminders: Map<string, number>;
};

export function createCalendar(): World {
  const st: CalState = { events: new Map(), invites: new Map(), reminders: new Map() };
  return {
    name: "calendar",
    island: () => stubIsland(),
    tools: () => ({
      listBusy: {
        description: "List busy slots around a proposed time.",
        execute: async ({ when, title }) => {
          await Bun.sleep(14);
          return {
            when,
            title,
            busy: [
              { start: "2026-09-01T09:00:00Z", end: "2026-09-01T09:30:00Z" },
              { start: "2026-09-01T15:00:00Z", end: "2026-09-01T16:00:00Z" },
            ],
            seq: nextOrd(),
          };
        },
      },
      createEvent: {
        description: "Create the calendar event. Mutating.",
        execute: async ({ when, title }, ctx) => {
          await Bun.sleep(24);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          const k = calKey(when, title);
          st.events.set(k, (st.events.get(k) ?? 0) + 1);
          return { eventId: `evt-${hashStr(k).toString(16)}`, created: true, when, title };
        },
      },
      sendInvite: {
        description: "Send attendee invites. Mutating.",
        execute: async ({ eventId, title }, ctx) => {
          await Bun.sleep(18);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          const k = String(eventId);
          st.invites.set(k, (st.invites.get(k) ?? 0) + 1);
          return { invited: true, eventId, title };
        },
      },
      addReminder: {
        description: "Add a reminder on the event.",
        execute: async ({ eventId }, ctx) => {
          await Bun.sleep(10);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          const k = String(eventId);
          st.reminders.set(k, (st.reminders.get(k) ?? 0) + 1);
          return { reminded: true, eventId };
        },
      },
    }),
    async *script(goal) {
      const when = String(goal.when);
      const title = String(goal.title);
      yield { tool: "listBusy", args: { when, title } };
      const created = yield { tool: "createEvent", args: { when, title } };
      const eventId = (created.value as { eventId?: string })?.eventId ?? `evt-${when}`;
      yield { tool: "sendInvite", args: { eventId, title } };
      const rem = yield { tool: "addReminder", args: { eventId, when } };
      void rem;
    },
    done: (v) => Boolean((v as { reminded?: boolean })?.reminded),
    terminal: "addReminder",
    check(doneGoals) {
      const bad: string[] = [];
      const occ = occurrencesBy(doneGoals, (g) => calKey(g.when, g.title));
      for (const [k, n] of occ) {
        const ev = st.events.get(k) ?? 0;
        if (ev > n) bad.push(`calendar:${k}: createEvent ran ${ev}x across ${n} stretch(es) — duplicated`);
      }
      // Invites/reminders are keyed by eventId derived from the slot; a second
      // createEvent for the same slot is the duplication that matters.
      return bad;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Payments — nested { customer: { billing: { id } } } then invoice, */
/* charge, receipt. Goal { email }. Exactly-once charges.              */
/* ------------------------------------------------------------------ */

export const PAY_EMAILS = [
  "ada@holdout.example",
  "ben@holdout.example",
  "cam@holdout.example",
  "drew@holdout.example",
] as const;

type PayState = {
  invoices: Map<string, number>;
  charges: Map<string, number>;
  receipts: Map<string, number>;
};

export function createPayments(): World {
  const st: PayState = { invoices: new Map(), charges: new Map(), receipts: new Map() };
  return {
    name: "payments",
    island: () => stubIsland(),
    tools: () => ({
      getCustomer: {
        description: "Fetch a customer. Nested billing id lives under customer.billing.id.",
        execute: async ({ email }) => {
          await Bun.sleep(16);
          const e = String(email);
          return {
            customer: { billing: { id: `bill-${hashStr(e).toString(16)}` } },
            email: e,
            seq: nextOrd(),
          };
        },
      },
      createInvoice: {
        description: "Create an invoice for the billing customer. Mutating.",
        execute: async ({ customerId, email }, ctx) => {
          await Bun.sleep(20);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          const k = String(email);
          st.invoices.set(k, (st.invoices.get(k) ?? 0) + 1);
          return { invoiceId: `inv-${customerId}`, customerId, email };
        },
      },
      createCharge: {
        description: "Charge the invoice. Mutating.",
        execute: async ({ invoiceId, email }, ctx) => {
          await Bun.sleep(28);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          const k = String(email);
          st.charges.set(k, (st.charges.get(k) ?? 0) + 1);
          return { charged: true, invoiceId, email };
        },
      },
      sendReceipt: {
        description: "Email the receipt. Mutating.",
        execute: async ({ email }, ctx) => {
          await Bun.sleep(22);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          const k = String(email);
          st.receipts.set(k, (st.receipts.get(k) ?? 0) + 1);
          return { receiptSent: true, email };
        },
      },
    }),
    async *script(goal) {
      const email = String(goal.email);
      const got = yield { tool: "getCustomer", args: { email } };
      const customerId =
        (got.value as { customer?: { billing?: { id?: string } } })?.customer?.billing?.id ?? "bill-missing";
      const inv = yield { tool: "createInvoice", args: { customerId, email } };
      const invoiceId = (inv.value as { invoiceId?: string })?.invoiceId ?? `inv-${customerId}`;
      yield { tool: "createCharge", args: { invoiceId, email } };
      const rec = yield { tool: "sendReceipt", args: { email } };
      void rec;
    },
    done: (v) => Boolean((v as { receiptSent?: boolean })?.receiptSent),
    terminal: "sendReceipt",
    check(doneGoals) {
      return dupCheck("payments", doneGoals, "email", [
        { name: "createInvoice", get: (id) => st.invoices.get(id) ?? 0 },
        { name: "createCharge", get: (id) => st.charges.get(id) ?? 0 },
        { name: "sendReceipt", get: (id) => st.receipts.get(id) ?? 0 },
      ]);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Cart — listCart returns { items: [{ sku, qty }, ...] } (NOT a     */
/* string array). reserveSku per sku, then checkoutCart. Width 3.     */
/* Compiler currently binds loop items via `.id` or whole-item     */
/* equality; sku/qty objects may refuse until that bind lands.       */
/* ------------------------------------------------------------------ */

export const CART_IDS = ["CART-81", "CART-82", "CART-83", "CART-84"] as const;
export const CART_WIDTH = 3;

export function skusFor(cart: string): string[] {
  return Array.from({ length: CART_WIDTH }, (_, i) => `${cart}-SKU-${String.fromCharCode(65 + i)}`);
}

type CartState = {
  reserves: Map<string, number>;
  checkouts: Map<string, number>;
};

export function createCart(): World {
  const st: CartState = { reserves: new Map(), checkouts: new Map() };
  return {
    name: "cart",
    island: () => stubIsland(),
    tools: () => ({
      listCart: {
        description: "List cart line items as objects { sku, qty }, not strings.",
        execute: async ({ cart }) => {
          await Bun.sleep(12);
          const items = skusFor(String(cart)).map((sku) => ({ sku, qty: 1 + (nextOrd() % 4) }));
          return { items, cart, seq: nextOrd() };
        },
      },
      reserveSku: {
        description: "Reserve inventory for one sku. Mutating.",
        execute: async ({ sku }, ctx) => {
          await Bun.sleep(10);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          const k = String(sku);
          st.reserves.set(k, (st.reserves.get(k) ?? 0) + 1);
          return { reserved: true, sku };
        },
      },
      checkoutCart: {
        description: "Check out the cart. Mutating.",
        execute: async ({ cart }, ctx) => {
          await Bun.sleep(24);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          const id = String(cart);
          st.checkouts.set(id, (st.checkouts.get(id) ?? 0) + 1);
          return { checkedOut: true, cart };
        },
      },
    }),
    async *script(goal) {
      const cart = String(goal.cart);
      const listed = yield { tool: "listCart", args: { cart } };
      const items = ((listed.value as { items?: Array<{ sku?: string; qty?: number }> })?.items ?? []) as Array<{
        sku?: string;
        qty?: number;
      }>;
      for (const it of items) {
        yield { tool: "reserveSku", args: { sku: it.sku, qty: it.qty } };
      }
      const done = yield { tool: "checkoutCart", args: { cart } };
      void done;
    },
    done: (v) => Boolean((v as { checkedOut?: boolean })?.checkedOut),
    terminal: "checkoutCart",
    check(doneGoals) {
      const bad: string[] = [];
      const occ = occurrences(doneGoals, "cart");
      for (const [id, n] of occ) {
        const co = st.checkouts.get(id) ?? 0;
        if (co > n) bad.push(`cart:${id}: checkoutCart ran ${co}x across ${n} stretch(es) — duplicated`);
        for (const sku of skusFor(id)) {
          const r = st.reserves.get(sku) ?? 0;
          if (r > n) bad.push(`cart:${id}: reserveSku ${sku} ran ${r}x across ${n} stretch(es) — duplicated`);
        }
      }
      return bad;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Holdout noise — shuffled unique sequences. Nothing to mine.      */
/* Distinct tool names from negative-worlds createNoise.            */
/* ------------------------------------------------------------------ */

const HOLDOUT_NOISE_TOOLS = [
  "probeLead",
  "pingSlot",
  "quoteRate",
  "listTags",
  "scanInbox",
  "markRead",
  "touchFile",
  "noopPing",
] as const;

export const NOISE_IDS = ["NH-0", "NH-1", "NH-2", "NH-3", "NH-4", "NH-5"] as const;

export function createHoldoutNoise(): World {
  const toolDefs = (): Record<string, { description: string; execute: (a: Record<string, unknown>) => Promise<unknown> }> => {
    const out: Record<string, { description: string; execute: (a: Record<string, unknown>) => Promise<unknown> }> = {};
    for (const name of HOLDOUT_NOISE_TOOLS) {
      out[name] = {
        description: `holdout-noise tool ${name}`,
        execute: async ({ id }) => {
          await Bun.sleep(8);
          return { name, id, seq: nextOrd() };
        },
      };
    }
    return out;
  };
  return {
    name: "holdout-noise",
    island: () => stubIsland(),
    tools: () => toolDefs(),
    async *script(goal) {
      const id = String(goal.id);
      const rng = mulberry32(hashStr(id));
      const picks = [...HOLDOUT_NOISE_TOOLS];
      for (let i = picks.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const tmp = picks[i]!;
        picks[i] = picks[j]!;
        picks[j] = tmp;
      }
      const seq = picks.slice(0, 6);
      let last: CallResult | undefined;
      for (const tool of seq) {
        last = yield { tool, args: { id } };
      }
      void last;
    },
    done: () => false,
    terminal: "noopPing",
    check() {
      return [];
    },
  };
}

export const HOLDOUT_WORLD_FACTORIES = [createCrm, createCalendar, createPayments, createCart] as const;

export { ok };
