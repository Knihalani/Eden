/**
 * Apex campaign: shapes that are not a retune of desk / CRM / github / graphql /
 * k8s / saga. Cursor invoices, HRIS lookup, error-level filter, CMS nested
 * flatten, transcode chunks, catalog zip, OAuth token carry, unique-work noise.
 */
import type { IslandCaller } from "@eden/ir";
import { type World } from "./worlds";

let apexOrd = 0;
function nextOrd(): number {
  return ++apexOrd;
}

function stubIsland(): IslandCaller {
  return async () => ({ ok: false });
}

export const STRIPE_INVOICES = ["INV-a", "INV-b", "INV-c", "INV-d", "INV-e", "INV-f"] as const;
export const MERCHANTS = ["m0", "m1", "m2", "m3"] as const;
export const ORGS = ["org-a", "org-b", "org-c", "org-d"] as const;
export const SVCS = ["api", "web", "worker", "cron"] as const;
export const SITES = ["site-0", "site-1", "site-2", "site-3"] as const;
export const JOBS = ["job-0", "job-1", "job-2", "job-3"] as const;
export const CATS = ["cat-0", "cat-1", "cat-2", "cat-3"] as const;
export const USERS = ["u0", "u1", "u2", "u3"] as const;
export const NOISE_IDS = ["n0", "n1", "n2", "n3"] as const;

export function createStripeInvoices(): World {
  const posted = new Map<string, number>();
  const pages: string[][] = [];
  for (let i = 0; i < STRIPE_INVOICES.length; i += 2) pages.push([...STRIPE_INVOICES.slice(i, i + 2)]);
  return {
    name: "stripe-invoices",
    island: stubIsland,
    tools: () => ({
      listInvoices: {
        description: "Page invoices by cursor.",
        execute: async ({ cursor }) => {
          const idx = cursor == null || cursor === "" ? 0 : Number(cursor);
          const items = pages[idx] ?? [];
          const next = idx + 1 < pages.length ? String(idx + 1) : null;
          return { items, nextCursor: next, page: idx, seq: nextOrd() };
        },
      },
      postInvoice: {
        description: "Post one invoice. Mutating.",
        execute: async ({ id }) => {
          posted.set(String(id), (posted.get(String(id)) ?? 0) + 1);
          return { posted: true, id };
        },
      },
      closeBooks: {
        description: "Close the merchant books.",
        execute: async ({ merchant }) => ({ closed: true, merchant }),
      },
    }),
    async *script(goal) {
      const merchant = String(goal.merchant ?? "m0");
      const collected: string[] = [];
      let cursor: string | null = null;
      for (;;) {
        const page = yield { tool: "listInvoices", args: { cursor, merchant } };
        const body = (page.value ?? {}) as { items?: string[]; nextCursor?: string | null };
        for (const id of body.items ?? []) collected.push(id);
        if (body.nextCursor == null) break;
        cursor = body.nextCursor;
      }
      for (const id of collected) yield { tool: "postInvoice", args: { id } };
      yield { tool: "closeBooks", args: { merchant } };
    },
    done: (v) => Boolean((v as { closed?: boolean })?.closed),
    terminal: "closeBooks",
    check(doneGoals) {
      const n = doneGoals.length;
      const bad: string[] = [];
      for (const id of STRIPE_INVOICES) {
        const got = posted.get(id) ?? 0;
        if (got !== n) bad.push(`stripe:${id}: postInvoice ran ${got}x across ${n} stretch(es)`);
      }
      return bad;
    },
  };
}

