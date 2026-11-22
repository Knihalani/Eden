import { describe, expect, test } from "bun:test";
import type { ContextItem } from "@eden/protocol";
import { affiliationOf, AffiliationIndex, MAX_AFFILIATION_EVIDENCE } from "./affiliations";
import { ItemCache } from "./cache";
import type { FrozenDisk, PersistedUser } from "./persist";

const scope = { tenantId: "tenant", userId: "user" };
const NOW = Date.parse("2026-10-27T09:00:00Z");
const item = (text: string, id = "mail:proof"): ContextItem => ({
  id,
  sourceId: id.split(":")[0]!,
  ref: id.split(":")[1]!,
  title: "Contact record",
  text,
});
const contact = (org = "Umbrella Health", person = "Ahmed Hassan", id = "crm:contact") =>
  item(`Contact: ${person}\nTitle: CFO\nCompany: ${org}\nEmail: ahmed.hassan@umbrellahealth.com`, id);
const mail = (body: string, sender = "Ahmed Hassan <ahmed.hassan@umbrellahealth.com>") =>
  item(`From: ${sender}\nTo: Robin Carter <robin@northwind.co>\n\n${body}`);
const signature = "--\nAhmed Hassan\nCFO | Umbrella Health";

describe("one-hop affiliations", () => {
  test("explicit contact fields and the sender's own signature retain provenance, not roles", () => {
    expect(affiliationOf(contact())).toEqual({
      person: "Ahmed Hassan",
      org: "Umbrella Health",
      itemId: "crm:contact",
      sourceId: "crm",
      ref: "contact",
      kind: "contact",
    });
    expect(affiliationOf(mail(`Hello\n${signature}`))).toMatchObject({
      person: "Ahmed Hassan",
      org: "Umbrella Health",
      kind: "signature",
      address: "ahmed.hassan@umbrellahealth.com",
    });
    expect(affiliationOf(mail("-- Ahmed Hassan CFO | Umbrella Health"))).not.toBeNull();
    expect(affiliationOf(mail("Ahmed Hassan CFO | Umbrella Health"))).not.toBeNull();
    const index = new AffiliationIndex();
    index.put(contact());
    expect(index.forParty("CFO", () => true)).toEqual([]);
    expect(index.forParty("Umbrella Health", () => true)).toEqual([]);
  });

  test("other senders, mismatched addresses, quoted and forwarded signatures create no edge", () => {
    for (const body of [
      `Hello\n> ${signature.replaceAll("\n", "\n> ")}`,
      "Hello > -- Ahmed Hassan CFO | Umbrella Health",
      `Hello\nOn Tuesday, Ahmed wrote:\n${signature}`,
      `Hello On Tuesday, Ahmed wrote: -- Ahmed Hassan CFO | Umbrella Health`,
      `Hello\n---------- Forwarded message ---------\n${signature}`,
      `Hello\nBegin forwarded message:\n${signature}`,
      `Hello\n-----Original Message-----\n${signature}`,
      `Hello\nFrom: Ahmed Hassan <ahmed.hassan@umbrellahealth.com>\n${signature}`,
      "Hello From: Ahmed Hassan <ahmed.hassan@umbrellahealth.com> -- Ahmed Hassan CFO | Umbrella Health",
      `Hello\n<blockquote>\n${signature}\n</blockquote>`,
      `Hello\n\`\`\`\n${signature}\n\`\`\``,
      `Hallo\nVon: Ahmed Hassan <ahmed.hassan@umbrellahealth.com>\nGesendet: Dienstag\n${signature}`,
      `Hallo\nAm Dienstag schrieb Ahmed Hassan:\n${signature}`,
      `Hallo\n-----Ursprüngliche Nachricht-----\n${signature}`,
      `Hallo\n________________\n${signature}`,
      `Bonjour\nDe: Ahmed Hassan\nEnvoyé: mardi\n${signature}`,
      `Bonjour\nLe mardi, Ahmed Hassan a écrit :\n${signature}`,
      `Bonjour\n-----Message d'origine-----\n${signature}`,
      `Hola\nDe: Ahmed Hassan\nEnviado: martes\n${signature}`,
      `Hola\nEl martes, Ahmed Hassan escribió:\n${signature}`,
      `Hola\n-----Mensaje original-----\n${signature}`,
    ])
      expect(affiliationOf(mail(body))).toBeNull();
    expect(affiliationOf(mail(signature, "Alice Smith <alice.smith@other.com>"))).toBeNull();
    expect(affiliationOf(mail(signature, "Ahmed Hassan <alice.smith@other.com>"))).toBeNull();
    expect(affiliationOf(mail(`${signature}\nEmail: another@other.com`))).toBeNull();
    expect(affiliationOf(item("Company: Umbrella Health"))).toBeNull();
    expect(affiliationOf(item("Contact: Ahmed Hassan\nCompany: A\nCompany: B"))).toBeNull();
    expect(affiliationOf(item(""))).toBeNull();
  });

  test("two organisations per party and bounded evidence per user; replacing evidence revokes the old edge", () => {
    const index = new AffiliationIndex();
    for (const [i, org] of ["Umbrella Health", "Globex", "Hooli"].entries())
      index.put(contact(org, undefined, `crm:${i}`));
    expect(index.forParty("Ahmed Hassan", () => true).map((e) => e.org)).toEqual(["Umbrella Health", "Globex"]);
    index.remove("crm:0");
    index.put(contact("Hooli", undefined, "crm:2"));
    expect(index.forParty("Ahmed Hassan", () => true).map((e) => e.org)).toEqual(["Globex", "Hooli"]);
    index.put(item("No contact fields anymore", "crm:1"));
    expect(index.forParty("Ahmed Hassan", () => true).map((e) => e.org)).toEqual(["Hooli"]);
    for (let i = 0; i < MAX_AFFILIATION_EVIDENCE + 20; i++) index.put(contact("Globex", "Alice Smith", `crm:bulk${i}`));
    expect(index.size).toBe(MAX_AFFILIATION_EVIDENCE);
    expect(index.forParty("Alice Smith", () => false)).toEqual([]);
  });

  test("cache scopes isolate tenants and users; expiry, replacement and source revocation remove affiliations", () => {
    const cache = new ItemCache({ ttlMs: 1_000 });
    cache.close();
    cache.enablePartyOrgs();
    cache.put(scope, [contact()], NOW);
    expect(cache.partyOrgs(scope, "Ahmed Hassan", NOW)).toHaveLength(1);
    expect(cache.partyOrgs({ ...scope, tenantId: "other" }, "Ahmed Hassan", NOW)).toEqual([]);
    expect(cache.partyOrgs({ ...scope, userId: "other" }, "Ahmed Hassan", NOW)).toEqual([]);
    cache.put({ ...scope, userId: "other" }, [contact("Hooli")], NOW);
    expect(cache.partyOrgs(scope, "Ahmed Hassan", NOW)[0]!.org).toBe("Umbrella Health");
    expect(cache.partyOrgs(scope, "Ahmed Hassan", NOW + 1_001)).toEqual([]);
    cache.put(scope, [contact("Globex")], NOW + 1_002);
    expect(cache.partyOrgs(scope, "Ahmed Hassan", NOW + 1_002)[0]!.org).toBe("Globex");
    cache.forget(scope, "crm");
    expect(cache.partyOrgs(scope, "Ahmed Hassan", NOW + 1_002)).toEqual([]);
  });

  test("opt-in indexes items already held and rebuilds through freeze/thaw", () => {
    const cache = new ItemCache({ freezeIdleMs: 1, expireEveryMs: 1 });
    cache.close();
    cache.put(scope, [contact()], NOW);
    expect(cache.partyOrgs(scope, "Ahmed Hassan", NOW)).toEqual([]);
    cache.enablePartyOrgs();
    const before = cache.partyOrgs(scope, "Ahmed Hassan", NOW);
    expect(before).toHaveLength(1);
    cache.expireIdle(NOW + 2);
    cache.expireIdle(NOW + 2);
    expect(cache.frozenCount).toBe(1);
    expect(cache.partyOrgs(scope, "Ahmed Hassan", NOW + 2)).toEqual(before);
    cache.forget(scope);
    expect(cache.partyOrgs(scope, "Ahmed Hassan", NOW + 2)).toEqual([]);
  });

  test("capped admissions use entry sequence, not LRU order, at enable and cold/warm/drain thaw", () => {
    const records = Array.from({ length: MAX_AFFILIATION_EVIDENCE }, (_, i) =>
      contact("Globex", "Alice Smith", `crm:bulk${i}`),
    );
    for (const form of ["cold", "warm", "drain"]) {
      for (const enableBefore of [false, true]) {
        const limits = {
          freezeIdleMs: form === "warm" ? 1_000 : 1,
          warmIdleMs: form === "warm" ? 1 : 0,
          expireEveryMs: 1,
          maxItemsPerUser: MAX_AFFILIATION_EVIDENCE + 10,
        };
        const cache = new ItemCache(limits);
        cache.close();
        if (enableBefore) cache.enablePartyOrgs();
        cache.put(scope, [...records, contact()], NOW);
        cache.put(scope, [cache.get(scope, records[0]!.id, NOW)!], NOW, true);
        if (!enableBefore) cache.enablePartyOrgs();
        const before = cache.partyOrgs(scope, "Alice Smith", NOW);
        expect(before[0]!.itemId).toBe(records[0]!.id);
        expect(cache.partyOrgs(scope, "Ahmed Hassan", NOW)).toEqual([]);
        if (form === "drain") {
          let saved: PersistedUser | null = null;
          const disk: FrozenDisk = {
            has: () => saved !== null,
            read: () => saved,
            write: (_scope, user) => {
              saved = user;
              return true;
            },
            delete: () => {
              saved = null;
            },
            sweep: () => 0,
          };
          cache.persist(disk);
          expect(cache.flush()).toBe(1);
          const restored = new ItemCache(limits);
          restored.close();
          restored.enablePartyOrgs();
          restored.persist(disk);
          expect(restored.partyOrgs(scope, "Alice Smith", NOW + 2)).toEqual(before);
          expect(restored.partyOrgs(scope, "Ahmed Hassan", NOW + 2)).toEqual([]);
          continue;
        }
        cache.expireIdle(NOW + 2);
        cache.expireIdle(NOW + 2);
        expect(cache.frozenCount).toBe(1);
        expect(cache.warmCount).toBe(form === "warm" ? 1 : 0);
        expect(cache.partyOrgs(scope, "Alice Smith", NOW + 2)).toEqual(before);
        expect(cache.partyOrgs(scope, "Ahmed Hassan", NOW + 2)).toEqual([]);
      }
    }
  });
});
