/**
 * Noise connectors (A1 scale audit, D262–D264): a user with hundreds of connected sources that have nothing to do with
 * what they are asking about (ticket trackers, wikis, dashboards, chat channels, design files…), for the funnel's
 * `--noise-sources N`. Each is a real `SimSource` over its own `SimIndex`, so it lists (it is synced), searches with a
 * realistic profile's semantics, latency, errors and rate limit, and counts its calls like the world's own sources.
 *
 * Items use a work vocabulary of their own, and about 3% of them mention one of the world's people (a teammate on a
 * ticket, a name in a channel): the look-alikes a wide connector set brings. Deterministic per world seed and index.
 * Simulated data only.
 */
import { REALISTIC, SimIndex, SimSource } from "../sources";
import { Rng } from "../rng";
import type { World, WorldItem } from "../world";

const KINDS = ["jira", "wiki", "slack-channel", "dashboard", "drive-folder", "github", "zendesk", "figma", "sheets"];
const WORDS = (
  "sprint backlog deploy metric dashboard widget pipeline schema endpoint latency cluster shard label channel " +
  "standup retro epic story bug triage design mockup component release branch merge build artifact queue alert " +
  "migration rollout flag experiment cohort funnel retention churn quota region replica index cache token webhook"
).split(" ");
/** The profiles noise connectors take in turn: chat-like ("and"), document-like ("ranked") and record-like. */
const PROFILES = ["slack", "drive", "gmail"] as const;
const DAY = 86_400_000;

/** `n` noise connectors of `items` items each for a world, seeded by the world and `seed`. */
export function noiseSources(world: World, n: number, items: number, timeScale: number, seed: number): SimSource[] {
  const r = new Rng(world.seed * 7_919 + 104_729);
  const out: SimSource[] = [];
  for (let k = 0; k < n; k++) {
    const kind = KINDS[k % KINDS.length]!;
    const id = `${kind}-${k}`;
    const rows: WorldItem[] = Array.from({ length: items }, (_, i) => {
      const words = Array.from({ length: r.int(25, 140) }, () =>
        r.chance(0.5) ? r.pick(WORDS) : `${r.pick(WORDS)}-${r.int(1, 400)}`,
      );
      if (r.chance(0.03)) words.splice(r.int(0, words.length), 0, r.pick(world.people).full);
      return {
        id: `${id}:${i}`,
        sourceId: id,
        ref: `${id}/${i}`,
        title: `${kind} ${r.pick(WORDS)} ${r.pick(WORDS)}-${r.int(1, 999)}`,
        text: words.join(" ") + ".",
        updatedAt: world.now - Math.floor(r.next() ** 2 * 90 * DAY),
        kind: "doc",
        facts: [],
        noise: true,
      };
    });
    const sub: World = { ...world, items: rows, sources: { [id]: `A ${kind} the user is connected to` } };
    const profile = REALISTIC[PROFILES[k % PROFILES.length]!]!;
    out.push(new SimSource(new SimIndex(id, sub), profile, timeScale, seed * 7_919 + k));
  }
  return out;
}
