/**
 * Third horizon tranche: domains still unused by moonshot, holdout, horizon,
 * or extra — TLS host renew, CDN path purge, LDAP email fanout.
 *
 * Bind fields already compiled (host, path, email). Not a retune of github
 * path/sha, inventory sku, CRM email drip timezone, or k8s ns/name.
 */
import type { IslandCaller } from "@eden/ir";
import { hashStr, type World } from "./worlds";

let moreOrd = 0;
function nextOrd(): number {
  return ++moreOrd;
}

function occurrences(goals: Array<Record<string, unknown>>, key: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const g of goals) m.set(String(g[key]), (m.get(String(g[key])) ?? 0) + 1);
  return m;
}

function stubIsland(): IslandCaller {
  return async () => ({ ok: false });
}

export const SITE_IDS = ["site-iad", "site-lhr", "site-nrt", "site-syd"] as const;
export function certsFor(site: string): Array<{ host: string; days: number }> {
  return [`api.${site}.eden.test`, `cdn.${site}.eden.test`, `mail.${site}.eden.test`].map((host, i) => ({
    host,
    days: 12 + i,
  }));
}

export function createCertRenew(): World {
  const renews = new Map<string, number>();
  const stamps = new Map<string, number>();
  return {
    name: "cert-renew",
    island: () => stubIsland(),
    tools: () => ({
      listExpiring: {
        description: "Certs about to expire as { host, days }.",
        execute: async ({ site }) => {
          await Bun.sleep(6);
          return { certs: certsFor(String(site)), site, seq: nextOrd() };
        },
      },
      renewCert: {
        description: "Issue a replacement cert for one host.",
        execute: async ({ host }) => {
          await Bun.sleep(8);
          const h = String(host);
          renews.set(h, (renews.get(h) ?? 0) + 1);
          return { renewed: true, host: h };
        },
      },
      stampBundle: {
        description: "Publish the site's new bundle.",
        execute: async ({ site }) => {
          await Bun.sleep(8);
          const id = String(site);
          stamps.set(id, (stamps.get(id) ?? 0) + 1);
          return { stamped: true, site: id };
        },
      },
    }),
    async *script(goal) {
      const site = String(goal.site);
      const listed = yield { tool: "listExpiring", args: { site } };
      const certs = ((listed.value as { certs?: Array<{ host?: string }> })?.certs ?? []) as Array<{ host?: string }>;
      for (const row of certs) yield { tool: "renewCert", args: { host: row.host } };
      yield { tool: "stampBundle", args: { site } };
    },
    done: (v) => Boolean((v as { stamped?: boolean })?.stamped),
    terminal: "stampBundle",
    check(doneGoals) {
      const bad: string[] = [];
      const occ = occurrences(doneGoals, "site");
      for (const [site, n] of occ) {
        if ((stamps.get(site) ?? 0) > n) bad.push(`cert-renew:${site}: stampBundle duplicated`);
        for (const c of certsFor(site)) {
          if ((renews.get(c.host) ?? 0) > n) bad.push(`cert-renew:${site}: renewCert ${c.host} duplicated`);
        }
      }
      return bad;
    },
  };
}

export const ZONE_IDS = ["zn-alpha", "zn-bravo", "zn-charlie", "zn-delta"] as const;
export function routesFor(zone: string): Array<{ path: string }> {
  return [`/${zone}/index.html`, `/${zone}/assets/app.js`, `/${zone}/assets/app.css`].map((path) => ({ path }));
}

