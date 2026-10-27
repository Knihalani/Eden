/**
 * Helix campaign: shapes that are not a retune of desk / CRM / cart / github /
 * graphql / k8s-poll / saga / stripe-cursor / sentry / oauth / cms / zip / chunk.
 *
 * Launch-pad is a 12-step linear provision (order-of-magnitude turns).
 * Offset is GitLab page/limit, not Stripe nextCursor.
 * Retry is 429-then-ok, not a ready flag.
 * Tree is nested children, not one-level flatten.
 * Unique / sort / reduce / barcode fields are structural, not allowlist names.
 */
import type { IslandCaller } from "@eden/ir";
import { type World } from "./worlds";

let helixOrd = 0;
function nextOrd(): number {
  return ++helixOrd;
}

function stubIsland(): IslandCaller {
  return async () => ({ ok: false });
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

export const SITES = [
  { site: "hel-a", env: "prod" },
  { site: "hel-b", env: "stage" },
  { site: "hel-c", env: "prod" },
  { site: "hel-d", env: "dev" },
] as const;

export const LAUNCH_STEPS = [
  "createSite",
  "createNetwork",
  "createSubnet",
  "createFirewall",
  "createCluster",
  "createNodePool",
  "createRegistry",
  "createSecretStore",
  "createIngress",
  "createDnsRecord",
  "createAlertPolicy",
  "publishSite",
] as const;

function siteKey(site: unknown, env: unknown): string {
  return `${String(site)}|${String(env)}`;
}

/** 12 distinct writes, two-key envelope. Not tenant's 5-step seq. */
export function createLaunchPad(): World {
  const counts = new Map<string, Map<string, number>>();
  for (const step of LAUNCH_STEPS) counts.set(step, new Map());
  return {
    name: "launch-pad",
    island: stubIsland,
    tools: () => {
      const tools: Record<string, { description: string; execute: (args: Record<string, unknown>) => unknown }> = {};
      for (const step of LAUNCH_STEPS) {
        const terminal = step === "publishSite";
        tools[step] = {
          description: terminal ? "Open the site. Mutating." : `${step} for site+env. Mutating.`,
          execute: ({ site, env }) => {
            const k = siteKey(site, env);
            const m = counts.get(step)!;
            m.set(k, (m.get(k) ?? 0) + 1);
            return terminal ? { published: true, site, env } : { ok: true, site, env, step };
          },
        };
      }
      return tools;
    },
    async *script(goal) {
      const site = String(goal.site);
      const env = String(goal.env);
      for (const step of LAUNCH_STEPS) {
        yield { tool: step, args: { site, env } };
      }
    },
    done: (v) => Boolean((v as { published?: boolean })?.published),
    terminal: "publishSite",
    check(doneGoals) {
      const bad: string[] = [];
      const occ = occurrencesBy(doneGoals, (g) => siteKey(g.site, g.env));
      for (const [k, n] of occ) {
        for (const step of LAUNCH_STEPS) {
          const got = counts.get(step)!.get(k) ?? 0;
          if (got !== n) bad.push(`launch:${k}: ${step} ran ${got}x want ${n}`);
        }
      }
      return bad;
    },
  };
}

export const PROJECTS = ["gl-0", "gl-1", "gl-2", "gl-3"] as const;
export const PAGE_SIZE = 2;
export const PAGES = 3;

export function gitlabIssues(project: string): Array<{ iid: number; title: string }> {
  return Array.from({ length: PAGE_SIZE * PAGES }, (_, i) => ({
    iid: i + 1,
    title: `${project}-iss-${i + 1}`,
  }));
}

/** GitLab-style page/limit, not Stripe nextCursor. */
export function createGitlabOffset(): World {
  const commented = new Map<string, number>();
  const closed = new Map<string, number>();
  return {
    name: "gitlab-offset",
    island: stubIsland,
    tools: () => ({
      listIssues: {
        description: "Page issues by 1-based page index.",
        execute: ({ project, page, limit }) => {
          const all = gitlabIssues(String(project));
          const p = Number(page);
          const lim = Number(limit);
          const start = (p - 1) * lim;
          const items = all.slice(start, start + lim);
          return { items, page: p, limit: lim, totalPages: PAGES, seq: nextOrd() };
        },
      },
      commentIssue: {
        description: "Comment on one issue iid. Mutating.",
        execute: ({ project, iid }) => {
          const k = `${project}:${iid}`;
          commented.set(k, (commented.get(k) ?? 0) + 1);
          return { commented: true, project, iid };
        },
      },
      closeBoard: {
        description: "Close the project board. Mutating.",
        execute: ({ project }) => {
          closed.set(String(project), (closed.get(String(project)) ?? 0) + 1);
          return { closed: true, project };
        },
      },
    }),
    async *script(goal) {
      const project = String(goal.project);
      const collected: Array<{ iid: number }> = [];
      for (let page = 1; page <= PAGES; page++) {
        const res = yield { tool: "listIssues", args: { project, page, limit: PAGE_SIZE } };
        const items = ((res.value as { items?: Array<{ iid: number }> })?.items ?? []) as Array<{ iid: number }>;
        for (const it of items) collected.push(it);
      }
      for (const it of collected) yield { tool: "commentIssue", args: { project, iid: it.iid } };
      yield { tool: "closeBoard", args: { project } };
    },
    done: (v) => Boolean((v as { closed?: boolean })?.closed),
    terminal: "closeBoard",
    check(doneGoals) {
      const n = doneGoals.length;
      const bad: string[] = [];
      for (const project of PROJECTS) {
        const all = gitlabIssues(project);
        for (const it of all) {
          const got = commented.get(`${project}:${it.iid}`) ?? 0;
          const want = occurrences(doneGoals, "project").get(project) ?? 0;
          if (got !== want) bad.push(`gitlab:${project}:${it.iid} commented ${got}x want ${want}`);
        }
      }
      for (const [project, want] of occurrences(doneGoals, "project")) {
        const got = closed.get(project) ?? 0;
        if (got !== want) bad.push(`gitlab:${project} closeBoard ${got}x want ${want}`);
      }
      void n;
      return bad;
    },
  };
}

export const IMAGE_TAGS = ["img-0", "img-1", "img-2", "img-3"] as const;

/** 429 twice then success. Not k8s ready-poll (same-args boolean flip on ok calls). */
export function createRateLimitRetry(): World {
  let failsLeft = 2;
  const pushed = new Map<string, number>();
  const tagged = new Map<string, number>();
  return {
    name: "rate-limit-retry",
    island: stubIsland,
    tools: () => ({
      pushImage: {
        description: "Push a container image. Mutating. May 429.",
        execute: ({ tag }) => {
          if (failsLeft > 0) {
            failsLeft -= 1;
            throw new Error("429 rate limited");
          }
          pushed.set(String(tag), (pushed.get(String(tag)) ?? 0) + 1);
          return { pushed: true, tag, seq: nextOrd() };
        },
      },
      tagRelease: {
        description: "Tag the release. Mutating.",
        execute: ({ tag }) => {
          tagged.set(String(tag), (tagged.get(String(tag)) ?? 0) + 1);
          return { released: true, tag };
        },
      },
    }),
    beginStretch() {
      failsLeft = 2;
    },
    async *script(goal) {
      const tag = String(goal.tag);
      for (;;) {
        const r = yield { tool: "pushImage", args: { tag } };
        if (r.ok) break;
      }
      yield { tool: "tagRelease", args: { tag } };
    },
    done: (v) => Boolean((v as { released?: boolean })?.released),
    terminal: "tagRelease",
    check(doneGoals) {
      const bad: string[] = [];
      const occ = occurrences(doneGoals, "tag");
      for (const [tag, n] of occ) {
        const p = pushed.get(tag) ?? 0;
        const t = tagged.get(tag) ?? 0;
        if (p !== n) bad.push(`retry:${tag} pushImage ${p}x want ${n}`);
        if (t !== n) bad.push(`retry:${tag} tagRelease ${t}x want ${n}`);
      }
      return bad;
    },
  };
}

export const TREES = ["tree-0", "tree-1", "tree-2", "tree-3"] as const;

type TreeNode = { path: string; children?: TreeNode[] };

export function treeFor(tree: string): TreeNode {
  return {
    path: `${tree}/root`,
    children: [
      {
        path: `${tree}/a`,
        children: [{ path: `${tree}/a/f0.txt` }, { path: `${tree}/a/f1.txt` }],
      },
      {
        path: `${tree}/b`,
        children: [{ path: `${tree}/b/f0.txt` }],
      },
    ],
  };
}

export function treeLeaves(node: TreeNode): string[] {
  if (!node.children?.length) return [node.path];
  return node.children.flatMap(treeLeaves);
}

/** Nested children of varying depth. Not CMS one-level sections.blocks. */
export function createFsTree(): World {
  const scanned = new Map<string, number>();
  const sealed = new Map<string, number>();
  return {
    name: "fs-tree",
    island: stubIsland,
    tools: () => ({
      listTree: {
        description: "Return a nested directory tree.",
        execute: ({ tree }) => ({ tree: treeFor(String(tree)), seq: nextOrd() }),
      },
      scanFile: {
        description: "Scan one leaf path. Mutating.",
        execute: ({ path }) => {
          scanned.set(String(path), (scanned.get(String(path)) ?? 0) + 1);
          return { scanned: true, path };
        },
      },
      sealTree: {
        description: "Seal the tree. Mutating.",
        execute: ({ tree }) => {
          sealed.set(String(tree), (sealed.get(String(tree)) ?? 0) + 1);
          return { sealed: true, tree };
        },
      },
    }),
    async *script(goal) {
      const tree = String(goal.tree);
      const listed = yield { tool: "listTree", args: { tree } };
      const root = (listed.value as { tree?: TreeNode })?.tree;
      const leaves = root ? treeLeaves(root) : [];
      for (const path of leaves) yield { tool: "scanFile", args: { path } };
      yield { tool: "sealTree", args: { tree } };
    },
    done: (v) => Boolean((v as { sealed?: boolean })?.sealed),
    terminal: "sealTree",
    check(doneGoals) {
      const bad: string[] = [];
      const occ = occurrences(doneGoals, "tree");
      for (const [tree, n] of occ) {
        for (const path of treeLeaves(treeFor(tree))) {
          const got = scanned.get(path) ?? 0;
          if (got !== n) bad.push(`tree:${path} scanned ${got}x want ${n}`);
        }
        const s = sealed.get(tree) ?? 0;
        if (s !== n) bad.push(`tree:${tree} sealed ${s}x want ${n}`);
      }
      return bad;
    },
  };
}

export const INBOXES = ["ib-0", "ib-1", "ib-2", "ib-3"] as const;

export function inboxRows(inbox: string): Array<{ addr: string; n: number }> {
  return [
    { addr: `${inbox}-a@ex.test`, n: 1 },
    { addr: `${inbox}-b@ex.test`, n: 2 },
    { addr: `${inbox}-a@ex.test`, n: 3 },
    { addr: `${inbox}-c@ex.test`, n: 4 },
    { addr: `${inbox}-b@ex.test`, n: 5 },
  ];
}

export function uniqueAddrs(inbox: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of inboxRows(inbox)) {
    if (seen.has(row.addr)) continue;
    seen.add(row.addr);
    out.push(row.addr);
  }
  return out;
}

