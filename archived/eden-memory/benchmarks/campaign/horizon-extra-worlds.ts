/**
 * Extra horizon shapes the first nine worlds do not cover: nested foreach
 * with outer-scope binds, 3-way severity fork, set-diff except, four-level
 * JSON, email tz loop, s3 versionId loop.
 *
 * Not a retune of graphql-relay / sso / search / k8s-poll / saga / blob /
 * sql / webhook / inbox.
 */
import type { IslandCaller } from "@eden/ir";
import { hashStr, type World } from "./worlds";

let extraOrd = 0;
function nextOrd(): number {
  return ++extraOrd;
}

function occurrences(goals: Array<Record<string, unknown>>, key: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const g of goals) m.set(String(g[key]), (m.get(String(g[key])) ?? 0) + 1);
  return m;
}

function stubIsland(): IslandCaller {
  return async () => ({ ok: false });
}

export const NEST_CLUSTERS = ["cls-alpha", "cls-bravo", "cls-charlie", "cls-delta"] as const;

export function nestNs(cluster: string): Array<{ name: string }> {
  return [`${cluster}-ns0`, `${cluster}-ns1`].map((name) => ({ name }));
}
export function nestPods(ns: string): Array<{ name: string; node: string }> {
  return [`${ns}-pod0`, `${ns}-pod1`].map((name, i) => ({ name, node: `node-${i}` }));
}

export function createK8sNested(): World {
  const patches = new Map<string, number>();
  const verifies = new Map<string, number>();
  return {
    name: "k8s-nested",
    island: () => stubIsland(),
    tools: () => ({
      listNs: {
        description: "Namespaces as { name }.",
        execute: async ({ cluster }) => {
          await Bun.sleep(8);
          return { namespaces: nestNs(String(cluster)), cluster, seq: nextOrd() };
        },
      },
      listPods: {
        description: "Pods { name, node } — does not echo ns.",
        execute: async ({ ns }) => {
          await Bun.sleep(6);
          return { pods: nestPods(String(ns)), ns };
        },
      },
      patchPod: {
        description: "Patch pod. ns from outer loop, name from inner item.",
        execute: async ({ ns, name }) => {
          await Bun.sleep(8);
          const k = `${ns}/${name}`;
          patches.set(k, (patches.get(k) ?? 0) + 1);
          return { patched: true, ns, name };
        },
      },
      verifyCluster: {
        description: "Verify the cluster.",
        execute: async ({ cluster }) => {
          await Bun.sleep(8);
          const id = String(cluster);
          verifies.set(id, (verifies.get(id) ?? 0) + 1);
          return { verified: true, cluster };
        },
      },
    }),
    async *script(goal) {
      const cluster = String(goal.cluster);
      const listed = yield { tool: "listNs", args: { cluster } };
      const nss = ((listed.value as { namespaces?: Array<{ name?: string }> })?.namespaces ?? []) as Array<{
        name?: string;
      }>;
      for (const row of nss) {
        const ns = String(row.name);
        const podsListed = yield { tool: "listPods", args: { ns } };
        const pods = ((podsListed.value as { pods?: Array<{ name?: string }> })?.pods ?? []) as Array<{
          name?: string;
        }>;
        for (const pod of pods) yield { tool: "patchPod", args: { ns, name: pod.name } };
      }
      yield { tool: "verifyCluster", args: { cluster } };
    },
    done: (v) => Boolean((v as { verified?: boolean })?.verified),
    terminal: "verifyCluster",
    check(doneGoals) {
      const bad: string[] = [];
      const occ = occurrences(doneGoals, "cluster");
      for (const [cluster, n] of occ) {
        if ((verifies.get(cluster) ?? 0) > n) bad.push(`k8s-nested:${cluster}: verifyCluster duplicated`);
        for (const ns of nestNs(cluster)) {
          for (const pod of nestPods(ns.name)) {
            const k = `${ns.name}/${pod.name}`;
            if ((patches.get(k) ?? 0) > n) bad.push(`k8s-nested:${cluster}: patchPod ${k} duplicated`);
          }
        }
      }
      return bad;
    },
  };
}

export const CAMPAIGN_IDS = ["cmp-spring", "cmp-summer", "cmp-autumn", "cmp-winter"] as const;
export function subsFor(campaign: string): Array<{ email: string; segment: string; tz: string; timezone: string }> {
  const segs = ["new", "loyal", "lapsed"] as const;
  const tzs = ["America/New_York", "Europe/London", "Asia/Tokyo"] as const;
  return Array.from({ length: 3 }, (_, i) => ({
    email: `${campaign}-${i}@drip.test`,
    segment: segs[i]!,
    tz: tzs[i]!,
    timezone: tzs[i]!,
  }));
}

