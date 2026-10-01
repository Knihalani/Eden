/**
 * Isolation / logging / OWASP copy.
 *
 * Isolation tests stay one sentence plus the test file that pins them.
 * Published limits cite the same files as PUBLIC_CLAIMS / /proof.
 */

import { claimById, type ClaimKind, type ClaimSource } from "@eden/measure";

export type IsolationClaim = {
  claim: string;
  test: string;
};

export const ISOLATION_CLAIMS: IsolationClaim[] = [
  {
    claim: "Two workspaces that record the same public-API sequence keep their own cluster rows.",
    test: "apps/site/src/tenancy.test.ts",
  },
  {
    claim: "One workspace’s ingest cannot reset another workspace’s stretch count.",
    test: "apps/site/src/tenancy.test.ts",
  },
  {
    claim: "Crossing the knock threshold creates exactly one knock, for the workspace that crossed it.",
    test: "apps/site/src/tenancy.test.ts",
  },
  {
    claim: "Compiled tools stay scoped to the workspace that recorded them.",
    test: "apps/site/src/tenancy.test.ts",
  },
  {
    claim: "Event ids chosen by one workspace cannot swallow another workspace’s events.",
    test: "apps/site/src/tenancy.test.ts",
  },
  {
    claim: "An approved tool’s steps stay frozen; a later ingest cannot rewrite them.",
    test: "apps/site/src/tenancy.test.ts",
  },
  {
    claim: "State-changing routes refuse a POST from another origin.",
    test: "apps/site/src/tenancy.test.ts",
  },
  {
    claim: "A deployment with DATABASE_URL does not hand out the public dev credential.",
    test: "apps/site/src/tenancy.test.ts",
  },
  {
    claim: "A disabled API-key row stays disabled across boots.",
    test: "apps/site/src/tenancy.test.ts",
  },
  {
    claim: "Eden does not synthesise requests to a host it was only shown.",
    test: "apps/site/src/tenancy.test.ts",
  },
  {
    claim: "Result-cache keys include the workspace, so workspace B cannot read workspace A’s cached body.",
    test: "apps/site/src/cache.test.ts",
  },
  {
    claim: "Public-pool keys (rcp:) differ from tenant keys (rc:) and ignore the workspace id.",
    test: "apps/site/src/cache.test.ts",
  },
  {
    claim: "Loopback, private, and cloud-metadata hosts are blocked for egress.",
    test: "apps/site/src/ssrf.test.ts",
  },
  {
    claim: "A redirect into the private network is refused; the internal hop is never issued.",
    test: "apps/site/src/ssrf.test.ts",
  },
  {
    claim: "Authorization is dropped when a redirect changes origin.",
    test: "apps/site/src/ssrf.test.ts",
  },
  {
    claim: "Egress connects to the pinned address while Host stays the hostname.",
    test: "apps/site/src/ssrf.test.ts",
  },
  {
    claim: "A Clerk org that does not bind this workspace cannot approve, pause, or run its tools.",
    test: "apps/control/src/org-binding.test.ts",
  },
  {
    claim: "A second org cannot claim a workspace that is already bound.",
    test: "apps/control/src/org-binding.test.ts",
  },
  {
    claim: "Session A’s remainder does not deny session B’s same-named tool on the same entity.",
    test: "packages/cli/src/remainder.test.ts",
  },
  {
    claim: "Hostile session keys (__proto__, empty, long) stay isolated in the arming store.",
    test: "packages/wrap/src/arming-redteam.test.ts",
  },
  {
    claim: "Read-only fleet claims require an explicit fleetId; empty fleet shares nothing.",
    test: "benchmarks/campaign/fleet-dedupe.test.ts",
  },
  {
    claim: "Mutating tools on the same fleet still write once per session.",
    test: "benchmarks/campaign/fleet-dedupe.test.ts",
  },
  {
    claim: "Hostile fleet keys (__proto__, empty, long) stay Map keys.",
    test: "packages/wrap/src/arming-redteam.test.ts",
  },
  {
    claim: "A composed handoff stays off until a human Approves.",
    test: "apps/control/src/handoff-approve.test.ts",
  },
  {
    claim: "A canary recompile queues a draft; it never turns the live tool On.",
    test: "apps/site/src/canary.test.ts",
  },
  {
    claim: "A control-plane drift replacement never auto-approves; the live tool stays live until a human Approves.",
    test: "apps/control/src/refresh.test.ts",
  },
  {
    claim: "On a managed install, the /v1 bearer gate refuses the public eden_dev credential.",
    test: "apps/web/app/v1/auth.test.ts",
  },
];

export type LimitClaim = {
  id: string;
  claim: string;
  printed: string;
  test: string;
  kind: ClaimKind;
  source: ClaimSource;
  name: string;
};

/**
 * Published limits. Same honesty as /proof. Isolation copy must name oblivious-long.
 * Paths match PUBLIC_CLAIMS.file.
 */