/** First-seen unique by addr. Not filter level==error. Not prefix top-k. */
export function createDedupeMail(): World {
  const sent = new Map<string, number>();
  const closed = new Map<string, number>();
  return {
    name: "dedupe-mail",
    island: stubIsland,
    tools: () => ({
      listInbox: {
        description: "List recipients with duplicate addrs.",
        execute: ({ inbox }) => ({ rows: inboxRows(String(inbox)), seq: nextOrd() }),
      },
      sendDigest: {
        description: "Send one digest per unique addr. Mutating.",
        execute: ({ addr }) => {
          sent.set(String(addr), (sent.get(String(addr)) ?? 0) + 1);
          return { sent: true, addr };
        },
      },
      closeInbox: {
        description: "Close the inbox. Mutating.",
        execute: ({ inbox }) => {
          closed.set(String(inbox), (closed.get(String(inbox)) ?? 0) + 1);
          return { closed: true, inbox };
        },
      },
    }),
    async *script(goal) {
      const inbox = String(goal.inbox);
      const listed = yield { tool: "listInbox", args: { inbox } };
      const rows = ((listed.value as { rows?: Array<{ addr: string }> })?.rows ?? []) as Array<{ addr: string }>;
      const seen = new Set<string>();
      for (const row of rows) {
        if (seen.has(row.addr)) continue;
        seen.add(row.addr);
        yield { tool: "sendDigest", args: { addr: row.addr } };
      }
      yield { tool: "closeInbox", args: { inbox } };
    },
    done: (v) => Boolean((v as { closed?: boolean })?.closed),
    terminal: "closeInbox",
    check(doneGoals) {
      const bad: string[] = [];
      const occ = occurrences(doneGoals, "inbox");
      for (const [inbox, n] of occ) {
        for (const addr of uniqueAddrs(inbox)) {
          const got = sent.get(addr) ?? 0;
          if (got !== n) bad.push(`mail:${addr} sent ${got}x want ${n}`);
        }
        const extras = [...sent.keys()].filter((a) => a.startsWith(`${inbox}-`) && !uniqueAddrs(inbox).includes(a));
        for (const a of extras) bad.push(`mail: unexpected ${a}`);
        const c = closed.get(inbox) ?? 0;
        if (c !== n) bad.push(`mail:${inbox} closed ${c}x want ${n}`);
      }
      return bad;
    },
  };
}