export function createEmailDrip(): World {
  const sends = new Map<string, number>();
  const writes = new Map<string, number>();
  return {
    name: "email-drip",
    island: () => stubIsland(),
    tools: () => ({
      listSubscribers: {
        description: "Subscribers { email, segment, tz }.",
        execute: async ({ campaign }) => {
          await Bun.sleep(8);
          return { subs: subsFor(String(campaign)), campaign, seq: nextOrd() };
        },
      },
      sendMail: {
        description: "Send one drip with timezone.",
        execute: async ({ email, segment, tz, timezone }) => {
          await Bun.sleep(8);
          sends.set(String(email), (sends.get(String(email)) ?? 0) + 1);
          return { sent: true, email, segment, tz, timezone };
        },
      },
      writeEvent: {
        description: "Record the campaign.",
        execute: async ({ campaign }) => {
          await Bun.sleep(8);
          writes.set(String(campaign), (writes.get(String(campaign)) ?? 0) + 1);
          return { recorded: true, campaign };
        },
      },
    }),
    async *script(goal) {
      const campaign = String(goal.campaign);
      const listed = yield { tool: "listSubscribers", args: { campaign } };
      const subs = ((
        listed.value as { subs?: Array<{ email?: string; segment?: string; tz?: string; timezone?: string }> }
      )?.subs ?? []) as Array<{
        email?: string;
        segment?: string;
        tz?: string;
        timezone?: string;
      }>;
      for (const s of subs) {
        yield {
          tool: "sendMail",
          args: { email: s.email, segment: s.segment, timezone: s.timezone, campaign },
        };
      }
      yield { tool: "writeEvent", args: { campaign } };
    },
    done: (v) => Boolean((v as { recorded?: boolean })?.recorded),
    terminal: "writeEvent",
    check(doneGoals) {
      const bad: string[] = [];
      const occ = occurrences(doneGoals, "campaign");
      for (const [campaign, n] of occ) {
        if ((writes.get(campaign) ?? 0) > n) bad.push(`email-drip:${campaign}: writeEvent duplicated`);
        for (const s of subsFor(campaign)) {
          if ((sends.get(s.email) ?? 0) > n) bad.push(`email-drip:${campaign}: sendMail ${s.email} duplicated`);
        }
      }
      return bad;
    },
  };
}

export const BUCKET_IDS = ["bkt-alpha", "bkt-bravo", "bkt-charlie", "bkt-delta"] as const;
export function versionsFor(bucket: string): Array<{ key: string; versionId: string; size: number }> {
  return Array.from({ length: 3 }, (_, i) => ({
    key: `${bucket}/obj-${i}.bin`,
    versionId: `v${hashStr(`${bucket}:${i}`).toString(16).padStart(8, "0")}`,
    size: 1024 * (i + 1),
  }));
}

export function createS3Restore(): World {
  const restores = new Map<string, number>();
  const publishes = new Map<string, number>();
  return {
    name: "s3-restore",
    island: () => stubIsland(),
    tools: () => ({
      listVersions: {
        description: "Versions { key, versionId, size }.",
        execute: async ({ bucket }) => {
          await Bun.sleep(8);
          return { versions: versionsFor(String(bucket)), bucket, seq: nextOrd() };
        },
      },
      createRestore: {
        description: "Restore one version.",
        execute: async ({ key, versionId }) => {
          await Bun.sleep(8);
          const k = `${key}@${versionId}`;
          restores.set(k, (restores.get(k) ?? 0) + 1);
          return { restored: true, key, versionId };
        },
      },
      publishManifest: {
        description: "Publish restore manifest.",
        execute: async ({ bucket }) => {
          await Bun.sleep(8);
          publishes.set(String(bucket), (publishes.get(String(bucket)) ?? 0) + 1);
          return { published: true, bucket };
        },
      },
    }),
    async *script(goal) {
      const bucket = String(goal.bucket);
      const listed = yield { tool: "listVersions", args: { bucket } };
      const versions = ((listed.value as { versions?: Array<{ key?: string; versionId?: string }> })?.versions ??
        []) as Array<{
        key?: string;
        versionId?: string;
      }>;
      for (const v of versions) yield { tool: "createRestore", args: { key: v.key, versionId: v.versionId, bucket } };
      yield { tool: "publishManifest", args: { bucket } };
    },
    done: (v) => Boolean((v as { published?: boolean })?.published),
    terminal: "publishManifest",
    check(doneGoals) {
      const bad: string[] = [];
      const occ = occurrences(doneGoals, "bucket");
      for (const [bucket, n] of occ) {
        if ((publishes.get(bucket) ?? 0) > n) bad.push(`s3-restore:${bucket}: publishManifest duplicated`);
        for (const v of versionsFor(bucket)) {
          const k = `${v.key}@${v.versionId}`;
          if ((restores.get(k) ?? 0) > n) bad.push(`s3-restore:${bucket}: createRestore ${k} duplicated`);
        }
      }
      return bad;
    },
  };
}

