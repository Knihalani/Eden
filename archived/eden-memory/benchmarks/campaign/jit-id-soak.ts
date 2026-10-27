/**
 * Wave 22.2 hold-out JIT soak — entity ids and URIs that did not inform
 * the original github/kubectl/desk fixture. Same bar: precision ≥ 0.95
 * among steered turns, unique-work and vague transcripts surface zero schemas.
 *
 *   bun run benchmarks/campaign/jit-id-soak.ts
 */
import { call, runHoldoutSoak, soakProg, type HoldoutTurn } from "./jit-holdout-lib";

const STRIPE_CUS = "cus_8kQ2Lp0NaBcd";
const SHOP_GID = "gid://shopify/Order/5988771123";
const S3_URI = "s3://analytics-prod/reports/2026/08/export.parquet";
const EMAIL = "jordan@acme.io";
const UUID = "8f14e45f-ea09-48b1-9d4c-0123456789ab";
const ARN = "arn:aws:lambda:us-east-1:123456789012:function:invoice-worker";
const TWILIO = "SM4a3c2b1d0e9f8a7b6c5d4e3f2a1b0c9d";
const SALESFORCE = "0015g00000AbCdEFGH";
const E164 = "+14155552671";
const INCIDENT = "checkout-5xx";
const ORDER = "O-7001";
const SLACK = "U0A1B2C3D";
const STRIPE_API = "https://api.stripe.com/v1/customers/cus_8kQ2Lp0NaBcd";
const JIRA = "ENG-8841";
const LINEAR = "LIN-4412";
const MONGO = "507f1f77bcf86cd799439011";
const SQUARE = "sqid_9KxLmN0pQr";

export const PROGRAMS = [
  soakProg({
    name: "stripe_customer_invoices",
    seq: ["getCustomer", "listInvoices"],
    envelope: { id: [STRIPE_CUS] },
  }),
  soakProg({
    name: "shopify_order_cancel",
    seq: ["getOrder", "cancelFulfillment"],
    envelope: { gid: [SHOP_GID] },
  }),
  soakProg({
    name: "s3_report_fetch",
    seq: ["getObject"],
    envelope: { uri: [S3_URI] },
  }),
  soakProg({
    name: "contact_reply",
    seq: ["lookupContact", "sendReply"],
    envelope: { email: [EMAIL] },
  }),
  soakProg({
    name: "session_revoke",
    seq: ["getSession", "revokeTokens"],
    envelope: { session: [UUID] },
  }),
  soakProg({
    name: "lambda_tail",
    seq: ["getFunction", "tailLogs"],
    envelope: { arn: [ARN] },
  }),
  soakProg({
    name: "twilio_redact",
    seq: ["fetchMessage", "redactMedia"],
    envelope: { sid: [TWILIO] },
  }),
  soakProg({
    name: "salesforce_log",
    seq: ["getAccountRecord", "logActivity"],
    envelope: { sfid: [SALESFORCE] },
  }),
  soakProg({
    name: "caller_ticket",
    seq: ["lookupCaller", "openTicket"],
    envelope: { phone: [E164] },
  }),
  soakProg({
    name: "incident_page",
    seq: ["searchLogs", "pageOnCall"],
    envelope: { slug: [INCIDENT] },
  }),
  soakProg({
    name: "orders_lookup",
    seq: ["findOrder"],
    envelope: { id: [ORDER] },
  }),
  soakProg({
    name: "slack_ephemeral",
    seq: ["lookupUser", "postEphemeral"],
    envelope: { user: [SLACK] },
  }),
  soakProg({
    name: "stripe_api_fetch",
    seq: ["web_fetch"],
    url: STRIPE_API,
    envelope: { u: [STRIPE_API] },
  }),
  soakProg({
    name: "compose_ps",
    seq: ["Bash"],
    cmd: "docker compose ps --format json",
  }),
  soakProg({
    name: "psql_who",
    seq: ["Bash"],
    cmd: "psql -c 'select 1'",
  }),
  soakProg({
    name: "jira_eng",
    seq: ["getIssue", "addComment"],
    envelope: { key: [JIRA] },
  }),
  soakProg({
    name: "linear_issue",
    seq: ["getLinearIssue", "assign"],
    envelope: { key: [LINEAR] },
  }),
  soakProg({
    name: "mongo_doc",
    seq: ["findOne", "projectFields"],
    envelope: { oid: [MONGO] },
  }),
  soakProg({
    name: "square_customer",
    seq: ["getSquareCustomer"],
    envelope: { id: [SQUARE] },
  }),
];