export const QUEUES = ["q-0", "q-1", "q-2", "q-3"] as const;

export function queueJobs(queue: string): Array<{ id: string; prio: number }> {
  return [
    { id: `${queue}-c`, prio: 1 },
    { id: `${queue}-a`, prio: 9 },
    { id: `${queue}-b`, prio: 5 },
  ];
}

export function jobsByPrio(queue: string): Array<{ id: string; prio: number }> {
  return [...queueJobs(queue)].sort((a, b) => b.prio - a.prio);
}

/** Drain by descending prio. Not unsorted array order, not ranked prefix slice. */
export function createPrioQueue(): World {
  const drained = new Map<string, number>();
  const closed = new Map<string, number>();
  return {
    name: "prio-queue",
    island: stubIsland,
    tools: () => ({
      listJobs: {
        description: "List jobs unsorted.",
        execute: ({ queue }) => ({ jobs: queueJobs(String(queue)), seq: nextOrd() }),
      },
      drainJob: {
        description: "Drain one job. Mutating.",
        execute: ({ id }) => {
          drained.set(String(id), (drained.get(String(id)) ?? 0) + 1);
          return { drained: true, id };
        },
      },
      closeQueue: {
        description: "Close the queue. Mutating.",
        execute: ({ queue }) => {
          closed.set(String(queue), (closed.get(String(queue)) ?? 0) + 1);
          return { closed: true, queue };
        },
      },
    }),
    async *script(goal) {
      const queue = String(goal.queue);
      const listed = yield { tool: "listJobs", args: { queue } };
      const jobs = ((listed.value as { jobs?: Array<{ id: string; prio: number }> })?.jobs ?? []) as Array<{
        id: string;
        prio: number;
      }>;
      const ordered = [...jobs].sort((a, b) => b.prio - a.prio);
      for (const j of ordered) yield { tool: "drainJob", args: { id: j.id } };
      yield { tool: "closeQueue", args: { queue } };
    },
    done: (v) => Boolean((v as { closed?: boolean })?.closed),
    terminal: "closeQueue",
    check(doneGoals) {
      const bad: string[] = [];
      const occ = occurrences(doneGoals, "queue");
      for (const [queue, n] of occ) {
        for (const j of queueJobs(queue)) {
          const got = drained.get(j.id) ?? 0;
          if (got !== n) bad.push(`prio:${j.id} drained ${got}x want ${n}`);
        }
        const c = closed.get(queue) ?? 0;
        if (c !== n) bad.push(`prio:${queue} closed ${c}x want ${n}`);
      }
      return bad;
    },
  };
}