/** Isolation pins. Same statement as PUBLIC_CLAIMS so /isolation, /proof, and eden claims agree. */
function limitPin(id: string): LimitClaim {
  const row = claimById(id);
  if (!row) throw new Error(`PUBLIC_CLAIMS missing ${id}`);
  return {
    id,
    claim: row.statement,
    printed: row.printed,
    test: row.file,
    kind: row.kind,
    source: row.source,
    name: row.name,
  };
}

export const LIMIT_CLAIMS: LimitClaim[] = [
  limitPin("oblivious-long"),
  limitPin("s1b-analogue"),
  limitPin("s1b-live-invoice"),
  limitPin("replica-host-drop"),
  limitPin("ood-long"),
  limitPin("cert-bounds"),
];

export const LIMITS_LEAD =
  "These are pins, not reversals. Equal weight with the isolation tests. Kind and Source sit on the same row as the meter — analogue and retired are not the same class as wrap-path. The live board is /proof and eden claims.";

export const ISO_LIMIT_ROWS = LIMIT_CLAIMS.filter((c) => c.kind === "limit");
export const ISO_ANALOGUE_ROWS = LIMIT_CLAIMS.filter((c) => c.kind === "analogue");
export const ISO_RETIRED_ROWS = LIMIT_CLAIMS.filter((c) => c.kind === "retired");

export const ISO_LIMITS_NOTE =
  "Wrap-path loss, host limit, envelope miss, certification bounds. Not analogue cents. Not a retired invoice. JIT soak PASS lives with the wins.";
export const ISO_ANALOGUE_NOTE =
  "Headless replica TURN_CENTS. Labeled analogue. Not a live Claude Code invoice. Not a campaign win.";
export const ISO_RETIRED_NOTE = "Withdrawn until a file parses. Retired is a result, not a missing row.";

export type OwaspRow = {
  id: string;
  risk: string;
  control: string;
  gap: string;
};

export const OWASP_ROWS: OwaspRow[] = [
  {
    id: "MCP01:2025",
    risk: "Token Mismanagement & Secret Exposure",
    control:
      "Credential-shaped values are redacted at the control-plane ingest boundary. Status and doctor print a key fingerprint, never a prefix of the secret. Cross-origin redirects drop Authorization.",
    gap: "Laptop installs still keep the API key in ~/.eden/config.json as plaintext. That file is not a vault.",
  },
  {
    id: "MCP02:2025",
    risk: "Privilege Escalation via Scope Creep",
    control:
      "State-changing routes require the caller’s Clerk org to match the workspace binding. An approved tool’s steps cannot be rewritten by a later ingest.",
    gap: "Read routes (inbox, receipts, this audit export) are key-gated, not org-gated. A shared bearer token can list another org’s reads on that install.",
  },
  {
    id: "MCP03:2025",
    risk: "Tool Poisoning",
    control:
      "Ingest cannot change what an approved tool does. Canary recompile queues a draft and never writes state On. Shadow replay uses a sandbox, not live writes.",
    gap: "A draft can still track a changed stretch until a human Approves. That is the product, not a second automatic gate.",
  },
  {
    id: "MCP04:2025",
    risk: "Software Supply Chain Attacks & Dependency Tampering",
    control: "bun.lock pins versions for this repository.",
    gap: "Eden does not publish SLSA provenance or signed dependency attestations. We do not claim a supply-chain certification.",
  },
  {
    id: "MCP05:2025",
    risk: "Command Injection & Execution",
    control:
      "Egress blocks loopback, private, and metadata hosts, refuses redirects into those ranges, and pins the resolved address. Compile refuses underdetermined writes rather than guessing arguments.",
    gap: "Laptop wrap still executes recorded Bash against the local registry. Isolation here is host-blocking, not a sandbox.",
  },
  {
    id: "MCP06:2025",
    risk: "Intent Flow Subversion",
    control:
      "Underdetermined writes and commands are compile refusals. A tool turns live only after human Approve. Canary cannot Approve.",
    gap: "Once armed, wrap may steer a later call onto the compiled tool. That is intended serving, not a second approval.",
  },
  {
    id: "MCP07:2025",
    risk: "Insufficient Authentication & Authorization",
    control:
      "Every /v1 route requires a bearer token. Writes take the org gate. CORS echoes only localhost origins. Cross-origin state-changing POSTs are refused.",
    gap: "Same as MCP02: reads are not org-scoped. Unbound workspaces still work in unmanaged (laptop) installs, with a stderr warning.",
  },
  {
    id: "MCP08:2025",
    risk: "Lack of Audit and Telemetry",
    control:
      "Approvals, versions, executions, and refusals export as JSONL and CSV with a sha256 hash chain (eden audit export). Verify fails closed on a spliced or flipped file.",
    gap: "The on-disk SQLite store is not itself an immutable log. The export is the tamper-evident artifact. A broken export never sits on the wrap path.",
  },
  {
    id: "MCP09:2025",
    risk: "Shadow MCP Servers",
    control:
      "eden mcp is an explicit process the operator starts. It speaks only to the wrap control plane with the configured key.",
    gap: "Eden does not inventory or block other MCP servers the agent talks to on the host. Shadow servers are out of scope.",
  },
  {
    id: "MCP10:2025",
    risk: "Context Injection & Over-Sharing",
    control:
      "Redaction at record time. Remainder and mutating armings are session-scoped. Read-only fleet sharing is opt-in (EDEN_FLEET). Result-cache keys include the workspace. Hostile __proto__ session and fleet keys stay isolated.",
    gap: "Anyone holding the workspace key can read compiled program JSON for that workspace. That is the inspect surface, not a separate ACL.",
  },
];

