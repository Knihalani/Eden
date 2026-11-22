import type { ContextItem } from "@eden/protocol";

export const MAX_AFFILIATION_EVIDENCE = 512;
export const MAX_PARTY_ORGS = 2;

export interface Affiliation {
  person: string;
  org: string;
  itemId: string;
  sourceId: string;
  ref: string;
  kind: "contact" | "signature";
  address?: string;
}

const NAME_FOLDS: Record<string, string> = {
  ß: "ss",
  ø: "o",
  ł: "l",
  đ: "d",
  ð: "d",
  þ: "th",
  æ: "ae",
  œ: "oe",
  ı: "i",
};
const nameKey = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[ßøłđðþæœı]/g, (c) => NAME_FOLDS[c]!)
    .trim()
    .replace(/\s+/g, " ");
const NAME = /^\p{L}[\p{L}\p{M}'’-]*(?: \p{L}[\p{L}\p{M}'’-]*){1,3}$/u;
const EMAIL = /[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi;
const FOOTER =
  /\s+(?:M:|Tel:|Phone:|Email:)|(?<![\p{L}\p{N}])\+?\d(?:[ \t().-]*\d){6,}|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)|\s+\|\s+|\b(?:confidential(?:ity)?|this\s+email|sent\s+from)\b/iu;
const QUOTED = new RegExp(
  [
    String.raw`(?:^|\s)>|(?:^|\n)\s*[“"]|\bOn [^\n]{0,240}?wrote:`,
    String.raw`\b(?:Forwarded message|Original Message|Begin forwarded message:)`,
    String.raw`\bFrom:[ \t]+[^<\n]{0,100}<[^>\n]{1,120}>|<blockquote\b|<q[\s>]|\x60{3}`,
    String.raw`(?:^|\n)[ \t]*(?:Von|Gesendet|De|Envoyé|Envoye|Enviado):|(?:^|\n)[ \t]*_{5,}[ \t]*(?:\r?$)`,
    String.raw`\bAm [^\n]{0,240}?schrieb[^\n]{0,120}?:|\bLe [^\n]{0,240}?a écrit[ \t]*:|\bEl [^\n]{0,240}?escribi[oó][ \t]*:`,
    String.raw`(?:Ursprüngliche Nachricht|Ursprungliche Nachricht|Message d['’]origine|Message transféré|Mensaje original|Mensaje reenviado)`,
  ].join("|"),
  "im",
);

function ownBody(text: string): string {
  const at = text.search(QUOTED);
  return at < 0 ? text : text.slice(0, at);
}