export function createHrisJoin(): World {
  const assigned = new Map<string, number>();
  return {
    name: "hris-join",
    island: stubIsland,
    tools: () => ({
      listPeople: {
        description: "People in the org.",
        execute: async ({ org }) => ({
          people: [
            { id: `${org}-p0`, deptId: `${org}-eng` },
            { id: `${org}-p1`, deptId: `${org}-sales` },
            { id: `${org}-p2`, deptId: `${org}-eng` },
          ],
          seq: nextOrd(),
        }),
      },
      listTeams: {
        description: "Teams in the org.",
        execute: async ({ org }) => ({
          teams: [
            { id: `${org}-eng`, name: "Eng" },
            { id: `${org}-sales`, name: "Sales" },
          ],
          seq: nextOrd(),
        }),
      },
      assignSeat: {
        description: "Assign a seat. Mutating.",
        execute: async ({ person }) => {
          assigned.set(String(person), (assigned.get(String(person)) ?? 0) + 1);
          return { assigned: true, person };
        },
      },
      ackHris: {
        description: "Ack the org.",
        execute: async ({ org }) => ({ ok: true, org }),
      },
    }),
    async *script(goal) {
      const org = String(goal.org ?? "org-a");
      const people = yield { tool: "listPeople", args: { org } };
      const teams = yield { tool: "listTeams", args: { org } };
      const plist = ((people.value as { people?: Array<{ id: string; deptId: string }> })?.people ?? []);
      const tlist = ((teams.value as { teams?: Array<{ id: string; name: string }> })?.teams ?? []);
      for (const p of plist) {
        const team = tlist.find((t) => t.id === p.deptId);
        yield { tool: "assignSeat", args: { person: p.id, teamName: team?.name } };
      }
      yield { tool: "ackHris", args: { org } };
    },
    done: (v) => Boolean((v as { ok?: boolean; org?: string })?.ok && (v as { org?: string }).org),
    terminal: "ackHris",
    check(doneGoals) {
      const occ = new Map<string, number>();
      for (const g of doneGoals) occ.set(String(g.org), (occ.get(String(g.org)) ?? 0) + 1);
      const bad: string[] = [];
      for (const [org, n] of occ) {
        for (const p of [`${org}-p0`, `${org}-p1`, `${org}-p2`]) {
          const got = assigned.get(p) ?? 0;
          if (got !== n) bad.push(`hris:${p}: assignSeat ran ${got}x want ${n}`);
        }
      }
      return bad;
    },
  };
}

export function createSentryFilter(): World {
  const paged = new Map<string, number>();
  return {
    name: "sentry-filter",
    island: stubIsland,
    tools: () => ({
      listEvents: {
        description: "Events for a service.",
        execute: async ({ q }) => ({
          events: [
            { id: `${q}-0`, level: "info" },
            { id: `${q}-1`, level: "error" },
            { id: `${q}-2`, level: "warn" },
            { id: `${q}-3`, level: "error" },
            { id: `${q}-4`, level: "debug" },
          ],
          seq: nextOrd(),
        }),
      },
      pageOncall: {
        description: "Page on-call. Mutating.",
        execute: async ({ id }) => {
          paged.set(String(id), (paged.get(String(id)) ?? 0) + 1);
          return { paged: true, id };
        },
      },
      writeDigest: {
        description: "Write the digest.",
        execute: async ({ q }) => ({ wrote: true, q }),
      },
    }),
    async *script(goal) {
      const q = String(goal.q ?? "api");
      const listed = yield { tool: "listEvents", args: { q } };
      const events = ((listed.value as { events?: Array<{ id: string; level: string }> })?.events ?? []).filter((e) => e.level === "error");
      for (const e of events) yield { tool: "pageOncall", args: { id: e.id } };
      yield { tool: "writeDigest", args: { q } };
    },
    done: (v) => Boolean((v as { wrote?: boolean })?.wrote),
    terminal: "writeDigest",
    check(doneGoals) {
      const occ = new Map<string, number>();
      for (const g of doneGoals) occ.set(String(g.q), (occ.get(String(g.q)) ?? 0) + 1);
      const bad: string[] = [];
      for (const [q, n] of occ) {
        for (const id of [`${q}-1`, `${q}-3`]) {
          const got = paged.get(id) ?? 0;
          if (got !== n) bad.push(`sentry:${id}: pageOncall ran ${got}x want ${n}`);
        }
        for (const id of [`${q}-0`, `${q}-2`, `${q}-4`]) {
          const got = paged.get(id) ?? 0;
          if (got !== 0) bad.push(`sentry:${id}: info/warn was paged`);
        }
      }
      return bad;
    },
  };
}