export const SEV_ALERTS = [
  "al-100",
  "al-101",
  "al-102",
  "al-110",
  "al-111",
  "al-112",
  "al-120",
  "al-121",
  "al-122",
] as const;
export function sevFor(alert: string): "p0" | "p1" | "p2" {
  const n = Number(String(alert).replace(/\D/g, "")) || 0;
  const r = n % 10;
  if (r === 0) return "p0";
  if (r === 1) return "p1";
  return "p2";
}

export function createSevTriage(): World {
  const pages = new Map<string, number>();
  const tickets = new Map<string, number>();
  const logs = new Map<string, number>();
  const acks = new Map<string, number>();
  return {
    name: "sev-triage",
    island: () => stubIsland(),
    tools: () => ({
      getAlert: {
        description: "Severity p0|p1|p2.",
        execute: async ({ alert }) => {
          await Bun.sleep(6);
          const id = String(alert);
          return { sev: sevFor(id), alert: id, seq: nextOrd() };
        },
      },
      createPage: {
        description: "Page p0.",
        execute: async ({ alert }) => {
          await Bun.sleep(6);
          pages.set(String(alert), (pages.get(String(alert)) ?? 0) + 1);
          return { paged: true, alert };
        },
      },
      sendAckPage: {
        description: "Ack page.",
        execute: async ({ alert }) => {
          await Bun.sleep(6);
          acks.set(String(alert), (acks.get(String(alert)) ?? 0) + 1);
          return { done: true, alert };
        },
      },
      createTicket: {
        description: "Ticket p1.",
        execute: async ({ alert }) => {
          await Bun.sleep(6);
          tickets.set(String(alert), (tickets.get(String(alert)) ?? 0) + 1);
          return { filed: true, alert };
        },
      },
      sendAckTicket: {
        description: "Ack ticket.",
        execute: async ({ alert }) => {
          await Bun.sleep(6);
          acks.set(String(alert), (acks.get(String(alert)) ?? 0) + 1);
          return { done: true, alert };
        },
      },
      writeLog: {
        description: "Log p2.",
        execute: async ({ alert }) => {
          await Bun.sleep(6);
          logs.set(String(alert), (logs.get(String(alert)) ?? 0) + 1);
          return { logged: true, alert };
        },
      },
      sendAckLog: {
        description: "Ack log.",
        execute: async ({ alert }) => {
          await Bun.sleep(6);
          acks.set(String(alert), (acks.get(String(alert)) ?? 0) + 1);
          return { done: true, alert };
        },
      },
    }),
    async *script(goal) {
      const alert = String(goal.alert);
      const got = yield { tool: "getAlert", args: { alert } };
      const sev = String((got.value as { sev?: string })?.sev ?? sevFor(alert));
      if (sev === "p0") {
        yield { tool: "createPage", args: { alert } };
        yield { tool: "sendAckPage", args: { alert } };
        return;
      }
      if (sev === "p1") {
        yield { tool: "createTicket", args: { alert } };
        yield { tool: "sendAckTicket", args: { alert } };
        return;
      }
      yield { tool: "writeLog", args: { alert } };
      yield { tool: "sendAckLog", args: { alert } };
    },
    done: (v) => Boolean((v as { done?: boolean })?.done),
    terminal: "sendAckLog",
    check(doneGoals) {
      const bad: string[] = [];
      const occ = occurrences(doneGoals, "alert");
      for (const [id, n] of occ) {
        const sev = sevFor(id);
        if (sev === "p0" && (pages.get(id) ?? 0) > n) bad.push(`sev-triage:${id}: createPage duplicated`);
        if (sev === "p1" && (tickets.get(id) ?? 0) > n) bad.push(`sev-triage:${id}: createTicket duplicated`);
        if (sev === "p2" && (logs.get(id) ?? 0) > n) bad.push(`sev-triage:${id}: writeLog duplicated`);
        if ((acks.get(id) ?? 0) > n) bad.push(`sev-triage:${id}: ack duplicated`);
      }
      return bad;
    },
  };
}

export const DELTA_WAVES = ["dw-0", "dw-1", "dw-2", "dw-3"] as const;
export function desiredFor(wave: string): Array<{ id: string }> {
  return [`${wave}-a`, `${wave}-b`, `${wave}-c`].map((id) => ({ id }));
}
export function currentFor(wave: string): Array<{ id: string }> {
  return [{ id: `${wave}-a` }];
}