export const BATCHES = ["bat-0", "bat-1", "bat-2", "bat-3"] as const;

export function ledgerLines(batch: string): Array<{ id: string; amt: number }> {
  return [
    { id: `${batch}-l0`, amt: 10 },
    { id: `${batch}-l1`, amt: 25 },
    { id: `${batch}-l2`, amt: 5 },
  ];
}

export function ledgerTotal(batch: string): number {
  return ledgerLines(batch).reduce((s, l) => s + l.amt, 0);
}

/** Foreach lines then one settle with the sum. Not map-reduce merge of objects. */
export function createLedgerSettle(): World {
  const posted = new Map<string, number>();
  const settled = new Map<string, number>();
  return {
    name: "ledger-settle",
    island: stubIsland,
    tools: () => ({
      listLines: {
        description: "List ledger lines with amt.",
        execute: ({ batch }) => ({ lines: ledgerLines(String(batch)), seq: nextOrd() }),
      },
      postLine: {
        description: "Post one line. Mutating.",
        execute: ({ id, amt }) => {
          posted.set(String(id), (posted.get(String(id)) ?? 0) + 1);
          return { posted: true, id, amt };
        },
      },
      settleBatch: {
        description: "Settle the batch for total. Mutating.",
        execute: ({ batch, total }) => {
          settled.set(`${batch}:${total}`, (settled.get(`${batch}:${total}`) ?? 0) + 1);
          return { settled: true, batch, total };
        },
      },
    }),
    async *script(goal) {
      const batch = String(goal.batch);
      const listed = yield { tool: "listLines", args: { batch } };
      const lines = ((listed.value as { lines?: Array<{ id: string; amt: number }> })?.lines ?? []) as Array<{
        id: string;
        amt: number;
      }>;
      let total = 0;
      for (const line of lines) {
        yield { tool: "postLine", args: { id: line.id, amt: line.amt } };
        total += line.amt;
      }
      yield { tool: "settleBatch", args: { batch, total } };
    },
    done: (v) => Boolean((v as { settled?: boolean })?.settled),
    terminal: "settleBatch",
    check(doneGoals) {
      const bad: string[] = [];
      const occ = occurrences(doneGoals, "batch");
      for (const [batch, n] of occ) {
        for (const line of ledgerLines(batch)) {
          const got = posted.get(line.id) ?? 0;
          if (got !== n) bad.push(`ledger:${line.id} posted ${got}x want ${n}`);
        }
        const tot = ledgerTotal(batch);
        const s = settled.get(`${batch}:${tot}`) ?? 0;
        if (s !== n) bad.push(`ledger:${batch} settled ${s}x want ${n} (total ${tot})`);
      }
      return bad;
    },
  };
}