export function createCmsFlatten(): World {
  const published = new Map<string, number>();
  return {
    name: "cms-flatten",
    island: stubIsland,
    tools: () => ({
      listPage: {
        description: "Page sections with nested blocks.",
        execute: async ({ site }) => ({
          sections: [
            { blocks: [{ id: `${site}-b0` }, { id: `${site}-b1` }] },
            { blocks: [{ id: `${site}-b2` }] },
          ],
          seq: nextOrd(),
        }),
      },
      publishBlock: {
        description: "Publish a block. Mutating.",
        execute: async ({ id }) => {
          published.set(String(id), (published.get(String(id)) ?? 0) + 1);
          return { ok: true, id };
        },
      },
      ackSite: {
        description: "Ack the site.",
        execute: async ({ site }) => ({ ok: true, site }),
      },
    }),
    async *script(goal) {
      const site = String(goal.site ?? "site-0");
      const page = yield { tool: "listPage", args: { site } };
      const sections = (page.value as { sections?: Array<{ blocks: Array<{ id: string }> }> })?.sections ?? [];
      for (const s of sections) for (const b of s.blocks) yield { tool: "publishBlock", args: { id: b.id } };
      yield { tool: "ackSite", args: { site } };
    },
    done: (v) => Boolean((v as { site?: string })?.site),
    terminal: "ackSite",
    check(doneGoals) {
      const occ = new Map<string, number>();
      for (const g of doneGoals) occ.set(String(g.site), (occ.get(String(g.site)) ?? 0) + 1);
      const bad: string[] = [];
      for (const [site, n] of occ) {
        for (const id of [`${site}-b0`, `${site}-b1`, `${site}-b2`]) {
          const got = published.get(id) ?? 0;
          if (got !== n) bad.push(`cms:${id}: publishBlock ran ${got}x want ${n}`);
        }
      }
      return bad;
    },
  };
}

export function createTranscodeChunk(): World {
  const batches = new Map<string, number>();
  return {
    name: "transcode-chunk",
    island: stubIsland,
    tools: () => ({
      listAssets: {
        description: "Files in a job.",
        execute: async ({ job }) => ({
          files: Array.from({ length: 8 }, (_, j) => `${job}-f${j}.mov`),
          seq: nextOrd(),
        }),
      },
      processBatch: {
        description: "Transcode a batch. Mutating.",
        execute: async ({ items }) => {
          const key = JSON.stringify(items);
          batches.set(key, (batches.get(key) ?? 0) + 1);
          return { n: Array.isArray(items) ? items.length : 0 };
        },
      },
      publishJob: {
        description: "Publish the job.",
        execute: async ({ job }) => ({ ok: true, job }),
      },
    }),
    async *script(goal) {
      const job = String(goal.job ?? "job-0");
      const listed = yield { tool: "listAssets", args: { job } };
      const files = (listed.value as { files?: string[] })?.files ?? [];
      for (let i = 0; i < files.length; i += 4) {
        yield { tool: "processBatch", args: { items: files.slice(i, i + 4) } };
      }
      yield { tool: "publishJob", args: { job } };
    },
    done: (v) => Boolean((v as { job?: string })?.job),
    terminal: "publishJob",
    check(doneGoals) {
      const n = doneGoals.length;
      let total = 0;
      for (const v of batches.values()) total += v;
      if (total !== n * 2) return [`transcode: processBatch ran ${total}x want ${n * 2}`];
      return [];
    },
  };
}

