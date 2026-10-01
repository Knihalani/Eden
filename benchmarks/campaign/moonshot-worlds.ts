/**
 * Moonshot campaign worlds: github-pr / terraform / flags / dns-tls /
 * inventory / tenant / map-reduce / unique-work noise.
 *
 * Deliberately NOT a retune of desk, orders, etl, incident, research, thrash,
 * CRM, calendar, payments, or cart. These exist so compiling is scored on
 * shapes holdout never trained: a GitHub review object-loop, plan-then-apply,
 * two-field flag rollouts, cert-then-listener, three-field warehouse restock,
 * two-key tenant provision, map-then-merge, and a hostile empty mix.
 *
 * Same World contract as worlds.ts: tools, island, script, done, terminal,
 * check, optional fidelity.
 */
import type { IslandCaller } from "@eden/ir";
import { hashStr, type CallResult, type World } from "./worlds";

const THINK_NOTE = "agent think time is charged by the driver, not the world";
void THINK_NOTE;

/** Per-process ordinal so identical-entity stretches do not hash-collapse. */
let moonshotOrd = 0;
function nextOrd(): number {
  return ++moonshotOrd;
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
/* github-pr — listFiles → { files: [{ path, sha }, ...] } width 3,    */
/* createReviewComment per file, publishReview, assignReviewers.      */
/* Goal { pr }. Linear + object loop. Not a cart clone: path+sha.     */
/* ------------------------------------------------------------------ */

export const PR_IDS = ["PR-9101", "PR-9102", "PR-9103", "PR-9104"] as const;
export const GH_WIDTH = 3;

export function filesFor(pr: string): Array<{ path: string; sha: string }> {
  return Array.from({ length: GH_WIDTH }, (_, i) => {
    const path = `${pr}/src/mod-${i}.ts`;
    return { path, sha: hashStr(path).toString(16).padStart(8, "0") };
  });
}

type GhState = {
  comments: Map<string, number>;
  publishes: Map<string, number>;
  assigns: Map<string, number>;
};

export function createGithubPr(): World {
  const st: GhState = { comments: new Map(), publishes: new Map(), assigns: new Map() };
  return {
    name: "github-pr",
    island: () => stubIsland(),
    tools: () => ({
      listFiles: {
        description: "List changed files as objects { path, sha }, not strings.",
        execute: async ({ pr }) => {
          await Bun.sleep(12);
          return { files: filesFor(String(pr)), pr, seq: nextOrd() };
        },
      },
      createReviewComment: {
        description: "Comment on one file at its blob sha. Mutating.",
        execute: async ({ path, sha }, ctx) => {
          await Bun.sleep(10);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          const k = String(path);
          st.comments.set(k, (st.comments.get(k) ?? 0) + 1);
          return { commented: true, path, sha };
        },
      },
      publishReview: {
        description: "Publish the review. Mutating.",
        execute: async ({ pr }, ctx) => {
          await Bun.sleep(16);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          const id = String(pr);
          st.publishes.set(id, (st.publishes.get(id) ?? 0) + 1);
          return { published: true, pr };
        },
      },
      assignReviewers: {
        description: "Assign reviewers on the PR. Mutating.",
        execute: async ({ pr }, ctx) => {
          await Bun.sleep(14);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          const id = String(pr);
          st.assigns.set(id, (st.assigns.get(id) ?? 0) + 1);
          return { assigned: true, pr };
        },
      },
    }),
    async *script(goal) {
      const pr = String(goal.pr);
      const listed = yield { tool: "listFiles", args: { pr } };
      const files = ((listed.value as { files?: Array<{ path?: string; sha?: string }> })?.files ?? []) as Array<{
        path?: string;
        sha?: string;
      }>;
      for (const f of files) {
        yield { tool: "createReviewComment", args: { path: f.path, sha: f.sha, pr } };
      }
      yield { tool: "publishReview", args: { pr } };
      const done = yield { tool: "assignReviewers", args: { pr } };
      void done;
    },
    done: (v) => Boolean((v as { assigned?: boolean })?.assigned),
    terminal: "assignReviewers",
    check(doneGoals) {
      const bad: string[] = [];
      const occ = occurrences(doneGoals, "pr");
      for (const [id, n] of occ) {
        const pub = st.publishes.get(id) ?? 0;
        if (pub > n) bad.push(`github-pr:${id}: publishReview ran ${pub}x across ${n} stretch(es) — duplicated`);
        const asg = st.assigns.get(id) ?? 0;
        if (asg > n) bad.push(`github-pr:${id}: assignReviewers ran ${asg}x across ${n} stretch(es) — duplicated`);
        for (const f of filesFor(id)) {
          const c = st.comments.get(f.path) ?? 0;
          if (c > n)
            bad.push(`github-pr:${id}: createReviewComment ${f.path} ran ${c}x across ${n} stretch(es) — duplicated`);
        }
      }
      return bad;
    },
  };
}

/* ------------------------------------------------------------------ */
/* terraform — showPlan → applyChange foreach addresses → verifyOutputs */
/* Plan-then-apply. Goal { stack }. Not desk/orders: apply after plan. */
/* ------------------------------------------------------------------ */

export const STACK_IDS = ["stk-alpha", "stk-bravo", "stk-charlie", "stk-delta"] as const;
export const TF_WIDTH = 3;

export function addressesFor(stack: string): string[] {
  return [`${stack}.aws_s3.bucket`, `${stack}.aws_iam.role`, `${stack}.aws_vpc.net`];
}

type TfState = {
  applies: Map<string, number>;
  verifies: Map<string, number>;
};

export function createTerraform(): World {
  const st: TfState = { applies: new Map(), verifies: new Map() };
  return {
    name: "terraform",
    island: () => stubIsland(),
    tools: () => ({
      showPlan: {
        description: "Show the terraform plan addresses for a stack.",
        execute: async ({ stack }) => {
          await Bun.sleep(14);
          return { addresses: addressesFor(String(stack)), stack, seq: nextOrd() };
        },
      },
      applyChange: {
        description: "Apply one planned address. Mutating.",
        execute: async ({ address }, ctx) => {
          await Bun.sleep(12);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          const k = String(address);
          st.applies.set(k, (st.applies.get(k) ?? 0) + 1);
          return { applied: true, address };
        },
      },
      verifyOutputs: {
        description: "Verify stack outputs after apply. Check verb.",
        execute: async ({ stack }) => {
          await Bun.sleep(10);
          const id = String(stack);
          st.verifies.set(id, (st.verifies.get(id) ?? 0) + 1);
          return { probed: true, stack };
        },
      },
    }),
    async *script(goal) {
      const stack = String(goal.stack);
      const plan = yield { tool: "showPlan", args: { stack } };
      const addresses = ((plan.value as { addresses?: string[] })?.addresses ?? []) as string[];
      for (const address of addresses) {
        yield { tool: "applyChange", args: { address, stack } };
      }
      const v = yield { tool: "verifyOutputs", args: { stack } };
      void v;
    },
    done: (v) => Boolean((v as { probed?: boolean })?.probed),
    terminal: "verifyOutputs",
    check(doneGoals) {
      const bad: string[] = [];
      const occ = occurrences(doneGoals, "stack");
      for (const [id, n] of occ) {
        for (const addr of addressesFor(id)) {
          const a = st.applies.get(addr) ?? 0;
          if (a > n) bad.push(`terraform:${id}: applyChange ${addr} ran ${a}x across ${n} stretch(es) — duplicated`);
        }
      }
      return bad;
    },
  };
}

/* ------------------------------------------------------------------ */
/* flags — getFlag → listCohorts { cohort, pct } → setRollout → publish */
/* Two fields on the item. Goal { flag }. Staged rollout, not CRM.    */
/* ------------------------------------------------------------------ */

export const FLAG_IDS = ["feat-search", "feat-billing", "feat-dark", "feat-audit"] as const;
export const FLAG_WIDTH = 3;

export function cohortsFor(flag: string): Array<{ cohort: string; pct: number }> {
  return [
    { cohort: `${flag}-beta`, pct: 5 },
    { cohort: `${flag}-internal`, pct: 25 },
    { cohort: `${flag}-ga`, pct: 100 },
  ].slice(0, FLAG_WIDTH);
}

type FlagState = {
  rollouts: Map<string, number>;
  publishes: Map<string, number>;
};

export function createFlags(): World {
  const st: FlagState = { rollouts: new Map(), publishes: new Map() };
  return {
    name: "flags",
    island: () => stubIsland(),
    tools: () => ({
      getFlag: {
        description: "Fetch a feature flag by name.",
        execute: async ({ flag }) => {
          await Bun.sleep(10);
          return { flag, enabled: true, seq: nextOrd() };
        },
      },
      listCohorts: {
        description: "List rollout cohorts as objects { cohort, pct }.",
        execute: async ({ flag }) => {
          await Bun.sleep(12);
          return { cohorts: cohortsFor(String(flag)), flag, seq: nextOrd() };
        },
      },
      setRollout: {
        description: "Set one cohort's rollout percent. Mutating.",
        execute: async ({ cohort, pct }, ctx) => {
          await Bun.sleep(10);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          const k = String(cohort);
          st.rollouts.set(k, (st.rollouts.get(k) ?? 0) + 1);
          return { set: true, cohort, pct };
        },
      },
      publishFlag: {
        description: "Publish the flag. Mutating.",
        execute: async ({ flag }, ctx) => {
          await Bun.sleep(16);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          const id = String(flag);
          st.publishes.set(id, (st.publishes.get(id) ?? 0) + 1);
          return { published: true, flag };
        },
      },
    }),
    async *script(goal) {
      const flag = String(goal.flag);
      yield { tool: "getFlag", args: { flag } };
      const listed = yield { tool: "listCohorts", args: { flag } };
      const cohorts = ((listed.value as { cohorts?: Array<{ cohort?: string; pct?: number }> })?.cohorts ??
        []) as Array<{
        cohort?: string;
        pct?: number;
      }>;
      for (const c of cohorts) {
        yield { tool: "setRollout", args: { cohort: c.cohort, pct: c.pct, flag } };
      }
      const pub = yield { tool: "publishFlag", args: { flag } };
      void pub;
    },
    done: (v) => Boolean((v as { published?: boolean })?.published),
    terminal: "publishFlag",
    check(doneGoals) {
      const bad: string[] = [];
      const occ = occurrences(doneGoals, "flag");
      for (const [id, n] of occ) {
        const p = st.publishes.get(id) ?? 0;
        if (p > n) bad.push(`flags:${id}: publishFlag ran ${p}x across ${n} stretch(es) — duplicated`);
        for (const c of cohortsFor(id)) {
          const r = st.rollouts.get(c.cohort) ?? 0;
          if (r > n) bad.push(`flags:${id}: setRollout ${c.cohort} ran ${r}x across ${n} stretch(es) — duplicated`);
        }
      }
      return bad;
    },
  };
}

/* ------------------------------------------------------------------ */
/* dns-tls — listHosts → createCert(host) loop → createListener →     */
/* checkHttps. Goal { zone }. Cert-then-bind, not a cart clone.       */
/* ------------------------------------------------------------------ */

export const ZONE_IDS = ["acme.dev", "globex.io", "initech.net", "umbrella.co"] as const;
export const DNS_WIDTH = 3;

export function hostsFor(zone: string): string[] {
  return [`api.${zone}`, `www.${zone}`, `cdn.${zone}`];
}

type DnsState = {
  certs: Map<string, number>;
  listeners: Map<string, number>;
};

export function createDnsTls(): World {
  const st: DnsState = { certs: new Map(), listeners: new Map() };
  return {
    name: "dns-tls",
    island: () => stubIsland(),
    tools: () => ({
      listHosts: {
        description: "List hosts in a DNS zone.",
        execute: async ({ zone }) => {
          await Bun.sleep(12);
          return { hosts: hostsFor(String(zone)), zone, seq: nextOrd() };
        },
      },
      createCert: {
        description: "Issue a TLS cert for one host. Mutating.",
        execute: async ({ host }, ctx) => {
          await Bun.sleep(14);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          const k = String(host);
          st.certs.set(k, (st.certs.get(k) ?? 0) + 1);
          return { certId: `crt-${hashStr(k).toString(16)}`, host, created: true };
        },
      },
      createListener: {
        description: "Bind a TLS listener for the zone. Mutating.",
        execute: async ({ zone }, ctx) => {
          await Bun.sleep(16);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          const id = String(zone);
          st.listeners.set(id, (st.listeners.get(id) ?? 0) + 1);
          return { listening: true, zone };
        },
      },
      checkHttps: {
        description: "Probe HTTPS on the zone. Check verb.",
        execute: async ({ zone }) => {
          await Bun.sleep(10);
          return { probed: true, zone };
        },
      },
    }),
    async *script(goal) {
      const zone = String(goal.zone);
      const listed = yield { tool: "listHosts", args: { zone } };
      const hosts = ((listed.value as { hosts?: string[] })?.hosts ?? []) as string[];
      for (const host of hosts) {
        yield { tool: "createCert", args: { host, zone } };
      }
      yield { tool: "createListener", args: { zone } };
      const probe = yield { tool: "checkHttps", args: { zone } };
      void probe;
    },
    done: (v) => Boolean((v as { probed?: boolean })?.probed),
    terminal: "checkHttps",
    check(doneGoals) {
      const bad: string[] = [];
      const occ = occurrences(doneGoals, "zone");
      for (const [id, n] of occ) {
        const lis = st.listeners.get(id) ?? 0;
        if (lis > n) bad.push(`dns-tls:${id}: createListener ran ${lis}x across ${n} stretch(es) — duplicated`);
        for (const host of hostsFor(id)) {
          const c = st.certs.get(host) ?? 0;
          if (c > n) bad.push(`dns-tls:${id}: createCert ${host} ran ${c}x across ${n} stretch(es) — duplicated`);
        }
      }
      return bad;
    },
  };
}

/* ------------------------------------------------------------------ */
/* inventory — listBins { sku, qty, warehouse } THREE fields →        */
/* restockLine(sku,qty,warehouse) → createShipment. Not a cart clone: */
/* warehouse is a third field, restock+ship, goal { wave }.           */
/* ------------------------------------------------------------------ */

export const WAVE_IDS = ["WV-11", "WV-12", "WV-13", "WV-14"] as const;
export const INV_WIDTH = 3;

export function binsFor(wave: string): Array<{ sku: string; qty: number; warehouse: string }> {
  return Array.from({ length: INV_WIDTH }, (_, i) => ({
    sku: `${wave}-SKU-${String.fromCharCode(65 + i)}`,
    qty: 2 + i,
    warehouse: `${wave}-WH-${i}`,
  }));
}

type InvState = {
  restocks: Map<string, number>;
  shipments: Map<string, number>;
};

export function createInventory(): World {
  const st: InvState = { restocks: new Map(), shipments: new Map() };
  return {
    name: "inventory",
    island: () => stubIsland(),
    tools: () => ({
      listBins: {
        description: "List warehouse bins as objects { sku, qty, warehouse }.",
        execute: async ({ wave }) => {
          await Bun.sleep(12);
          return { bins: binsFor(String(wave)), wave, seq: nextOrd() };
        },
      },
      restockLine: {
        description: "Restock one sku at one warehouse. Mutating.",
        execute: async ({ sku, qty, warehouse }, ctx) => {
          await Bun.sleep(10);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          const k = String(sku);
          st.restocks.set(k, (st.restocks.get(k) ?? 0) + 1);
          return { restocked: true, sku, qty, warehouse };
        },
      },
      createShipment: {
        description: "Create the restock shipment. Mutating.",
        execute: async ({ wave }, ctx) => {
          await Bun.sleep(18);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          const id = String(wave);
          st.shipments.set(id, (st.shipments.get(id) ?? 0) + 1);
          return { shipped: true, wave };
        },
      },
    }),
    async *script(goal) {
      const wave = String(goal.wave);
      const listed = yield { tool: "listBins", args: { wave } };
      const bins = ((listed.value as { bins?: Array<{ sku?: string; qty?: number; warehouse?: string }> })?.bins ??
        []) as Array<{
        sku?: string;
        qty?: number;
        warehouse?: string;
      }>;
      for (const b of bins) {
        yield { tool: "restockLine", args: { sku: b.sku, qty: b.qty, warehouse: b.warehouse } };
      }
      const ship = yield { tool: "createShipment", args: { wave } };
      void ship;
    },
    done: (v) => Boolean((v as { shipped?: boolean })?.shipped),
    terminal: "createShipment",
    check(doneGoals) {
      const bad: string[] = [];
      const occ = occurrences(doneGoals, "wave");
      for (const [id, n] of occ) {
        const sh = st.shipments.get(id) ?? 0;
        if (sh > n) bad.push(`inventory:${id}: createShipment ran ${sh}x across ${n} stretch(es) — duplicated`);
        for (const b of binsFor(id)) {
          const r = st.restocks.get(b.sku) ?? 0;
          if (r > n) bad.push(`inventory:${id}: restockLine ${b.sku} ran ${r}x across ${n} stretch(es) — duplicated`);
        }
      }
      return bad;
    },
  };
}

/* ------------------------------------------------------------------ */
/* tenant — TWO-KEY input { orgId, plan }.                            */
/* createTenant → createDb → createRoles → createBilling → sendWelcome. seqLen 5. */
/* ------------------------------------------------------------------ */

export const TENANT_ORGS = [
  { orgId: "org-acme", plan: "pro" },
  { orgId: "org-globex", plan: "scale" },
  { orgId: "org-initech", plan: "starter" },
  { orgId: "org-umbrella", plan: "pro" },
] as const;

function tenantKey(orgId: unknown, plan: unknown): string {
  return `${String(orgId)}|${String(plan)}`;
}

type TenantState = {
  tenants: Map<string, number>;
  dbs: Map<string, number>;
  roles: Map<string, number>;
  billings: Map<string, number>;
  welcomes: Map<string, number>;
};

export function createTenant(): World {
  const st: TenantState = {
    tenants: new Map(),
    dbs: new Map(),
    roles: new Map(),
    billings: new Map(),
    welcomes: new Map(),
  };
  return {
    name: "tenant",
    island: () => stubIsland(),
    tools: () => ({
      createTenant: {
        description: "Create a tenant for org+plan. Mutating.",
        execute: async ({ orgId, plan }, ctx) => {
          await Bun.sleep(16);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          const k = tenantKey(orgId, plan);
          st.tenants.set(k, (st.tenants.get(k) ?? 0) + 1);
          return { tenantId: `ten-${hashStr(k).toString(16)}`, orgId, plan, created: true };
        },
      },
      createDb: {
        description: "Provision the tenant database. Mutating.",
        execute: async ({ orgId, plan }, ctx) => {
          await Bun.sleep(20);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          const k = tenantKey(orgId, plan);
          st.dbs.set(k, (st.dbs.get(k) ?? 0) + 1);
          return { db: `db-${orgId}`, orgId, plan };
        },
      },
      createRoles: {
        description: "Create default roles. Mutating.",
        execute: async ({ orgId, plan }, ctx) => {
          await Bun.sleep(14);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          const k = tenantKey(orgId, plan);
          st.roles.set(k, (st.roles.get(k) ?? 0) + 1);
          return { roles: true, orgId, plan };
        },
      },
      createBilling: {
        description: "Attach a billing account for org+plan. Mutating.",
        execute: async ({ orgId, plan }, ctx) => {
          await Bun.sleep(15);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          const k = tenantKey(orgId, plan);
          st.billings.set(k, (st.billings.get(k) ?? 0) + 1);
          return { billingId: `bill-${orgId}`, orgId, plan };
        },
      },
      sendWelcome: {
        description: "Send the welcome email. Mutating.",
        execute: async ({ orgId, plan }, ctx) => {
          await Bun.sleep(18);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          const k = tenantKey(orgId, plan);
          st.welcomes.set(k, (st.welcomes.get(k) ?? 0) + 1);
          return { welcomeSent: true, orgId, plan };
        },
      },
    }),
    async *script(goal) {
      const orgId = String(goal.orgId);
      const plan = String(goal.plan);
      yield { tool: "createTenant", args: { orgId, plan } };
      yield { tool: "createDb", args: { orgId, plan } };
      yield { tool: "createRoles", args: { orgId, plan } };
      yield { tool: "createBilling", args: { orgId, plan } };
      const w = yield { tool: "sendWelcome", args: { orgId, plan } };
      void w;
    },
    done: (v) => Boolean((v as { welcomeSent?: boolean })?.welcomeSent),
    terminal: "sendWelcome",
    check(doneGoals) {
      const bad: string[] = [];
      const occ = occurrencesBy(doneGoals, (g) => tenantKey(g.orgId, g.plan));
      for (const [k, n] of occ) {
        for (const [name, map] of [
          ["createTenant", st.tenants],
          ["createDb", st.dbs],
          ["createRoles", st.roles],
          ["createBilling", st.billings],
          ["sendWelcome", st.welcomes],
        ] as const) {
          const got = map.get(k) ?? 0;
          if (got > n) bad.push(`tenant:${k}: ${name} ran ${got}x across ${n} stretch(es) — duplicated`);
        }
      }
      return bad;
    },
  };
}

/* ------------------------------------------------------------------ */
/* map-reduce — listChunks → mapChunk (read-only) per chunk →         */
/* mergeReport({ job, rows: collected map results }). Bind rows from   */
/* the loop; job stays on the envelope.                               */
/* ------------------------------------------------------------------ */

export const JOB_IDS = ["job-n1", "job-n2", "job-n3", "job-n4"] as const;
export const MR_WIDTH = 3;

export function chunksFor(job: string): Array<{ id: string; text: string }> {
  return Array.from({ length: MR_WIDTH }, (_, i) => ({
    id: `${job}-c${i}`,
    text: `${job}-payload-${"xy".repeat(i + 1)}`,
  }));
}

type MrState = {
  merges: Map<string, number>;
};

export function createMapReduce(): World {
  const st: MrState = { merges: new Map() };
  return {
    name: "map-reduce",
    island: () => stubIsland(),
    tools: () => ({
      listChunks: {
        description: "List work chunks as objects { id, text }.",
        execute: async ({ job }) => {
          await Bun.sleep(12);
          return { chunks: chunksFor(String(job)), job, seq: nextOrd() };
        },
      },
      mapChunk: {
        description: "Read-only transform of one chunk into a row.",
        execute: async ({ id, text }) => {
          await Bun.sleep(8);
          return { id, n: String(text).length, seq: nextOrd() };
        },
      },
      mergeReport: {
        description: "Merge mapped rows for the job. Mutating.",
        execute: async ({ job, rows }, ctx) => {
          await Bun.sleep(14);
          if (ctx?.signal?.aborted) throw new Error("aborted");
          const id = String(job);
          st.merges.set(id, (st.merges.get(id) ?? 0) + 1);
          const n = Array.isArray(rows) ? rows.length : 0;
          return { merged: true, job, n };
        },
      },
    }),
    async *script(goal) {
      const job = String(goal.job);
      const listed = yield { tool: "listChunks", args: { job } };
      const chunks = ((listed.value as { chunks?: Array<{ id?: string; text?: string }> })?.chunks ?? []) as Array<{
        id?: string;
        text?: string;
      }>;
      const mapped: unknown[] = [];
      for (const ch of chunks) {
        const m = yield { tool: "mapChunk", args: { id: ch.id, text: ch.text } };
        mapped.push(m.value);
      }
      const merged = yield { tool: "mergeReport", args: { job, rows: mapped } };
      void merged;
    },
    done: (v) => Boolean((v as { merged?: boolean })?.merged),
    terminal: "mergeReport",
    check(doneGoals) {
      return dupCheck("map-reduce", doneGoals, "job", [{ name: "mergeReport", get: (id) => st.merges.get(id) ?? 0 }]);
    },
  };
}

/* ------------------------------------------------------------------ */
/* moonshot-noise — shuffled unique sequences. Nothing to mine.       */
/* GitHub/terraform-flavoured reads, disjoint from structured worlds. */
/* ------------------------------------------------------------------ */

const MOONSHOT_NOISE_TOOLS = [
  "fetchBlob",
  "showDiff",
  "listGist",
  "getStatus",
  "findHook",
  "listRunner",
  "showLog",
  "fetchTree",
] as const;

export const NOISE_IDS = ["MN-0", "MN-1", "MN-2", "MN-3", "MN-4", "MN-5"] as const;

export function createMoonshotNoise(): World {
  const toolDefs = (): Record<
    string,
    { description: string; execute: (a: Record<string, unknown>) => Promise<unknown> }
  > => {
    const out: Record<string, { description: string; execute: (a: Record<string, unknown>) => Promise<unknown> }> = {};
    for (const name of MOONSHOT_NOISE_TOOLS) {
      out[name] = {
        description: `moonshot-noise tool ${name}`,
        execute: async ({ id }) => {
          await Bun.sleep(8);
          return { name, id, seq: nextOrd() };
        },
      };
    }
    return out;
  };
  return {
    name: "moonshot-noise",
    island: () => stubIsland(),
    tools: () => toolDefs(),
    async *script(goal) {
      const id = String(goal.id);
      const rng = mulberry32(hashStr(id));
      const picks = [...MOONSHOT_NOISE_TOOLS];
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
    terminal: "fetchTree",
    check() {
      return [];
    },
  };
}

export const MOONSHOT_WORLD_FACTORIES = [
  createGithubPr,
  createTerraform,
  createFlags,
  createDnsTls,
  createInventory,
  createTenant,
  createMapReduce,
] as const;