export const WAVES = ["wv-0", "wv-1", "wv-2", "wv-3"] as const;

export function lotsFor(wave: string): Array<{ barcode: string; lotCode: string; qty: number }> {
  return [
    { barcode: `bc-${wave}-0`, lotCode: `lt-${wave}-0`, qty: 4 },
    { barcode: `bc-${wave}-1`, lotCode: `lt-${wave}-1`, qty: 2 },
    { barcode: `bc-${wave}-2`, lotCode: `lt-${wave}-2`, qty: 9 },
  ];
}

/** Fields not in LOOP_ITEM_FIELDS (barcode, lotCode). Both required on the write. */
export function createBarcodeLots(): World {
  const moved = new Map<string, number>();
  const closed = new Map<string, number>();
  return {
    name: "barcode-lots",
    island: stubIsland,
    tools: () => ({
      listLots: {
        description: "List lots with barcode and lotCode.",
        execute: ({ wave }) => ({ lots: lotsFor(String(wave)), seq: nextOrd() }),
      },
      moveLot: {
        description: "Move a lot by barcode+lotCode. Mutating.",
        execute: ({ barcode, lotCode }) => {
          const k = `${barcode}|${lotCode}`;
          moved.set(k, (moved.get(k) ?? 0) + 1);
          return { moved: true, barcode, lotCode };
        },
      },
      closeWave: {
        description: "Close the wave. Mutating.",
        execute: ({ wave }) => {
          closed.set(String(wave), (closed.get(String(wave)) ?? 0) + 1);
          return { closed: true, wave };
        },
      },
    }),
    async *script(goal) {
      const wave = String(goal.wave);
      const listed = yield { tool: "listLots", args: { wave } };
      const lots = ((listed.value as { lots?: Array<{ barcode: string; lotCode: string }> })?.lots ?? []) as Array<{
        barcode: string;
        lotCode: string;
      }>;
      for (const lot of lots) yield { tool: "moveLot", args: { barcode: lot.barcode, lotCode: lot.lotCode } };
      yield { tool: "closeWave", args: { wave } };
    },
    done: (v) => Boolean((v as { closed?: boolean })?.closed),
    terminal: "closeWave",
    check(doneGoals) {
      const bad: string[] = [];
      const occ = occurrences(doneGoals, "wave");
      for (const [wave, n] of occ) {
        for (const lot of lotsFor(wave)) {
          const k = `${lot.barcode}|${lot.lotCode}`;
          const got = moved.get(k) ?? 0;
          if (got !== n) bad.push(`lots:${k} moved ${got}x want ${n}`);
        }
        const c = closed.get(wave) ?? 0;
        if (c !== n) bad.push(`lots:${wave} closed ${c}x want ${n}`);
      }
      return bad;
    },
  };
}

