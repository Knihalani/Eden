/**
 * Wave 22.2 hold-out — natural-language intents that are not entity-id /
 * kubectl / github / URL soaks. Ranking evidence is envelope tokens spoken
 * in English, not a pasted id, CLI family, or https URL.
 *
 *   bun run benchmarks/campaign/jit-intent-soak.ts
 *   bun run bench:jit-intent-soak
 */
import {
  call,
  runHoldoutSoak,
  soakProg,
  UNIQUE_WORK_MESSAGES,
  VAGUE_MESSAGES,
  type HoldoutTurn,
} from "./jit-holdout-lib";

/** Dense witnesses — distinct from jit-id-soak entities. */
const STANDUP_TITLE = "standup-t2";
const STANDUP_WHEN = "tue-14h";
const LEAD_ID = "L-44";
const FLAG = "flag-checkout2";
const BILLING_EMAIL = "ap@northwind.io";
const PO = "PO-9012";
const SEAT = "SEAT-12";
const TICKET = "TCK-880";
const DNS_ZONE = "harbor-dns2";

export const PROGRAMS = [
  soakProg({
    name: "calendar_standup",
    seq: ["listBusy", "createEvent", "sendInvite"],
    envelope: { title: [STANDUP_TITLE], when: [STANDUP_WHEN] },
  }),
  soakProg({
    name: "crm_qualify",
    seq: ["getLead", "createDeal", "notifySlack"],
    envelope: { leadId: [LEAD_ID] },
  }),
  soakProg({
    name: "flag_rollout",
    seq: ["getFlag", "setRollout"],
    envelope: { flag: [FLAG] },
  }),
  soakProg({
    name: "payments_invoice",
    seq: ["getCustomer", "createInvoice", "createCharge"],
    envelope: { email: [BILLING_EMAIL] },
  }),
  soakProg({
    name: "inventory_po",
    seq: ["getSku", "createPurchaseOrder", "submitPo"],
    envelope: { po: [PO] },
  }),
  soakProg({
    name: "seat_two_phase",
    seq: ["reserveSeat", "confirmSeat"],
    envelope: { seat: [SEAT] },
  }),
  soakProg({
    name: "ticket_escalate",
    seq: ["getTicket", "escalatePriority", "pageOwner"],
    envelope: { ticket: [TICKET] },
  }),
  soakProg({
    name: "dns_upsert",
    seq: ["getZone", "upsertRecord", "verifyDns"],
    envelope: { zone: [DNS_ZONE] },
  }),
];

export function intentSoakTurns(): HoldoutTurn[] {
  return [
    {
      label: "calendar",
      expect: "calendar_standup",
      messages: [
        {
          role: "user",
          content: `schedule the Tuesday standup ${STANDUP_TITLE} at ${STANDUP_WHEN}`,
        },
      ],
      call: call("listBusy", { title: STANDUP_TITLE, when: STANDUP_WHEN }),
    },
    {
      label: "crm",
      expect: "crm_qualify",
      messages: [{ role: "user", content: `qualify lead ${LEAD_ID}` }],
      call: call("getLead", { leadId: LEAD_ID }),
    },
    {
      label: "flags",
      expect: "flag_rollout",
      messages: [{ role: "user", content: `roll ${FLAG} to 20%` }],
      call: call("getFlag", { flag: FLAG }),
    },
    {
      label: "payments",
      expect: "payments_invoice",
      messages: [
        {
          role: "user",
          content: `invoice then charge ${BILLING_EMAIL}`,
        },
      ],
      call: call("getCustomer", { email: BILLING_EMAIL }),
    },
    {
      label: "inventory",
      expect: "inventory_po",
      messages: [{ role: "user", content: `open inventory purchase order ${PO}` }],
      call: call("getSku", { po: PO }),
    },
    {
      label: "seat",
      expect: "seat_two_phase",
      messages: [{ role: "user", content: `two-phase seat hold on ${SEAT}` }],
      call: call("reserveSeat", { seat: SEAT }),
    },
    {
      label: "ticket",
      expect: "ticket_escalate",
      messages: [{ role: "user", content: `escalate ticket ${TICKET}` }],
      call: call("getTicket", { ticket: TICKET }),
    },
    {
      label: "dns",
      expect: "dns_upsert",
      messages: [{ role: "user", content: `upsert the dns record for zone ${DNS_ZONE}` }],
      call: call("getZone", { zone: DNS_ZONE }),
    },
    {
      label: "calendar",
      expect: "calendar_standup",
      messages: [{ role: "user", content: `book ${STANDUP_TITLE} for the team at ${STANDUP_WHEN}` }],
      call: call("listBusy", { title: STANDUP_TITLE, when: STANDUP_WHEN }),
    },
    {
      label: "crm",
      expect: "crm_qualify",
      messages: [{ role: "user", content: `move ${LEAD_ID} through the pipeline` }],
      call: call("getLead", { leadId: LEAD_ID }),
    },
    {
      label: "flags",
      expect: "flag_rollout",
      messages: [{ role: "user", content: `turn up ${FLAG} in production` }],
      call: call("getFlag", { flag: FLAG }),
    },
    {
      label: "payments",
      expect: "payments_invoice",
      messages: [{ role: "user", content: `bill ${BILLING_EMAIL} then take payment` }],
      call: call("getCustomer", { email: BILLING_EMAIL }),
    },
    {
      label: "inventory",
      expect: "inventory_po",
      messages: [{ role: "user", content: `restock against ${PO}` }],
      call: call("getSku", { po: PO }),
    },
    {
      label: "seat",
      expect: "seat_two_phase",
      messages: [{ role: "user", content: `reserve then confirm ${SEAT}` }],
      call: call("reserveSeat", { seat: SEAT }),
    },
    {
      label: "ticket",
      expect: "ticket_escalate",
      messages: [{ role: "user", content: `page on-call for ${TICKET}` }],
      call: call("getTicket", { ticket: TICKET }),
    },
    {
      label: "dns",
      expect: "dns_upsert",
      messages: [{ role: "user", content: `publish ${DNS_ZONE} after the change` }],
      call: call("getZone", { zone: DNS_ZONE }),
    },
  ];
}

export function runJitIntentSoak() {
  return runHoldoutSoak({
    programs: PROGRAMS,
    turns: intentSoakTurns(),
    uniqueWork: UNIQUE_WORK_MESSAGES,
    vague: VAGUE_MESSAGES,
  });
}

if (import.meta.main) {
  const r = runJitIntentSoak();
  for (const line of r.lines) console.log(line);
  process.exit(r.pass ? 0 : 1);
}
