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

const nameKey = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
const NAME = /^\p{L}[\p{L}'’-]*(?: \p{L}[\p{L}'’-]*){1,3}$/u;
const EMAIL = /[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi;
const QUOTED = new RegExp(
  [
    String.raw`(?:^|\s)>|(?:^|\n)\s*[“"]|\bOn [^\n]{0,240}?wrote:`,
    String.raw`\b(?:Forwarded message|Original Message|Begin forwarded message:)`,
    String.raw`\bFrom:[ \t]+[^<\n]{0,100}<[^>\n]{1,120}>|<blockquote\b|<q[\s>]|\x60{3}`,
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
  const name = person.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const signature = new RegExp(
    String.raw`(?:^|\n|--\s+)[ \t]*` + name + String.raw`\s+[^|\n]{0,80}\|[ \t]*([^|\n]{1,100})(?=\n|$)`,
    "gi",
  );
  for (const sig of body.matchAll(signature)) {
    const tail = sig[1]!.split(/\s+(?:M:|Tel:|Phone:|Email:|CONFIDENTIALITY\b)/i)[0]!;
    const org = organisation(tail);
    if (!org) continue;
    const end = body.slice(sig.index! + sig[0].length, sig.index! + sig[0].length + 200);
    const emails = [...`${sig[0]}\n${end}`.matchAll(EMAIL)].map((m) => m[0].toLowerCase());
    const local = address.split("@")[0]!.replace(/[^\p{L}\p{N}]/gu, "");
    const parts = nameKey(person).split(" ");
    const fullLocal = `${parts[0]}${parts.at(-1)}`.replace(/[^\p{L}\p{N}]/gu, "");
    if (emails.length > 0 ? !emails.every((e) => e === address) : local !== fullLocal) continue;
    return { ...base, person, org, kind: "signature", address };
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
    const words =
      text
        .slice(0, 4_000)
        .toLowerCase()
        .match(/[\p{L}'’-]+/gu) ?? [];
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