export const NOISE_IDS = ["hx-0", "hx-1", "hx-2", "hx-3"] as const;

const NOISE_READS = [
  "fetchBlob",
  "showDiff",
  "listHosts",
  "runQuery",
  "describeRole",
  "listPods",
  "searchHits",
] as const;

/** Unique-work: shuffled unrelated reads. compile 0 programs. check empty. */
export function createHelixNoise(): World {
  return {
    name: "helix-noise",
    island: stubIsland,
    tools: () => {
      const tools: Record<string, { description: string; execute: (args: Record<string, unknown>) => unknown }> = {};
      for (const name of NOISE_READS) {
        tools[name] = {
          description: "Unrelated read.",
          execute: (args) => ({ ...args, seq: nextOrd() }),
        };
      }
      tools.ackNoise = {
        description: "Ack the unique stretch.",
        execute: ({ id }) => ({ acked: true, id }),
      };
      return tools;
    },
    async *script(goal, rng) {
      const id = String(goal.id);
      const picks = [...NOISE_READS].sort(() => rng() - 0.5).slice(0, 4);
      for (const name of picks) yield { tool: name, args: { id, q: `${name}-${id}` } };
      yield { tool: "ackNoise", args: { id } };
    },
    done: (v) => Boolean((v as { acked?: boolean })?.acked),
    terminal: "ackNoise",
    check() {
      return [];
    },
  };
}

export const HELIX_WORLD_FACTORIES = [
  createLaunchPad,
  createGitlabOffset,
  createRateLimitRetry,
  createFsTree,
  createDedupeMail,
  createPrioQueue,
  createLedgerSettle,
  createBarcodeLots,
  createHelixNoise,
] as const;