export function createCatalogZip(): World {
  const set = new Map<string, number>();
  return {
    name: "catalog-zip",
    island: stubIsland,
    tools: () => ({
      listSkus: {
        description: "Catalog skus.",
        execute: async ({ cat }) => ({
          skus: [{ sku: `${cat}-a` }, { sku: `${cat}-b` }, { sku: `${cat}-c` }],
          seq: nextOrd(),
        }),
      },
      listPrices: {
        description: "Catalog prices.",
        execute: async ({ cat }) => ({
          prices: [{ cents: 100 }, { cents: 200 }, { cents: 300 }],
          seq: nextOrd(),
        }),
      },
      setPrice: {
        description: "Set a sku price. Mutating.",
        execute: async ({ sku }) => {
          set.set(String(sku), (set.get(String(sku)) ?? 0) + 1);
          return { ok: true, sku };
        },
      },
      ackCatalog: {
        description: "Ack the catalog.",
        execute: async ({ cat }) => ({ ok: true, cat }),
      },
    }),
    async *script(goal) {
      const cat = String(goal.cat ?? "cat-0");
      const skus = yield { tool: "listSkus", args: { cat } };
      const prices = yield { tool: "listPrices", args: { cat } };
      const sl = (skus.value as { skus?: Array<{ sku: string }> })?.skus ?? [];
      const pl = (prices.value as { prices?: Array<{ cents: number }> })?.prices ?? [];
      for (let i = 0; i < sl.length; i++) {
        yield { tool: "setPrice", args: { sku: sl[i]!.sku, cents: pl[i]!.cents } };
      }
      yield { tool: "ackCatalog", args: { cat } };
    },
    done: (v) => Boolean((v as { cat?: string })?.cat),
    terminal: "ackCatalog",
    check(doneGoals) {
      const occ = new Map<string, number>();
      for (const g of doneGoals) occ.set(String(g.cat), (occ.get(String(g.cat)) ?? 0) + 1);
      const bad: string[] = [];
      for (const [cat, n] of occ) {
        for (const sku of [`${cat}-a`, `${cat}-b`, `${cat}-c`]) {
          const got = set.get(sku) ?? 0;
          if (got !== n) bad.push(`zip:${sku}: setPrice ran ${got}x want ${n}`);
        }
      }
      return bad;
    },
  };
}

export function createOauthSession(): World {
  const logouts = new Map<string, number>();
  return {
    name: "oauth-session",
    island: stubIsland,
    tools: () => ({
      login: {
        description: "Login and return a token.",
        execute: async ({ user }) => ({ token: `tok-${user}`, seq: nextOrd() }),
      },
      getProfile: {
        description: "Read profile with token.",
        execute: async ({ token }) => ({ user: String(token).slice(4), seq: nextOrd() }),
      },
      getBilling: {
        description: "Read billing with token.",
        execute: async ({ token }) => ({ plan: "pro", token, seq: nextOrd() }),
      },
      getUsage: {
        description: "Read usage with token.",
        execute: async ({ token }) => ({ calls: 9, token, seq: nextOrd() }),
      },
      revokeToken: {
        description: "Revoke the session token. Mutating.",
        execute: async ({ token }) => {
          logouts.set(String(token), (logouts.get(String(token)) ?? 0) + 1);
          return { revoked: true, token };
        },
      },
    }),
    async *script(goal) {
      const user = String(goal.user ?? "u0");
      const login = yield { tool: "login", args: { user } };
      const token = (login.value as { token?: string })?.token;
      yield { tool: "getProfile", args: { token } };
      yield { tool: "getBilling", args: { token } };
      yield { tool: "getUsage", args: { token } };
      yield { tool: "revokeToken", args: { token } };
    },
    done: (v) => Boolean((v as { revoked?: boolean })?.revoked),
    terminal: "revokeToken",
    check(doneGoals) {
      const occ = new Map<string, number>();
      for (const g of doneGoals) occ.set(String(g.user), (occ.get(String(g.user)) ?? 0) + 1);
      const bad: string[] = [];
      for (const [user, n] of occ) {
        const token = `tok-${user}`;
        const got = logouts.get(token) ?? 0;
        if (got !== n) bad.push(`oauth:${token}: revokeToken ran ${got}x want ${n}`);
      }
      return bad;
    },
  };
}