export function idSoakTurns(): HoldoutTurn[] {
  return [
    {
      label: "stripe-cus",
      expect: "stripe_customer_invoices",
      messages: [{ role: "user", content: `pull invoices for customer ${STRIPE_CUS} this morning` }],
      call: call("getCustomer", { id: STRIPE_CUS }),
    },
    {
      label: "shopify-gid",
      expect: "shopify_order_cancel",
      messages: [{ role: "user", content: `cancel fulfillment on ${SHOP_GID}` }],
      call: call("getOrder", { gid: SHOP_GID }),
    },
    {
      label: "s3-uri",
      expect: "s3_report_fetch",
      messages: [{ role: "user", content: `download the parquet at ${S3_URI}` }],
      call: call("getObject", { uri: S3_URI }),
    },
    {
      label: "email",
      expect: "contact_reply",
      messages: [{ role: "user", content: `reply to ${EMAIL} about the outage` }],
      call: call("lookupContact", { email: EMAIL }),
    },
    {
      label: "uuid",
      expect: "session_revoke",
      messages: [{ role: "user", content: `revoke tokens for session ${UUID}` }],
      call: call("getSession", { session: UUID }),
    },
    {
      label: "arn",
      expect: "lambda_tail",
      messages: [{ role: "user", content: `tail logs for ${ARN}` }],
      call: call("getFunction", { arn: ARN }),
    },
    {
      label: "twilio",
      expect: "twilio_redact",
      messages: [{ role: "user", content: `redact media on ${TWILIO}` }],
      call: call("fetchMessage", { sid: TWILIO }),
    },
    {
      label: "salesforce",
      expect: "salesforce_log",
      messages: [{ role: "user", content: `log activity on ${SALESFORCE}` }],
      call: call("getAccountRecord", { sfid: SALESFORCE }),
    },
    {
      label: "e164",
      expect: "caller_ticket",
      messages: [{ role: "user", content: `open a ticket for caller ${E164}` }],
      call: call("lookupCaller", { phone: E164 }),
    },
    {
      label: "incident",
      expect: "incident_page",
      messages: [{ role: "user", content: `page on-call for ${INCIDENT}` }],
      call: call("searchLogs", { slug: INCIDENT }),
    },
    {
      label: "orders",
      expect: "orders_lookup",
      messages: [{ role: "user", content: `where's ${ORDER}` }],
      call: call("findOrder", { id: ORDER }),
    },
    {
      label: "slack",
      expect: "slack_ephemeral",
      messages: [{ role: "user", content: `whisper to ${SLACK} in #ops` }],
      call: call("lookupUser", { user: SLACK }),
    },
    {
      label: "stripe-url",
      expect: "stripe_api_fetch",
      messages: [{ role: "user", content: `GET ${STRIPE_API} and summarize` }],
      call: call("web_fetch", { u: STRIPE_API }),
    },
    {
      label: "compose",
      expect: "compose_ps",
      messages: [{ role: "user", content: "docker compose ps --format json and tell me what's restarting" }],
      call: call("Bash", { command: "docker compose ps --format json" }),
    },
    {
      label: "psql",
      expect: "psql_who",
      messages: [{ role: "user", content: "psql -c 'select 1' please" }],
      call: call("Bash", { command: "psql -c 'select 1'" }),
    },
    {
      label: "jira",
      expect: "jira_eng",
      messages: [{ role: "user", content: `comment on ${JIRA} that the rollback landed` }],
      call: call("getIssue", { key: JIRA }),
    },
    {
      label: "linear",
      expect: "linear_issue",
      messages: [{ role: "user", content: `assign ${LINEAR} to the on-call` }],
      call: call("getLinearIssue", { key: LINEAR }),
    },
    {
      label: "mongo",
      expect: "mongo_doc",
      messages: [{ role: "user", content: `project fields on ${MONGO}` }],
      call: call("findOne", { oid: MONGO }),
    },
    {
      label: "square",
      expect: "square_customer",
      messages: [{ role: "user", content: `lookup Square customer ${SQUARE}` }],
      call: call("getSquareCustomer", { id: SQUARE }),
    },
  ];
}

export function runJitIdSoak() {
  return runHoldoutSoak({ programs: PROGRAMS, turns: idSoakTurns() });
}

if (import.meta.main) {
  const r = runJitIdSoak();
  for (const line of r.lines) console.log(line);
  process.exit(r.pass ? 0 : 1);
}