function organisation(s: string): string | null {
  const org = s.trim().replace(/\s+/g, " ");
  return org.length >= 2 && org.length <= 100 && /^[\p{L}\p{N}][\p{L}\p{N} &'’().,-]*$/u.test(org) ? org : null;
}

/** An explicit contact record, or the sender's own delimited signature; never quoted history. */
export function affiliationOf(item: ContextItem): Affiliation | null {
  const text = item.text.slice(0, 16_000);
  const base = { itemId: item.id, sourceId: item.sourceId, ref: item.ref };
  const split = text.search(/\r?\n\s*\r?\n/);
  const header = split < 0 ? text : text.slice(0, split);
  const from = [...header.matchAll(/^From:\s*"?([^<>\n]+?)"?\s*<([^<>\s]+@[^<>\s]+)>\s*$/gim)];
  if (from.length === 0) {
    if (/^From:/im.test(text)) return null;
    const record = ownBody(text);
    const fields = (label: string) => [...record.matchAll(new RegExp(`^${label}:[ \\t]*([^\\r\\n]+)$`, "gim"))];
    const contacts = fields("Contact");
    const companies = fields("Company");
    if (contacts.length !== 1 || companies.length !== 1) return null;
    const person = contacts[0]![1]!.trim();
    const org = organisation(companies[0]![1]!);
    return NAME.test(person) && org ? { ...base, person, org, kind: "contact" } : null;
  }
  if (from.length !== 1 || split < 0) return null;
  const person = from[0]![1]!.replace(/^"|"$/g, "").trim();
  if (!NAME.test(person)) return null;
  const address = from[0]![2]!.toLowerCase();
  const body = ownBody(text.slice(split).trimStart());
  const local = nameKey(address.split("@")[0]!).replace(/[^\p{L}\p{N}]/gu, "");
  const signature = /([^|\n]{1,200}(?:(?:\r?\n[ \t]*){1,3}[^|\n]{0,80})?)\|[ \t]*([^\n]*)/uy;
  for (const at of body.matchAll(/(?:--\s+|^|\n)[ \t]*/g)) {
    signature.lastIndex = at.index! + at[0].length;
    const sig = signature.exec(body);
    if (!sig) continue;
    const tail = sig[2]!.split(FOOTER)[0]!;
    const org = organisation(tail);
    if (!org) continue;
    const end = sig.index + sig[0].length - sig[2]!.length + tail.length;
    const emails = [...body.slice(sig.index, end + 200).matchAll(EMAIL)].map((m) => m[0].toLowerCase());
    if (emails.some((email) => email !== address)) continue;
    const head = sig[1]!.trim();
    const line = head.split(/\r?\n/)[0]!;
    const words = [...line.matchAll(/\p{L}[\p{L}\p{M}'’-]*/gu)];
    for (let n = 2; n <= Math.min(4, words.length); n++) {
      const name = line.slice(0, words[n - 1]!.index! + words[n - 1]![0].length).replace(/\s+/g, " ");
      if (!NAME.test(name) || (head.includes("\n") && nameKey(name) !== nameKey(line))) continue;
      const parts = nameKey(name).split(" ");
      const displayMatch = nameKey(name) === nameKey(person);
      const localMatch = `${parts[0]}${parts.at(-1)}`.replace(/[^\p{L}\p{N}]/gu, "") === local;
      if (!displayMatch && !localMatch) continue;
      return { ...base, person: displayMatch ? person : name, org, kind: "signature", address };
    }
  }
  return null;
}

/** Bounded evidence, owned by one tenant/user cache; removed with the item that supports it. */
export class AffiliationIndex {
  private readonly evidence = new Map<string, Affiliation>();
  private readonly people = new Map<string, Map<string, Set<string>>>();

  get size(): number {
    return this.evidence.size;
  }

  namedIn(text: string): string[] {
    const words = nameKey(text.slice(0, 4_000)).match(/[\p{L}'’-]+/gu) ?? [];
    const names = new Set<string>();
    for (let i = 0; i < words.length; i++) {
      for (let n = 2; n <= 4 && i + n <= words.length; n++) {
        const name = words.slice(i, i + n).join(" ");
        if (this.people.has(name)) names.add(name);
      }
    }
    return [...names];
  }

  put(item: ContextItem): void {
    this.remove(item.id);
    if (this.evidence.size >= MAX_AFFILIATION_EVIDENCE) return;
    const edge = affiliationOf(item);
    if (!edge) return;
    const key = nameKey(edge.person);
    const org = nameKey(edge.org);
    let orgs = this.people.get(key);
    if (orgs && !orgs.has(org) && orgs.size >= MAX_PARTY_ORGS) return;
    if (!orgs) this.people.set(key, (orgs = new Map()));
    let ids = orgs.get(org);
    if (!ids) orgs.set(org, (ids = new Set()));
    ids.add(item.id);
    this.evidence.set(item.id, edge);
  }

  remove(id: string): void {
    const edge = this.evidence.get(id);
    if (!edge) return;
    this.evidence.delete(id);
    const key = nameKey(edge.person);
    const orgs = this.people.get(key)!;
    const org = nameKey(edge.org);
    const ids = orgs.get(org)!;
    ids.delete(id);
    if (ids.size === 0) orgs.delete(org);
    if (orgs.size === 0) this.people.delete(key);
  }

  forParty(person: string, alive: (id: string) => boolean): Affiliation[] {
    const out: Affiliation[] = [];
    for (const ids of this.people.get(nameKey(person))?.values() ?? []) {
      for (const id of ids) {
        if (!alive(id)) continue;
        out.push({ ...this.evidence.get(id)! });
        break;
      }
    }
    return out;
  }
}
