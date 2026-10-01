/**
 * Horizon campaign worlds: graphql-relay / sso / search-rank / k8s-rollout /
 * saga-hold / blob-pipeline / sql-report / webhook-fanout / inbox-triage /
 * unique-work noise.
 *
 * Deliberately NOT a retune of desk, orders, etl, incident, research, thrash,
 * CRM, calendar, payments, cart, github-pr, terraform, flags, dns, inventory,
 * tenant, or map-reduce. These exist so compiling is scored on shapes holdout
 * and moonshot never trained: a Relay connection loop, nested-object SSO
 * provision, prefix top-k, same-args poll, two-arm saga, blob hash-then-put,
 * SQL string templates, three-write fanout, and an island in the middle.
 *
 * Same World contract as worlds.ts: tools, island, script, done, terminal,
 * check, optional fidelity.
 */
import type { IslandCaller } from "@eden/ir";
import { hashStr, type CallResult, type World } from "./worlds";

const THINK_NOTE = "agent think time is charged by the driver, not the world";
void THINK_NOTE;

/** Per-process ordinal so identical-entity stretches do not hash-collapse. */
let horizonOrd = 0;
function nextOrd(): number {
  return ++horizonOrd;
}

function occurrences(goals: Array<Record<string, unknown>>, key: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const g of goals) {
    const k = String(g[key]);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

function occurrencesBy(
  goals: Array<Record<string, unknown>>,
  keyOf: (g: Record<string, unknown>) => string,
): Map<string, number> {
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
/* graphql-relay — listIssues → { edges: [{ node: { id, title, number } }] } */
/* width 3. updateIssue({ id, title }) per edge from node.*, NOT a     */
/* top-level id on the edge. Then publishDigest. Goal { repo }.        */
/* ------------------------------------------------------------------ */

export const REPO_IDS = ["acme/relay", "globex/api", "initech/web", "umbrella/core"] as const;
export const GQL_WIDTH = 3;

export type RelayNode = { id: string; title: string; number: number };
export type RelayEdge = { node: RelayNode };

export function issuesFor(repo: string): RelayEdge[] {
  return Array.from({ length: GQL_WIDTH }, (_, i) => ({
    node: {
      id: `${repo}#${i + 1}`,
      title: `${repo} issue ${i + 1}`,
      number: i + 1,
    },
  }));
}

type GqlState = {
  updates: Map<string, number>;
  publishes: Map<string, number>;
};

export function createGraphqlRelay(): World {
  const st: GqlState = { updates: new Map(), publishes: new Map() };
  return {
    name: "graphql-relay",
    island: () => stubIsland(),
    tools: () => ({
      listIssues: {
        description: "List issues as a Relay connection { edges: [{ node: { id, title, number } }] }.",
        execute: async ({ repo }) => {
          await Bun.sleep(12);
          return { edges: issuesFor(String(repo)), repo, seq: nextOrd() };
        },
      },
      updateIssue: {
        description: "Update one issue by node id+title. Mutating. Args come from node.*, not the edge.",
        execute: async ({ id, title }, ctx) => {
          await Bun.sleep(10);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          const k = String(id);
          st.updates.set(k, (st.updates.get(k) ?? 0) + 1);
          return { updated: true, id, title };
        },
      },
      publishDigest: {
        description: "Publish the issue digest. Mutating.",
        execute: async ({ repo }, ctx) => {
          await Bun.sleep(16);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          const id = String(repo);
          st.publishes.set(id, (st.publishes.get(id) ?? 0) + 1);
          return { published: true, repo };
        },
      },
    }),
    async *script(goal) {
      const repo = String(goal.repo);
      const listed = yield { tool: "listIssues", args: { repo } };
      const edges = ((listed.value as { edges?: RelayEdge[] })?.edges ?? []) as RelayEdge[];
      for (const edge of edges) {
        // Bind from node.* — the edge itself has no top-level id.
        yield { tool: "updateIssue", args: { id: edge.node.id, title: edge.node.title } };
      }
      const done = yield { tool: "publishDigest", args: { repo } };
      void done;
    },
    done: (v) => Boolean((v as { published?: boolean })?.published),
    terminal: "publishDigest",
    check(doneGoals) {
      const bad: string[] = [];
      const occ = occurrences(doneGoals, "repo");
      for (const [id, n] of occ) {
        const pub = st.publishes.get(id) ?? 0;
        if (pub > n) bad.push(`graphql-relay:${id}: publishDigest ran ${pub}x across ${n} stretch(es) — duplicated`);
        for (const e of issuesFor(id)) {
          const u = st.updates.get(e.node.id) ?? 0;
          if (u > n)
            bad.push(`graphql-relay:${id}: updateIssue ${e.node.id} ran ${u}x across ${n} stretch(es) — duplicated`);
        }
      }
      return bad;
    },
  };
}

/* ------------------------------------------------------------------ */
/* sso-provision — getOrg → createUser({ body: nested OBJECT }) →      */
/* grantRole → sendInvite. Goal { orgId, email } two keys. seqLen 4.   */
/* ------------------------------------------------------------------ */

export const SSO_ORGS = [
  { orgId: "org-relay", email: "ada@horizon.example" },
  { orgId: "org-globex", email: "ben@horizon.example" },
  { orgId: "org-initech", email: "cam@horizon.example" },
  { orgId: "org-umbrella", email: "drew@horizon.example" },
] as const;

export function ssoNameFor(email: string): string {
  return `User ${email}`;
}

export function ssoBodyFor(orgId: string, email: string): { user: { email: string; name: string }; orgId: string } {
  return { user: { email, name: ssoNameFor(email) }, orgId };
}

function ssoKey(orgId: unknown, email: unknown): string {
  return `${String(orgId)}|${String(email)}`;
}

type SsoState = {
  users: Map<string, number>;
  roles: Map<string, number>;
  invites: Map<string, number>;
};

export function createSsoProvision(): World {
  const st: SsoState = { users: new Map(), roles: new Map(), invites: new Map() };
  return {
    name: "sso",
    island: () => stubIsland(),
    tools: () => ({
      getOrg: {
        description: "Fetch an org by id. Returns { orgId, plan }.",
        execute: async ({ orgId }) => {
          await Bun.sleep(10);
          const id = String(orgId);
          return { orgId: id, plan: id.endsWith("relay") ? "scale" : "pro", seq: nextOrd() };
        },
      },
      createUser: {
        description: "Provision a user. body is a nested OBJECT { user: { email, name }, orgId }, not a string.",
        execute: async ({ body }, ctx) => {
          await Bun.sleep(16);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          const rec = (body ?? {}) as { user?: { email?: string }; orgId?: string };
          const k = ssoKey(rec.orgId, rec.user?.email);
          st.users.set(k, (st.users.get(k) ?? 0) + 1);
          return { created: true, orgId: rec.orgId, email: rec.user?.email };
        },
      },
      grantRole: {
        description: "Grant a role to the email. Mutating.",
        execute: async ({ email, role }, ctx) => {
          await Bun.sleep(12);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          const k = String(email);
          st.roles.set(k, (st.roles.get(k) ?? 0) + 1);
          return { granted: true, email, role };
        },
      },
      sendInvite: {
        description: "Send the invite email. Mutating.",
        execute: async ({ email }, ctx) => {
          await Bun.sleep(14);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          const k = String(email);
          st.invites.set(k, (st.invites.get(k) ?? 0) + 1);
          return { invited: true, email };
        },
      },
    }),
    async *script(goal) {
      const orgId = String(goal.orgId);
      const email = String(goal.email);
      // email rides on the first call so steering recovers the two-key envelope.
      yield { tool: "getOrg", args: { orgId, email } };
      const body = ssoBodyFor(orgId, email);
      yield { tool: "createUser", args: { body } };
      yield { tool: "grantRole", args: { email, role: "member" } };
      const inv = yield { tool: "sendInvite", args: { email } };
      void inv;
    },
    done: (v) => Boolean((v as { invited?: boolean })?.invited),
    terminal: "sendInvite",
    check(doneGoals) {
      const bad: string[] = [];
      const occ = occurrencesBy(doneGoals, (g) => ssoKey(g.orgId, g.email));
      for (const [k, n] of occ) {
        const u = st.users.get(k) ?? 0;
        if (u > n) bad.push(`sso:${k}: createUser ran ${u}x across ${n} stretch(es) — duplicated`);
      }
      return bad;
    },
  };
}

/* ------------------------------------------------------------------ */
/* search-rank — searchHits returns 10 hits [{ id, score, rank }]     */
/* rank 1..10 score descending. takeHit on the FIRST 3 only (stable    */
/* prefix). Then writeDigest. Goal { q }.                              */
/* createSearchRandomSubset takes 3 NON-prefix ids (hard-case refuse). */
/* ------------------------------------------------------------------ */

export const QUERY_IDS = ["q-auth", "q-queue", "q-cache", "q-index"] as const;
export const SEARCH_HITS = 10;
export const SEARCH_TAKE = 3;

export type SearchHit = { id: string; score: number; rank: number };

export function hitsFor(q: string): SearchHit[] {
  return Array.from({ length: SEARCH_HITS }, (_, i) => ({
    id: `${q}-h${i}`,
    score: 100 - i * 7,
    rank: i + 1,
  }));
}

/** Stable prefix: ranks 1..3. */
export function prefixHitsFor(q: string): SearchHit[] {
  return hitsFor(q).slice(0, SEARCH_TAKE);
}

/** Non-prefix ids (ranks 4, 6, 8) — hard-case that must still refuse. */
export function nonPrefixHitsFor(q: string): SearchHit[] {
  const all = hitsFor(q);
  return [all[3]!, all[5]!, all[7]!];
}

type SearchState = {
  takes: Map<string, number>;
  digests: Map<string, number>;
};

function createSearchWorld(name: string, pick: (q: string) => SearchHit[]): World {
  const st: SearchState = { takes: new Map(), digests: new Map() };
  return {
    name,
    island: () => stubIsland(),
    tools: () => ({
      searchHits: {
        description: "Search ranked hits. Always returns 10 { id, score, rank } score-descending.",
        execute: async ({ q }) => {
          await Bun.sleep(12);
          return { hits: hitsFor(String(q)), q, seq: nextOrd() };
        },
      },
      takeHit: {
        description: "Take one hit by id. Mutating selection.",
        execute: async ({ id }, ctx) => {
          await Bun.sleep(8);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          const k = String(id);
          st.takes.set(k, (st.takes.get(k) ?? 0) + 1);
          return { taken: true, id };
        },
      },
      writeDigest: {
        description: "Write the search digest. Mutating.",
        execute: async ({ q }, ctx) => {
          await Bun.sleep(14);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          const id = String(q);
          st.digests.set(id, (st.digests.get(id) ?? 0) + 1);
          return { written: true, q };
        },
      },
    }),
    async *script(goal) {
      const q = String(goal.q);
      const listed = yield { tool: "searchHits", args: { q } };
      const hits = ((listed.value as { hits?: SearchHit[] })?.hits ?? []) as SearchHit[];
      const want = new Set(pick(q).map((h) => h.id));
      for (const h of hits) {
        if (want.has(h.id)) yield { tool: "takeHit", args: { id: h.id } };
      }
      const d = yield { tool: "writeDigest", args: { q } };
      void d;
    },
    done: (v) => Boolean((v as { written?: boolean })?.written),
    terminal: "writeDigest",
    check(doneGoals) {
      const bad: string[] = [];
      const occ = occurrences(doneGoals, "q");
      for (const [id, n] of occ) {
        const d = st.digests.get(id) ?? 0;
        if (d > n) bad.push(`${name}:${id}: writeDigest ran ${d}x across ${n} stretch(es) — duplicated`);
        for (const h of pick(id)) {
          const t = st.takes.get(h.id) ?? 0;
          if (t > n) bad.push(`${name}:${id}: takeHit ${h.id} ran ${t}x across ${n} stretch(es) — duplicated`);
        }
      }
      return bad;
    },
  };
}

export function createSearchRank(): World {
  return createSearchWorld("search-rank", prefixHitsFor);
}

/** Hard-case: take 3 NON-prefix ids. Compile must refuse. */
export function createSearchRandomSubset(): World {
  return createSearchWorld("search-random-subset", nonPrefixHitsFor);
}

/* ------------------------------------------------------------------ */
/* k8s-rollout — getRollout returns { ready: false } twice then        */
/* { ready: true } (same args every poll). Then verifyRollout.         */
/* Poll is 3 getRollout + 1 verify. Goal { deploy }.                   */
/* ------------------------------------------------------------------ */

export const DEPLOY_IDS = ["deploy-api", "deploy-worker", "deploy-web", "deploy-jobs"] as const;
export const K8S_POLLS = 3;

type K8sState = {
  verifies: Map<string, number>;
};

export function createK8sRollout(): World {
  let polls = 0;
  const st: K8sState = { verifies: new Map() };
  return {
    name: "k8s-rollout",
    island: () => stubIsland(),
    beginStretch() {
      polls = 0;
    },
    tools: () => ({
      getRollout: {
        description: "Poll rollout readiness. Same args every poll; ready flips on the third call.",
        execute: async ({ deploy }) => {
          await Bun.sleep(10);
          polls++;
          return { ready: polls >= K8S_POLLS, deploy, seq: nextOrd() };
        },
      },
      verifyRollout: {
        description: "Verify the rollout. Check verb.",
        execute: async ({ deploy }) => {
          await Bun.sleep(12);
          const id = String(deploy);
          st.verifies.set(id, (st.verifies.get(id) ?? 0) + 1);
          return { probed: true, deploy };
        },
      },
    }),
    async *script(goal) {
      const deploy = String(goal.deploy);
      for (;;) {
        const r = yield { tool: "getRollout", args: { deploy } };
        if ((r.value as { ready?: boolean })?.ready) break;
      }
      const v = yield { tool: "verifyRollout", args: { deploy } };
      void v;
    },
    done: (v) => Boolean((v as { probed?: boolean })?.probed),
    terminal: "verifyRollout",
    check(doneGoals) {
      return dupCheck("k8s-rollout", doneGoals, "deploy", [
        { name: "verifyRollout", get: (id) => st.verifies.get(id) ?? 0 },
      ]);
    },
  };
}

/* ------------------------------------------------------------------ */
/* saga-hold — getHold → { state: "ok" } or { state: "fail" }          */
/* (split pool 50/50). ok → captureFunds; fail → cancelHold. Then     */
/* notifyLedger both arms. Goal { holdId }. ≥3 witnesses per arm.      */
/* ------------------------------------------------------------------ */

export const HOLD_OK = ["H-ok-1", "H-ok-2", "H-ok-3"] as const;
export const HOLD_FAIL = ["H-fail-1", "H-fail-2", "H-fail-3"] as const;
export const HOLD_IDS = [...HOLD_OK, ...HOLD_FAIL] as const;

export function holdStateOf(holdId: string): "ok" | "fail" {
  return (HOLD_OK as readonly string[]).includes(holdId) ? "ok" : "fail";
}

type SagaState = {
  captures: Map<string, number>;
  cancels: Map<string, number>;
  notifies: Map<string, number>;
};

export function createSagaHold(): World {
  const st: SagaState = { captures: new Map(), cancels: new Map(), notifies: new Map() };
  return {
    name: "saga-hold",
    island: () => stubIsland(),
    tools: () => ({
      getHold: {
        description: "Fetch a payment hold. state is ok or fail.",
        execute: async ({ holdId }) => {
          await Bun.sleep(10);
          const id = String(holdId);
          return { holdId: id, state: holdStateOf(id), seq: nextOrd() };
        },
      },
      captureFunds: {
        description: "Capture funds on an ok hold. Mutating.",
        execute: async ({ holdId }, ctx) => {
          await Bun.sleep(14);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          const id = String(holdId);
          st.captures.set(id, (st.captures.get(id) ?? 0) + 1);
          return { captured: true, holdId };
        },
      },
      cancelHold: {
        description: "Cancel a failed hold. Mutating.",
        execute: async ({ holdId }, ctx) => {
          await Bun.sleep(12);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          const id = String(holdId);
          st.cancels.set(id, (st.cancels.get(id) ?? 0) + 1);
          return { cancelled: true, holdId };
        },
      },
      notifyLedger: {
        description: "Notify the ledger. Mutating. Both arms.",
        execute: async ({ holdId }, ctx) => {
          await Bun.sleep(16);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          const id = String(holdId);
          st.notifies.set(id, (st.notifies.get(id) ?? 0) + 1);
          return { notified: true, holdId };
        },
      },
    }),
    async *script(goal) {
      const holdId = String(goal.holdId);
      const got = yield { tool: "getHold", args: { holdId } };
      const state = (got.value as { state?: string })?.state;
      if (state === "ok") yield { tool: "captureFunds", args: { holdId } };
      else yield { tool: "cancelHold", args: { holdId } };
      const n = yield { tool: "notifyLedger", args: { holdId } };
      void n;
    },
    done: (v) => Boolean((v as { notified?: boolean })?.notified),
    terminal: "notifyLedger",
    check(doneGoals) {
      const bad: string[] = [];
      const occ = occurrences(doneGoals, "holdId");
      for (const [id, n] of occ) {
        const cap = st.captures.get(id) ?? 0;
        if (cap > n) bad.push(`saga-hold:${id}: captureFunds ran ${cap}x across ${n} stretch(es) — duplicated`);
        const can = st.cancels.get(id) ?? 0;
        if (can > n) bad.push(`saga-hold:${id}: cancelHold ran ${can}x across ${n} stretch(es) — duplicated`);
      }
      return bad;
    },
  };
}

/* ------------------------------------------------------------------ */
/* blob-pipeline — fetchBlob → hashObject → putObject → notifyStore.  */
/* Sequential seqLen 4. Goal { blob }. Terminal notifyStore.           */
/* ------------------------------------------------------------------ */

export const BLOB_IDS = ["blob-a1", "blob-b2", "blob-c3", "blob-d4"] as const;

export function blobSha(blob: string): string {
  return hashStr(blob).toString(16).padStart(8, "0");
}

type BlobState = {
  puts: Map<string, number>;
  stores: Map<string, number>;
};

export function createBlobPipeline(): World {
  const st: BlobState = { puts: new Map(), stores: new Map() };
  return {
    name: "blob-pipeline",
    island: () => stubIsland(),
    tools: () => ({
      fetchBlob: {
        description: "Fetch a blob. Returns { blob, sha, bytes }.",
        execute: async ({ blob }) => {
          await Bun.sleep(12);
          const id = String(blob);
          const sha = blobSha(id);
          return { blob: id, sha, bytes: 64 + (hashStr(id) % 900), seq: nextOrd() };
        },
      },
      hashObject: {
        description: "Hash a blob object. Returns { sha }.",
        execute: async ({ blob }) => {
          await Bun.sleep(8);
          return { sha: blobSha(String(blob)) };
        },
      },
      putObject: {
        description: "Put the hashed object. Mutating.",
        execute: async ({ blob, sha }, ctx) => {
          await Bun.sleep(14);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          const id = String(blob);
          st.puts.set(id, (st.puts.get(id) ?? 0) + 1);
          return { put: true, blob, sha };
        },
      },
      notifyStore: {
        description: "Notify the object store. Mutating.",
        execute: async ({ blob }, ctx) => {
          await Bun.sleep(12);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          const id = String(blob);
          st.stores.set(id, (st.stores.get(id) ?? 0) + 1);
          return { stored: true, blob };
        },
      },
    }),
    async *script(goal) {
      const blob = String(goal.blob);
      yield { tool: "fetchBlob", args: { blob } };
      const hashed = yield { tool: "hashObject", args: { blob } };
      const sha = (hashed.value as { sha?: string })?.sha ?? blobSha(blob);
      yield { tool: "putObject", args: { blob, sha } };
      const n = yield { tool: "notifyStore", args: { blob } };
      void n;
    },
    done: (v) => Boolean((v as { stored?: boolean })?.stored),
    terminal: "notifyStore",
    check(doneGoals) {
      return dupCheck("blob-pipeline", doneGoals, "blob", [
        { name: "putObject", get: (id) => st.puts.get(id) ?? 0 },
        { name: "notifyStore", get: (id) => st.stores.get(id) ?? 0 },
      ]);
    },
  };
}

/* ------------------------------------------------------------------ */
/* sql-report — runQuery({ sql }) where sql is a string template       */
/* containing the report id. Then fetchRows → writeCsv → mailReport.  */
/* Goal { report }. seqLen 4. SQL must vary with report (not a literal). */
/* ------------------------------------------------------------------ */

export const REPORT_IDS = ["R-1", "R-2", "R-3", "R-4"] as const;

export function sqlFor(report: string): string {
  return `SELECT * FROM events WHERE report = '${report}'`;
}

type SqlState = {
  csvs: Map<string, number>;
  mails: Map<string, number>;
};

export function createSqlReport(): World {
  const st: SqlState = { csvs: new Map(), mails: new Map() };
  return {
    name: "sql-report",
    island: () => stubIsland(),
    tools: () => ({
      runQuery: {
        description: "Run a SQL string. The query text contains the report id; it is not a literal.",
        execute: async ({ sql }) => {
          await Bun.sleep(14);
          return { sql, n: 8, ok: true };
        },
      },
      fetchRows: {
        description: "Fetch query rows for the report.",
        execute: async ({ report }) => {
          await Bun.sleep(12);
          return { report, rows: 8, seq: nextOrd() };
        },
      },
      writeCsv: {
        description: "Write the report CSV. Mutating.",
        execute: async ({ report }, ctx) => {
          await Bun.sleep(16);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          const id = String(report);
          st.csvs.set(id, (st.csvs.get(id) ?? 0) + 1);
          return { wrote: true, report };
        },
      },
      mailReport: {
        description: "Mail the CSV report. Mutating.",
        execute: async ({ report }, ctx) => {
          await Bun.sleep(18);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          const id = String(report);
          st.mails.set(id, (st.mails.get(id) ?? 0) + 1);
          return { mailed: true, report };
        },
      },
    }),
    async *script(goal) {
      const report = String(goal.report);
      const sql = sqlFor(report);
      // report rides along so steering recovers { report } even though the
      // first tool's interesting arg is the SQL string.
      yield { tool: "runQuery", args: { sql, report } };
      yield { tool: "fetchRows", args: { report } };
      yield { tool: "writeCsv", args: { report } };
      const m = yield { tool: "mailReport", args: { report } };
      void m;
    },
    done: (v) => Boolean((v as { mailed?: boolean })?.mailed),
    terminal: "mailReport",
    check(doneGoals) {
      return dupCheck("sql-report", doneGoals, "report", [
        { name: "writeCsv", get: (id) => st.csvs.get(id) ?? 0 },
        { name: "mailReport", get: (id) => st.mails.get(id) ?? 0 },
      ]);
    },
  };
}

/* ------------------------------------------------------------------ */
/* webhook-fanout — receiveEvent → THREE different writes:             */
/* notifySlack, writeAudit, ackEvent. Not a foreach. Goal { hook }.    */
/* Terminal ackEvent. check() each write exactly once.                 */
/* ------------------------------------------------------------------ */

export const HOOK_IDS = ["hook-alpha", "hook-bravo", "hook-charlie", "hook-delta"] as const;

type HookState = {
  slacks: Map<string, number>;
  audits: Map<string, number>;
  acks: Map<string, number>;
};

export function createWebhookFanout(): World {
  const st: HookState = { slacks: new Map(), audits: new Map(), acks: new Map() };
  return {
    name: "webhook-fanout",
    island: () => stubIsland(),
    tools: () => ({
      receiveEvent: {
        description: "Receive a webhook event. Returns { hook, type }.",
        execute: async ({ hook }) => {
          await Bun.sleep(10);
          const id = String(hook);
          return { hook: id, type: id.includes("alpha") ? "push" : "issue", seq: nextOrd() };
        },
      },
      notifySlack: {
        description: "Notify Slack of the event. Mutating. One of three distinct writes.",
        execute: async ({ hook }, ctx) => {
          await Bun.sleep(12);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          const id = String(hook);
          st.slacks.set(id, (st.slacks.get(id) ?? 0) + 1);
          return { slacked: true, hook };
        },
      },
      writeAudit: {
        description: "Write an audit line. Mutating. One of three distinct writes.",
        execute: async ({ hook }, ctx) => {
          await Bun.sleep(10);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          const id = String(hook);
          st.audits.set(id, (st.audits.get(id) ?? 0) + 1);
          return { audited: true, hook };
        },
      },
      ackEvent: {
        description: "Ack the webhook. Mutating. Terminal write.",
        execute: async ({ hook }, ctx) => {
          await Bun.sleep(14);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          const id = String(hook);
          st.acks.set(id, (st.acks.get(id) ?? 0) + 1);
          return { acked: true, hook };
        },
      },
    }),
    async *script(goal) {
      const hook = String(goal.hook);
      yield { tool: "receiveEvent", args: { hook } };
      yield { tool: "notifySlack", args: { hook } };
      yield { tool: "writeAudit", args: { hook } };
      const a = yield { tool: "ackEvent", args: { hook } };
      void a;
    },
    done: (v) => Boolean((v as { acked?: boolean })?.acked),
    terminal: "ackEvent",
    check(doneGoals) {
      const bad: string[] = [];
      const occ = occurrences(doneGoals, "hook");
      for (const [id, n] of occ) {
        for (const [name, map] of [
          ["notifySlack", st.slacks],
          ["writeAudit", st.audits],
          ["ackEvent", st.acks],
        ] as const) {
          const got = map.get(id) ?? 0;
          if (got !== n)
            bad.push(
              `webhook-fanout:${id}: ${name} ran ${got}x across ${n} stretch(es) — want exactly once per stretch`,
            );
        }
      }
      return bad;
    },
  };
}

/* ------------------------------------------------------------------ */
/* inbox-triage — fetchThread → draftReply (island) → archiveThread → */
/* ackInbox. Goal { thread }. Island in the middle. Terminal ackInbox. */
/* ------------------------------------------------------------------ */

export const THREAD_IDS = ["THR-11", "THR-12", "THR-13", "THR-14"] as const;

type InboxState = {
  archives: Map<string, number>;
  acks: Map<string, number>;
};

export function createInboxTriage(): World {
  const st: InboxState = { archives: new Map(), acks: new Map() };
  return {
    name: "inbox-triage",
    island:
      () =>
      async ({ input, signal }) => {
        await Bun.sleep(12);
        if (signal?.aborted) throw new Error("aborted");
        const thread = String((input ?? ({} as Record<string, unknown>)).thread ?? "");
        return { text: `re: ${thread}`, drafted: true };
      },
    tools: () => ({
      fetchThread: {
        description: "Fetch an inbox thread. Returns { thread, from }.",
        execute: async ({ thread }) => {
          await Bun.sleep(10);
          const id = String(thread);
          return { thread: id, from: `${id.toLowerCase()}@inbox.example`, seq: nextOrd() };
        },
      },
      draftReply: {
        description: "Draft a reply. Model judgment — compiles as an island.",
        execute: async ({ thread }) => {
          await Bun.sleep(18);
          return { text: `re: ${String(thread)}`, drafted: true };
        },
      },
      archiveThread: {
        description: "Archive the thread. Mutating.",
        execute: async ({ thread }, ctx) => {
          await Bun.sleep(12);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          const id = String(thread);
          st.archives.set(id, (st.archives.get(id) ?? 0) + 1);
          return { archived: true, thread };
        },
      },
      ackInbox: {
        description: "Ack the inbox item. Mutating.",
        execute: async ({ thread }, ctx) => {
          await Bun.sleep(14);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          const id = String(thread);
          st.acks.set(id, (st.acks.get(id) ?? 0) + 1);
          return { acked: true, thread };
        },
      },
    }),
    async *script(goal) {
      const thread = String(goal.thread);
      yield { tool: "fetchThread", args: { thread } };
      yield { tool: "draftReply", args: { thread } };
      yield { tool: "archiveThread", args: { thread } };
      const a = yield { tool: "ackInbox", args: { thread } };
      void a;
    },
    done: (v) => Boolean((v as { acked?: boolean })?.acked),
    terminal: "ackInbox",
    check(doneGoals) {
      return dupCheck("inbox-triage", doneGoals, "thread", [
        { name: "archiveThread", get: (id) => st.archives.get(id) ?? 0 },
        { name: "ackInbox", get: (id) => st.acks.get(id) ?? 0 },
      ]);
    },
  };
}

/* ------------------------------------------------------------------ */
/* horizon-noise — shuffled unique sequences from graphql/sso/sql/blob */
/* flavoured names. Nothing repeats. check() empty. compile 0 programs. */
/* ------------------------------------------------------------------ */

const HORIZON_NOISE_TOOLS = [
  "fetchBlob",
  "showDiff",
  "listHosts",
  "runQuery",
  "grantRole",
  "peekIssue",
  "scanCols",
  "touchDigest",
] as const;

export const NOISE_IDS = ["HZ-0", "HZ-1", "HZ-2", "HZ-3", "HZ-4", "HZ-5"] as const;

export function createHorizonNoise(): World {
  const toolDefs = (): Record<
    string,
    { description: string; execute: (a: Record<string, unknown>) => Promise<unknown> }
  > => {
    const out: Record<string, { description: string; execute: (a: Record<string, unknown>) => Promise<unknown> }> = {};
    for (const name of HORIZON_NOISE_TOOLS) {
      out[name] = {
        description: `horizon-noise tool ${name}`,
        execute: async ({ id }) => {
          await Bun.sleep(8);
          return { name, id, seq: nextOrd() };
        },
      };
    }
    return out;
  };
  return {
    name: "horizon-noise",
    island: () => stubIsland(),
    tools: () => toolDefs(),
    async *script(goal) {
      const id = String(goal.id);
      const rng = mulberry32(hashStr(id));
      const picks = [...HORIZON_NOISE_TOOLS];
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
    terminal: "touchDigest",
    check() {
      return [];
    },
  };
}

/** The 9 repeating worlds. Noise is not in this list. */
export const HORIZON_WORLD_FACTORIES = [
  createGraphqlRelay,
  createSsoProvision,
  createSearchRank,
  createK8sRollout,
  createSagaHold,
  createBlobPipeline,
  createSqlReport,
  createWebhookFanout,
  createInboxTriage,
] as const;