export const LOGGING = {
  title: "Logging — EU AI Act Article 12, aligned, not certified",
  inForce: "Article 12 (automatic recording of events) is cited as in force from 2 August 2026.",
  record:
    "Eden automatically records four event kinds on the control plane: approvals (a tool shipped live), versions (superseded compilations), executions (receipts of compiled runs), and refusals (compile or shadow refusals). Those four are what the export contains.",
  export:
    "Logs are exportable: eden audit export --format jsonl and --format csv. eden audit review is who approved what, when, and which version — tenant-bound. Each record carries sha256 of the canonical payload plus the previous record’s hash. eden audit verify fails closed if a line is spliced or a byte is flipped.",
  retention:
    "Retention floor language: control-plane traces and receipts are capped at 5,000 rows (oldest dropped). Un-uploaded ~/.eden/runs logs are the hot tier, swept after EDEN_RETAIN_DAYS (default 14). eden archive compact folds eligible hot files into warm (receipts, no events) then cold monthly DC+counts (EDEN_WARM_DAYS / EDEN_COLD_MONTHS). This is an operational ceiling, not a legal hold.",
  notClaimed:
    "Eden is not claiming high-risk AI-system certification under the EU AI Act, and this page is not a SOC 2 report. Article 12 alignment here means: automatic logs, exportable, tamper-evident, with a stated retention floor — and an explicit list of what we do not claim.",
};

export const ISO_LEAD = "Each line is a fact we can open a test for. Nothing here is a badge.";

export type PackRow = {
  control: string;
  proves: string;
  path: string;
};

/** Binder rows on /isolation. Paths must exist. Pack index is the auditor document. */
export const PACK = {
  title: "Evidence pack",
  lead: "Aligned, not certified. This page is not a SOC 2 report.",
  index: "docs/evidence-pack.md",
  href: "/pack",
  walk: "Open the pack index, then this table. eden audit review is who/what/when/version (tenant-bound). eden audit export is the full chain. eden doctor names EDEN_NET_ALLOW, including empty. Nothing goes live without human Approve. Kill switches are the EDEN_* rows in docs/ROADMAP.md §15.",
  pool: "Public-pool keys (rcp:) share a body only when three gates hold: the host is on PUBLIC_POOL_HOSTS, the request is credential-free, and the step is GET. The current host is api.github.com. The list is reviewed on every change to that Set — adding a host is a PR that must show unauthenticated GET bodies are byte-identical for every caller. An empty list means no public pool, not all hosts.",
};

export const PACK_ROWS: PackRow[] = [
  {
    control: "Isolation",
    proves: "Workspace tenancy, SSRF, cache keys, org binding. Each line pins a test.",
    path: "docs/isolation.md",
  },
  {
    control: "Audit export",
    proves: "Approvals, versions, executions, refusals. Hash chain. Verify fails closed.",
    path: "packages/cli/src/audit.ts",
  },
  {
    control: "Access-review",
    proves: "Who approved what, when, which version. Tenant-bound. Tamper fails verify.",
    path: "apps/control/src/access-review.ts",
  },
  {
    control: "Human Approve",
    proves: "Nothing goes live without it. Canary and drift never auto-On.",
    path: "apps/control/src/handoff-approve.test.ts",
  },
  {
    control: "Kill switches",
    proves: "Operator can refuse a behavior. Inventory is grep-verifiable EDEN_*.",
    path: "docs/ROADMAP.md",
  },
  {
    control: "Doctor allowlist",
    proves: "EDEN_NET_ALLOW named, including empty. Empty is refuse, not all hosts.",
    path: "packages/cli/src/doctor.ts",
  },
  {
    control: "ZDR guidance",
    proves: "PTC, island, prompt-cache: what Eden records vs what the provider retains.",
    path: "docs/zdr.md",
  },
  {
    control: "Marketplace draft",
    proves: "Unpublished. Numbers from PUBLIC_CLAIMS only. Customer n = 0.",
    path: "docs/marketplace-draft.md",
  },
];
