/**
 * A6 (docs/research/a6-moonshots.md, D287; lab only): "dressed" worlds. A request often names a person or firm that no
 * item of its generated world names ("Pay Ethan Brooks's first invoice"), so the agent's first lookups cannot
 * succeed. Dressing adds, for each person or firm so named, one ordinary message from it with a phone number and an
 * address. It says nothing that could bear on a request (no constraint wording, no date the request names, no
 * amount), so a hidden task stays hidden and a control or neutral one stays clean. Measured: neither arm's cost, time
 * or lookups change significantly (§4). Deterministic per seed. Only `worldOf(…, { dress: true })` calls it.
 */
import { extractTypedEntities } from "@eden/engine";
import type { World, WorldItem } from "../world";

/**
 * The people and firms a request names, as dressing reads them. The first version dressed every capitalised run and
 * id, so invoice ids, acronyms, places, holidays and products got messages too (the review of D287). Now only the
 * extractor's `name` entities, with a leading imperative verb and a possessive taken off, and of those only: two or
 * more capitalised words ending in a firm word ("Vandelay Industries", "Kwik Lane Garage"); one word with a capital
 * inside it ("FreshCart"); two capitalised words of letters ("Priya Raman", "Calder Mutual") that are not a place,
 * season, event or product word. Anything else (one plain word, an acronym, an id, a place or holiday the word list
 * knows, a product) is left undressed. Telling a person from a firm by its name failed on the suites' invented firms
 * ("Calder Mutual", "Skyline Broadband"), so one message template serves both.
 */
export function requestNames(text: string): string[] {
  const out: string[] = [];
  for (const e of extractTypedEntities(text)) {
    if (e.kind !== "name") continue;
    let words = e.text.replace(/['’]s$/, "").split(/\s+/);
    if (words.length > 1 && text.trimStart().startsWith(words[0]!)) words = words.slice(1);
    const name = words.join(" ");
    if (out.includes(name)) continue;
    const capitalised = words.every((w) => /^\p{Lu}[\p{L}&-]*$/u.test(w));
    if (
      (words.length >= 2 && capitalised && FIRM.test(name)) ||
      (words.length === 1 && /^\p{Lu}\p{Ll}+\p{Lu}\p{Ll}+$/u.test(name)) ||
      (words.length === 2 && words.every((w) => /^\p{Lu}\p{Ll}+$/u.test(w)) && !NOT_NAMED.test(name))
    ) {
      out.push(name);
    }
  }
  return out;
}

/** The last word of a firm's name. */
const FIRM =
  /\b(ltd|inc|llc|plc|group|bank|health|industries|insights|foods|garage|supply|supplies|marine|labs?|systems|logistics|print|studio|partners|consulting|solutions|holdings|services|clinic|surgery|dental|motors|electrical|plumbing|builders|insurance|energy|media|software|technologies|capital|ventures|associates|agency)$/i;

/** Words that make a two-word name a place, a season, an event or a product: not someone to hear from. */
const NOT_NAMED =
  /\b(valley|cross|street|road|lane|park|square|station|airport|bridge|hill|green|common|heath|night|day|eve|week|weekend|christmas|easter|pro|max|mini|air|plus|cup|festival|conference|summit|fair|marathon|north|south|east|west|city|town|county|island|bay|beach|centre|center|hall|house|tower|court|place|gardens?|school|nursery|college|university|hotel|club|gym|team|project|street|account|review|report|plan|policy|new|meads|exchange|bonds)\b/i;

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.|\.$/g, "");

/**
 * The world's items for every name `texts` (the requests) use that no item of `base` (the world before planting)
 * names, appended to `world.items`. Returns the names dressed. A name some base item names is left alone.
 */
export function dressEntities(
  world: World,
  base: readonly WorldItem[],
  texts: readonly string[],
  seed: number,
): string[] {
  const known = base.map((i) => `${i.title}\n${i.text}`.toLowerCase());
  const user = world.user;
  const first = user.full.split(" ")[0]!;
  const dressed: string[] = [];
  let n = 0;
  for (const text of texts) {
    for (const name of requestNames(text)) {
      const low = name.toLowerCase();
      if (dressed.includes(name) || known.some((k) => k.includes(low))) continue;
      dressed.push(name);
      n++;
      // 10–40 days before now, by the seed and the name's place: an old enough message to be background.
      const days = 10 + ((seed * 7 + n * 13) % 31);
      const at = world.now - days * 86_400_000;
      const date = new Date(at).toUTCString().replace(":00 GMT", "");
      const digits = String(100 + ((seed * 31 + n * 97) % 900));
      const id = `dress-${n}`;
      const email = `hello@${slug(name).replace(/\./g, "")}.example`;
      const title = "Thanks for your message";
      const body =
        `Hello ${first}, thanks for your message. You can reach ${name} on 020 7946 0${digits} or at this ` +
        `address. Kind regards, ${name}`;
      world.items.push({
        id: `gmail:${id}`,
        sourceId: "gmail",
        ref: id,
        title,
        text: `From: ${name} <${email}>\nTo: ${user.full} <${user.email}>\nDate: ${date}\n\n${body}`,
        updatedAt: at,
        kind: "mail",
        facts: [],
        noise: true,
        meta: { people: `${name} <${email}>; ${user.full} <${user.email}>` },
      });
    }
  }
  return dressed;
}