export function createApexNoise(): World {
  return {
    name: "apex-noise",
    island: stubIsland,
    tools: () => ({
      scanInbox: { description: "n", execute: async ({ id }) => ({ id, seq: nextOrd() }) },
      fetchBlob: { description: "n", execute: async ({ id }) => ({ id, seq: nextOrd() }) },
      showDiff: { description: "n", execute: async ({ id }) => ({ id, seq: nextOrd() }) },
      listHosts: { description: "n", execute: async ({ id }) => ({ id, seq: nextOrd() }) },
      runQuery: { description: "n", execute: async ({ id }) => ({ id, seq: nextOrd() }) },
    }),
    async *script(goal, rng) {
      const id = String(goal.id ?? "n0");
      const tools = ["scanInbox", "fetchBlob", "showDiff", "listHosts", "runQuery"];
      const seq = [...tools].sort(() => rng() - 0.5).slice(0, 4);
      for (const tool of seq) yield { tool, args: { id } };
    },
    done: () => false,
    terminal: "runQuery",
    check: () => [],
  };
}

export const SVCS_GROUP = ["api", "web", "worker", "cron"] as const;

export function createLogGroup(): World {
  const flushed = new Map<string, number>();
  return {
    name: "log-group",
    island: stubIsland,
    tools: () => ({
      listLogs: {
        description: "Logs for a service.",
        execute: async ({ svc }) => ({
          events: [
            { id: `${svc}-0`, level: "info" },
            { id: `${svc}-1`, level: "error" },
            { id: `${svc}-2`, level: "info" },
            { id: `${svc}-3`, level: "error" },
            { id: `${svc}-4`, level: "info" },
            { id: `${svc}-5`, level: "error" },
          ],
        }),
      },
      flushLevel: {
        description: "Flush one level bucket. Mutating.",
        execute: async ({ level, items }) => {
          const n = Array.isArray(items) ? items.length : 0;
          flushed.set(`${String(level)}:${n}`, (flushed.get(`${String(level)}:${n}`) ?? 0) + 1);
          return { flushed: true, level, n };
        },
      },
      ackLogs: {
        description: "Ack the service logs.",
        execute: async ({ svc }) => ({ acked: true, svc }),
      },
    }),
    async *script(goal) {
      const svc = String(goal.svc ?? "api");
      const listed = yield { tool: "listLogs", args: { svc } };
      const events = ((listed.value as { events?: Array<{ id: string; level: string }> })?.events ?? []);
      const order: string[] = [];
      const groups = new Map<string, typeof events>();
      for (const e of events) {
        if (!groups.has(e.level)) {
          groups.set(e.level, []);
          order.push(e.level);
        }
        groups.get(e.level)!.push(e);
      }
      for (const level of order) {
        const items = groups.get(level)!;
        yield { tool: "flushLevel", args: { level, items } };
      }
      yield { tool: "ackLogs", args: { svc } };
    },
    done: (v) => Boolean((v as { acked?: boolean })?.acked),
    terminal: "ackLogs",
    check(doneGoals) {
      const n = doneGoals.length;
      const bad: string[] = [];
      if ((flushed.get("info:3") ?? 0) !== n) bad.push(`group:info flushed ${flushed.get("info:3") ?? 0} want ${n}`);
      if ((flushed.get("error:3") ?? 0) !== n) bad.push(`group:error flushed ${flushed.get("error:3") ?? 0} want ${n}`);
      return bad;
    },
  };
}

export const APEX_WORLD_FACTORIES = [
  createStripeInvoices,
  createHrisJoin,
  createSentryFilter,
  createCmsFlatten,
  createTranscodeChunk,
  createCatalogZip,
  createOauthSession,
  createLogGroup,
  createApexNoise,
];