export function createDelta(): World {
  const creates = new Map<string, number>();
  const publishes = new Map<string, number>();
  return {
    name: "delta",
    island: () => stubIsland(),
    tools: () => ({
      listDesired: {
        description: "Desired { id }.",
        execute: async ({ wave }) => {
          await Bun.sleep(6);
          return { items: desiredFor(String(wave)), wave, seq: nextOrd() };
        },
      },
      listCurrent: {
        description: "Already present subset.",
        execute: async ({ wave }) => {
          await Bun.sleep(6);
          return { items: currentFor(String(wave)), wave };
        },
      },
      createMissing: {
        description: "Create desired-minus-current.",
        execute: async ({ id }) => {
          await Bun.sleep(8);
          creates.set(String(id), (creates.get(String(id)) ?? 0) + 1);
          return { created: true, id };
        },
      },
      publishWave: {
        description: "Seal the delta.",
        execute: async ({ wave }) => {
          await Bun.sleep(8);
          publishes.set(String(wave), (publishes.get(String(wave)) ?? 0) + 1);
          return { published: true, wave };
        },
      },
    }),
    async *script(goal) {
      const wave = String(goal.wave);
      const desired = yield { tool: "listDesired", args: { wave } };
      const current = yield { tool: "listCurrent", args: { wave } };
      const want = ((desired.value as { items?: Array<{ id?: string }> })?.items ?? []) as Array<{ id?: string }>;
      const have = new Set(
        (((current.value as { items?: Array<{ id?: string }> })?.items ?? []) as Array<{ id?: string }>).map((x) =>
          String(x.id),
        ),
      );
      for (const it of want) {
        const id = String(it.id);
        if (have.has(id)) continue;
        yield { tool: "createMissing", args: { id, wave } };
      }
      yield { tool: "publishWave", args: { wave } };
    },
    done: (v) => Boolean((v as { published?: boolean })?.published),
    terminal: "publishWave",
    check(doneGoals) {
      const bad: string[] = [];
      const occ = occurrences(doneGoals, "wave");
      for (const [wave, n] of occ) {
        if ((publishes.get(wave) ?? 0) > n) bad.push(`delta:${wave}: publishWave duplicated`);
        for (const it of currentFor(wave)) {
          if ((creates.get(it.id) ?? 0) > 0) bad.push(`delta:${wave}: created current item ${it.id}`);
        }
      }
      return bad;
    },
  };
}

export const ACCOUNT_IDS = ["ac-north", "ac-east", "ac-south", "ac-west"] as const;
export function cardFor(account: string): { last4: string; token: string } {
  return { last4: "4242", token: `tok_${hashStr(account).toString(16)}` };
}

export function createDeepBill(): World {
  const charges = new Map<string, number>();
  const receipts = new Map<string, number>();
  return {
    name: "deep-bill",
    island: () => stubIsland(),
    tools: () => ({
      getAccount: {
        description: "org.billing.card.{ last4, token }.",
        execute: async ({ account }) => {
          await Bun.sleep(6);
          const id = String(account);
          return { org: { billing: { card: cardFor(id) } }, account: id, seq: nextOrd() };
        },
      },
      chargeCard: {
        description: "Authorize nested token.",
        execute: async ({ token }) => {
          await Bun.sleep(8);
          charges.set(String(token), (charges.get(String(token)) ?? 0) + 1);
          return { authorized: true, token };
        },
      },
      chargeCapture: {
        description: "Capture.",
        execute: async ({ token }) => {
          await Bun.sleep(8);
          return { captured: true, token };
        },
      },
      sendReceipt: {
        description: "Email receipt.",
        execute: async ({ account }) => {
          await Bun.sleep(8);
          receipts.set(String(account), (receipts.get(String(account)) ?? 0) + 1);
          return { emailed: true, account };
        },
      },
    }),
    async *script(goal) {
      const account = String(goal.account);
      const got = yield { tool: "getAccount", args: { account } };
      const token = String(
        (got.value as { org?: { billing?: { card?: { token?: string } } } })?.org?.billing?.card?.token ?? "",
      );
      yield { tool: "chargeCard", args: { token } };
      yield { tool: "chargeCapture", args: { token } };
      yield { tool: "sendReceipt", args: { account } };
    },
    done: (v) => Boolean((v as { emailed?: boolean })?.emailed),
    terminal: "sendReceipt",
    check(doneGoals) {
      const bad: string[] = [];
      const occ = occurrences(doneGoals, "account");
      for (const [account, n] of occ) {
        if ((receipts.get(account) ?? 0) > n) bad.push(`deep-bill:${account}: sendReceipt duplicated`);
        const token = cardFor(account).token;
        if ((charges.get(token) ?? 0) > n) bad.push(`deep-bill:${account}: chargeCard duplicated`);
      }
      return bad;
    },
  };
}

export const EXTRA_HORIZON_FACTORIES = [
  createK8sNested,
  createEmailDrip,
  createS3Restore,
  createSevTriage,
  createDelta,
  createDeepBill,
] as const;
