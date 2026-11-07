/**
 * A6 (docs/research/a6-moonshots.md, D287; lab only): "dressed" worlds. A request often names a person or firm that no
 * item of its generated world names ("Pay Ethan Brooks's first invoice"): on train, 77% of nothing-to-add requests and
 * 55% of hidden ones do, so both arms spend turns hunting for records a real user would have. Dressing adds, for each
 * such name, one ordinary message from it: a person's catch-up note with a direct line, a firm's account notice with
 * a reference. Neither says anything that could bear on a request (no constraint wording, no date the request names,
 * no amount), so a hidden task stays hidden and a control or neutral one stays clean; what changes is that the
 * agent's first lookups can succeed. Deterministic per seed. Only `worldOf(…, { dress: true })` calls it.
 */
import { extractTypedEntities } from "@eden/engine";
import type { World, WorldItem } from "../world";

/** The name a request means: a leading imperative verb and a possessive taken off ("Send Priya Raman", "Ethan's"). */
export function requestNames(text: string): string[] {
  const out: string[] = [];
  for (const e of extractTypedEntities(text)) {
    if (e.kind === "url" || e.kind === "email") continue;
    let words = e.text.replace(/['’]s$/, "").split(/\s+/);
    if (words.length > 1 && text.trimStart().startsWith(words[0]!)) words = words.slice(1);
    const name = words.join(" ");
    if (name.length > 2 && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Words that make a name a firm, a place or a thing rather than a person. */
const NOT_PERSON =
  /\b(ltd|inc|llc|plc|group|bank|health|industries|insights|foods|garage|supply|marine|labs?|systems|studio|school|nursery|clinic|hotel|airways?|rail|council|hmrc|isa|account|team|project|conference|club|gym|cafe|restaurant)\b/i;

/** A person: two or three capitalised words, letters only, none a firm word. */
const isPerson = (name: string) => /^\p{Lu}[\p{L}'-]+(?: \p{Lu}[\p{L}'-]+){1,2}$/u.test(name) && !NOT_PERSON.test(name);

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
      const person = isPerson(name);
      const email = person ? `${slug(name)}@mail.example` : `accounts@${slug(name).replace(/\./g, "")}.example`;
      const title = person ? "Good to catch up" : `${name}: your account`;
      const body = person
        ? `Hi ${first}, good to speak last week. My direct line is 07700 900${digits} if that is easier than ` +
          `email. Speak soon, ${name.split(" ")[0]}`
        : `Hello ${first}, thanks for being in touch with ${name}. Your customer reference is ` +
          `REF-${digits}${n}. You can see your details online at any time.`;
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