export function createCdnPurge(): World {
  const purges = new Map<string, number>();
  const flushes = new Map<string, number>();
  return {
    name: "cdn-purge",
    island: () => stubIsland(),
    tools: () => ({
      listRoutes: {
        description: "Cached routes as { path }.",
        execute: async ({ zone }) => {
          await Bun.sleep(6);
          return { routes: routesFor(String(zone)), zone, seq: nextOrd() };
        },
      },
      purgePath: {
        description: "Drop one path from the edge cache.",
        execute: async ({ path }) => {
          await Bun.sleep(8);
          const p = String(path);
          purges.set(p, (purges.get(p) ?? 0) + 1);
          return { purged: true, path: p };
        },
      },
      flushEdge: {
        description: "Flush the zone's remaining edge.",
        execute: async ({ zone }) => {
          await Bun.sleep(8);
          const id = String(zone);
          flushes.set(id, (flushes.get(id) ?? 0) + 1);
          return { flushed: true, zone: id };
        },
      },
    }),
    async *script(goal) {
      const zone = String(goal.zone);
      const listed = yield { tool: "listRoutes", args: { zone } };
      const routes = ((listed.value as { routes?: Array<{ path?: string }> })?.routes ?? []) as Array<{ path?: string }>;
      for (const row of routes) yield { tool: "purgePath", args: { path: row.path } };
      yield { tool: "flushEdge", args: { zone } };
    },
    done: (v) => Boolean((v as { flushed?: boolean })?.flushed),
    terminal: "flushEdge",
    check(doneGoals) {
      const bad: string[] = [];
      const occ = occurrences(doneGoals, "zone");
      for (const [zone, n] of occ) {
        if ((flushes.get(zone) ?? 0) > n) bad.push(`cdn-purge:${zone}: flushEdge duplicated`);
        for (const r of routesFor(zone)) {
          if ((purges.get(r.path) ?? 0) > n) bad.push(`cdn-purge:${zone}: purgePath ${r.path} duplicated`);
        }
      }
      return bad;
    },
  };
}

export const GROUP_DNS = ["cn=eng,dc=eden", "cn=sales,dc=eden", "cn=ops,dc=eden", "cn=legal,dc=eden"] as const;
export function membersFor(dn: string): Array<{ id: string; email: string }> {
  const cn = dn.split(",")[0]!.slice(3);
  return Array.from({ length: 3 }, (_, i) => ({
    id: `${cn}-${i}`,
    email: `${cn}.${i}@ldap.eden.test`,
  }));
}

export function createLdapMail(): World {
  const mails = new Map<string, number>();
  const closes = new Map<string, number>();
  return {
    name: "ldap-mail",
    island: () => stubIsland(),
    tools: () => ({
      listMembers: {
        description: "Directory members as { id, email }.",
        execute: async ({ dn }) => {
          await Bun.sleep(6);
          return { members: membersFor(String(dn)), dn, seq: nextOrd(), fingerprint: hashStr(String(dn)) };
        },
      },
      mailMember: {
        description: "Send the group notice to one email.",
        execute: async ({ email }) => {
          await Bun.sleep(8);
          const e = String(email);
          mails.set(e, (mails.get(e) ?? 0) + 1);
          return { mailed: true, email: e };
        },
      },
      closeGroup: {
        description: "Close the directory ticket.",
        execute: async ({ dn }) => {
          await Bun.sleep(8);
          const id = String(dn);
          closes.set(id, (closes.get(id) ?? 0) + 1);
          return { closed: true, dn: id };
        },
      },
    }),
    async *script(goal) {
      const dn = String(goal.dn);
      const listed = yield { tool: "listMembers", args: { dn } };
      const members = ((listed.value as { members?: Array<{ email?: string }> })?.members ?? []) as Array<{
        email?: string;
      }>;
      for (const row of members) yield { tool: "mailMember", args: { email: row.email } };
      yield { tool: "closeGroup", args: { dn } };
    },
    done: (v) => Boolean((v as { closed?: boolean })?.closed),
    terminal: "closeGroup",
    check(doneGoals) {
      const bad: string[] = [];
      const occ = occurrences(doneGoals, "dn");
      for (const [dn, n] of occ) {
        if ((closes.get(dn) ?? 0) > n) bad.push(`ldap-mail:${dn}: closeGroup duplicated`);
        for (const m of membersFor(dn)) {
          if ((mails.get(m.email) ?? 0) > n) bad.push(`ldap-mail:${dn}: mailMember ${m.email} duplicated`);
        }
      }
      return bad;
    },
  };
}

export const MORE_HORIZON_FACTORIES = [createCertRenew, createCdnPurge, createLdapMail] as const;
