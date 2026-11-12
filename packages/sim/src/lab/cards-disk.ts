/**
 * Implication cards from a disk cache (lab only; docs/research/moon-cards.md): each card the model made for a
 * simulated item is kept under the item's content hash (`cardKey`), so funnel and simulation reruns replay them at no
 * cost. The worlds are generated, so nothing here is user data; the engine itself never writes a card to disk (D8).
 *
 * `DiskCardMaker` answers a batch from the cache; an item it holds no card for is uncovered (null), as an item the
 * enrichment never reached would be, unless a live maker is given, whose answers are then appended to the cache, or
 * to `out` when one is given. A run that replays a committed file passes `out`: the replay file is then only ever
 * read, so a run cannot change its own input halfway (the oneturn track's replay file was mutated during a run), and
 * the next run that names both files replays both.
 */
import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  cardKey,
  ItemCache,
  worthCarding,
  type Card,
  type CardBatch,
  type CardMakeOptions,
  type CardMaker,
} from "@eden/engine";
import type { ContextItem } from "@eden/protocol";
import { INTENT_INERT } from "./reader-stub";
import { parseSuites } from "./suites";

/**
 * One line of `cards.jsonl`: an item's hash, its card (null: the model said none) and, when the call that made it
 * also asked for them, the requests it would change (`r`, D87). A line with `r` and no `c` is a live call's requests
 * for an item it gave no card: replayed as requests only, the card still uncovered.
 */
interface Line {
  h: string;
  c?: Card | null;
  r?: string[];
}

/** A replay file's text: gzipped files (the checked-in `distilled/*.jsonl.gz`) are read as they are committed. */
const readText = (file: string) =>
  file.endsWith(".gz") ? gunzipSync(readFileSync(file)).toString("utf8") : readFileSync(file, "utf8");

/**
 * The requests of `cards-enrich.ts --intent` (`intent-v<N>.jsonl`, lines `{h, r, c}`): an item's hash → the requests
 * it would change (D87, docs/research/edge-intent.md). Several files merge, the later winning.
 */
export function loadRequests(...files: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const file of files) {
    if (!existsSync(file)) continue;
    for (const line of readText(file).split("\n")) {
      if (!line.trim()) continue;
      const l = JSON.parse(line) as { h: string; r?: unknown };
      if (Array.isArray(l.r))
        out.set(
          l.h,
          l.r.filter((x): x is string => typeof x === "string"),
        );
    }
  }
  return out;
}

export function loadCards(file: string): Map<string, Card | null> {
  const out = new Map<string, Card | null>();
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const l = JSON.parse(line) as Line;
    // A requests-only line holds no card: the item stays uncovered for the cards.
    if (l.c !== undefined) out.set(l.h, l.c);
  }
  return out;
}

/**
 * The checked-in intent requests (`cards-enrich.ts --intent` with Haiku; D110, D158, topped up on 2026-11-06) and the
 * suite × seed shards they were made for. The file is keyed on item content, so a run outside these would replay only
 * the items its worlds happen to share: the funnel and the live harnesses leave such a run's intent inert, and say
 * so, rather than half-replaying.
 */
export const INTENT_FILE = "intent-v2.jsonl.gz";
export const INTENT_PATH = join(import.meta.dir, "..", "..", "lab", "distilled", INTENT_FILE);
export const INTENT_COVERS: Record<string, string[]> = {
  ...Object.fromEntries(parseSuites("train").map((s) => [s, ["41", "42", "43", "44"]])),
  // The reworded train suites (D871) plant into the same worlds: the same items, so the same coverage.
  ...Object.fromEntries(parseSuites("reworded").map((s) => [s, ["41", "42", "43", "44"]])),
  // P2's reworded train: the same worlds (only the request's words differ), so the same file covers it.
  ...Object.fromEntries(parseSuites("train-rw").map((s) => [s, ["41", "42", "43", "44"]])),
  heldout10: ["41", "42"],
  heldout11: ["41", "42"],
  heldout13: ["41", "42", "43", "44"],
  // RealUse-1 (docs/research/realuse-1/A-heldout14.md): topped up on Haiku 5.5, 2026-11-06.
  heldout14: ["41", "42", "43", "44"],
  // The weak-points plan's blind suite (docs/research/fix-s3b-lab.md): made on Haiku 5.5 on 2026-11-07, unrun.
  heldout15: ["41", "42", "43", "44"],
  // The CL wave's blind suite (docs/research/cl-cl5.md): made on Haiku 5.5 on 2026-11-07, unrun.
  heldout16: ["41", "42", "43", "44"],
  // The end-of-day confirmation's blind suite (docs/research/a19-heldout17.md): made on Haiku 5.5 on 2026-11-07, unrun.
  heldout17: ["41", "42", "43", "44"],
  // M6's blind suite (docs/research/m6-heldout18.md): made on Haiku 5.5 on 2026-11-10, unrun.
  heldout18: ["41", "42", "43", "44"],
};

/**
 * The shipped-coverage caches (P7, D872): the cards and intent requests the shipped enricher (`buildPartner`'s own
 * `CardEnricher`, DEFAULT_CONFIG and DEFAULT_LIMITS) made for each world of these suite × seed shards, recorded by
 * `cold-start.ts --cards-out` over the hidden, control and neutral worlds with the card role on Haiku 5.5 (Anthropic,
 * lab transport, D97). Train's lines come last, so train's cards win where a longtail or heldout19 world carded the
 * same base item. One file holds both: `bun run funnel --coverage shipped` replays it as `--cards` and `--intent`.
 * Where several worlds of a seed carded the same item, the last line read wins.
 */
export const SHIPPED_FILE = "cards-shipped.jsonl.gz";
export const SHIPPED_PATH = join(import.meta.dir, "..", "..", "lab", "distilled", SHIPPED_FILE);
export const SHIPPED_COVERS: Record<string, string[]> = {
  ...Object.fromEntries(parseSuites("train,reworded,longtail,heldout19").map((s) => [s, ["41", "42", "43", "44"]])),
  // F8's tuning suites (D1100): served by subagents per item on the world's clock (D1102), in both prompt forms.
  ...Object.fromEntries(parseSuites("dev20").map((s) => [s, ["41", "42", "43", "44"]])),
};

/**
 * The shards SHIPPED_FILE holds a prompt form's lines for (D1060, D1063): form 3 (`cardsRequestsFix`, in the default
 * since D1062) was recorded for train, reworded and longtail seeds 41-44 only. heldout19 has none: a run that must
 * not read it cannot record them, and its harness records its own (B19).
 */
export const SHIPPED_FORM_COVERS: Record<number, Record<string, string[]>> = {
  3: Object.fromEntries(parseSuites("train,reworded,longtail,dev20").map((s) => [s, ["41", "42", "43", "44"]])),
  // `cardsState` (F2, D1193): form 3 with the state flag, served by subagents per item on the world's clock (D1102).
  19: Object.fromEntries(parseSuites("train,reworded,longtail,dev20").map((s) => [s, ["41", "42", "43", "44"]])),
};

/**
 * A `<suite>+silent` run (F3, D1123) plants into its base's worlds: the same items, so the base's coverage. Only the
 * earlier versions it puts at the source for the backfill are new text (carded live, or a replay miss in the funnel).
 */
const coverName = (s: string) => s.replace(/\+silent$/, "");

/**
 * The suite × seed shards SHIPPED_FILE was not made for; with a prompt form (`form`), also those it holds no line of
 * that form for (replayed under the form they would have no card and no requests: a silent hole, so not covered).
 */
export function shippedUncovered(suites: string[], seeds: (string | number)[], form = 0): string[] {
  const covers = (map: Record<string, string[]>, s: string, seed: string | number) =>
    map[coverName(s)]?.includes(String(Number(seed))) === true;
  const formCovers = form ? (SHIPPED_FORM_COVERS[form] ?? {}) : null;
  return suites.flatMap((s) =>
    seeds
      .filter((seed) => !covers(SHIPPED_COVERS, s, seed) || (formCovers && !covers(formCovers, s, seed)))
      .map((seed) => `${s} seed ${seed}`),
  );
}

/**
 * `--coverage` for the live harnesses (pi-ab, hermes-ab; P7, D878), as the funnel resolves it (D877). `shipped`, the
 * default wherever SHIPPED_COVERS covers the run, replays SHIPPED_PATH (unpacked to a temp file) as both the cards
 * and the intent requests: what the shipped enricher wrote for those worlds; a card the in-run enricher asks for
 * beyond it is made live as before. A run it does not cover keeps `cards`/`intent` as given (`full`, the replay
 * before D878). With the default, an explicit `--cards` or `--intent` throws: a run that replays its own files
 * (every run pre-registered before D878) pins `--coverage full`. `--days` users are covered when their suites and
 * seeds are, an approximation: the file was made per suite world, not for the combined user world.
 */
export function harnessCoverage(o: {
  coverage: string;
  cards: string;
  intent: string;
  suites: string[];
  seeds: (string | number)[];
  /** The card prompt's form the run's Eden arms ask in (`CARD_FORM_REQUESTS` with `cardsRequestsFix`, D1063). */
  form?: number;
}): { coverage: "shipped" | "full"; cards: string; intent: string; note: string } {
  if (o.coverage !== "" && o.coverage !== "full" && o.coverage !== "shipped") {
    throw new Error(`--coverage takes shipped or full, not ${o.coverage}`);
  }
  const own = o.cards !== "" || o.intent !== "default";
  const uncovered = shippedUncovered(o.suites, o.seeds, o.form ?? 0);
  if (o.coverage === "full" || (o.coverage === "" && uncovered.length > 0)) {
    const why = o.coverage === "full" ? "--coverage full" : `${SHIPPED_FILE} does not cover ${uncovered[0]}`;
    return { coverage: "full", cards: o.cards, intent: o.intent, note: `coverage full (${why}, D878)` };
  }
  if (own) {
    throw new Error(
      "--cards or --intent with shipped coverage (the default where it covers the run, D878): pass --coverage full " +
        "to replay your own files (as every run registered before D878 does), or drop them",
    );
  }
  if (uncovered.length) throw new Error(`--coverage shipped: ${SHIPPED_FILE} does not cover ${uncovered.join(", ")}`);
  const dir = mkdtempSync(join(tmpdir(), "eden-shipped-"));
  // Removed when the harness exits: one ~10 MB copy a run otherwise piles up in the temp directory.
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "shipped.jsonl");
  writeFileSync(file, gunzipSync(readFileSync(SHIPPED_PATH)));
  return { coverage: "shipped", cards: file, intent: file, note: `coverage shipped (${SHIPPED_FILE}, D878)` };
}

/** The suite × seed shards INTENT_FILE was not made for. */
export function intentUncovered(suites: string[], seeds: (string | number)[]): string[] {
  return suites.flatMap((s) =>
    seeds
      .filter((seed) => !INTENT_COVERS[coverName(s)]?.includes(String(Number(seed))))
      .map((seed) => `${s} seed ${seed}`),
  );
}

/**
 * `--intent` for the live harnesses (pi-ab, hermes-ab), as the funnel resolves it (D158): `default` replays
 * INTENT_PATH when the configuration has intent, the cards are replayed (`--cards`) and the file covers every suite
 * and seed of the run; `none` replays nothing; anything else is a comma list of files. `note` says which and why.
 */
export function harnessIntent(
  arg: string,
  run: { wanted: boolean; cardsReplayed: boolean; suites: string[]; seeds: (string | number)[] },
): { files: string[]; note: string } {
  if (arg === "none") return { files: [], note: "--intent none" };
  if (arg !== "default") return { files: arg.split(",").filter(Boolean), note: arg };
  if (!run.wanted || !run.cardsReplayed) return { files: [], note: "" };
  const uncovered = intentUncovered(run.suites, run.seeds);
  if (!uncovered.length)
    return { files: [INTENT_PATH], note: `${INTENT_FILE} by default, D158; coverage full: every item, D714` };
  const shown = uncovered.slice(0, 4).join(", ") + (uncovered.length > 4 ? `, … ${uncovered.length - 4} more` : "");
  return { files: [], note: `the checked-in requests do not cover ${shown}` };
}

/**
 * How many of the items a run's sources hold (each source's `listAll`, redacted as the cache redacts them, as
 * cards-enrich.ts reads them) have replayed requests: `found` of `of` distinct items.
 */
export function intentCoverage(
  sourceItems: ContextItem[][],
  requests: Map<string, string[]>,
  /** The replay key under the run's card prompt form (`DiskCardMaker.requestKey`, D1063); the content hash alone. */
  keyOf: (item: ContextItem) => string = cardKey,
): { found: number; of: number } {
  const keys = new Set<string>();
  for (const raw of sourceItems) {
    const cache = new ItemCache({ maxItemsPerUser: 100_000 });
    for (const it of cache.put({ tenantId: "t", userId: "u" }, raw, 0)) keys.add(keyOf(it));
  }
  let found = 0;
  for (const h of keys) if (requests.get(h)?.length) found++;
  return { found, of: keys.size };
}

/**
 * The harness header's intent line. With cards made live the card model writes each carded item's requests; with
 * cards replayed only a replayed requests file gives the rest theirs, so a run with none covering it is labelled
 * INTENT_INERT (what it measures is the default with intent inert for the items no live call carded).
 */
export function intentLine(o: {
  wanted: boolean;
  cardsReplayed: boolean;
  files: string[];
  note: string;
  found: number;
  of: number;
}): string {
  if (!o.wanted) return "intent: off";
  if (!o.cardsReplayed) return "intent: live (the card model writes the requests of the items it cards)";
  // Inert is what the replay holds, not which files were named: a named file that matches nothing is inert too, and
  // requests replayed from the card files alone (no requests file) are a partial replay, said so.
  const label =
    o.found === 0 ? `  ${INTENT_INERT}` : o.files.length === 0 ? "  [intent partial: from the card files only]" : "";
  return `intent: replayed ${o.found} of ${o.of} items (${o.note || "no --intent"})${label}`;
}

/**
 * Whether two paths name one file: resolved against the working directory and through symlinks, through the file's
 * directory when the file does not exist yet (an output file). A raw string comparison lets `./a.jsonl` past a check
 * that it is not `a.jsonl`.
 */
export function samePath(a: string, b: string): boolean {
  const real = (p: string): string => {
    const abs = resolve(p);
    if (existsSync(abs)) return realpathSync(abs);
    const dir = dirname(abs);
    return dir === abs ? abs : resolve(real(dir), basename(abs));
  };
  return real(a) === real(b);
}

const NONE: Card = { kind: "none", actions: [], entities: [], statement: "" };

/** Cards a live call is making now, by hash (undefined when the call failed or the model gave none back). */
type Inflight = Map<string, Promise<Card | undefined>>;

/**
 * The replay key of an item's card and requests under a prompt form (`CardMakeOptions.form`, D1060): the content hash
 * alone for the shipped form, `<hash>:f<form>` for another, so one file can hold both and a line made by one form
 * never answers the other (every reader that keys by `cardKey` alone sees only the shipped form's lines).
 */
export function formKey(item: ContextItem, form = 0): string {
  return form ? `${cardKey(item)}:f${form}` : cardKey(item);
}

export class DiskCardMaker implements CardMaker {
  readonly cards: Map<string, Card | null>;
  /**
   * Shared like `cards`, so streams that miss the same item at once (pi-ab's `eden` and `eden~ALL2` on one world)
   * pay for its card once and get the same card, not two different ones that would confound the paired A/B.
   */
  readonly inflight: Inflight;
  hits = 0;
  misses = 0;
  /**
   * Items not sent live because the call would buy nothing (CL3, after CL5's finding that most in-run backfill stayed
   * live with cards replayed): asked for requests, its requests replayed, and rejected by the card prefilter (the
   * looser one, so the stricter `cardsEconomy` one too). The enricher reads such an item for its requests only and
   * ignores its card (`only` in `CardEnricher`), and `make` returns the replayed requests over a live call's, so the
   * call's output would be thrown away.
   */
  skipped = 0;

  private readonly out: string;
  /**
   * Replayed requests (`intent`, D87), by hash: a call that asks for them (`make`'s `intent`) gets each item's from
   * here (null when none was made). A live miss's requests are kept here too and appended with its card to `out`
   * (`{h, c, r}`), so a later run that replays `out` replays them.
   */
  readonly requests: Map<string, string[]>;

  /**
   * `options.out`: where new cards go (its cards and requests are replayed too); default the cache file itself.
   * `options.shared`: another maker of the same files, whose cards and calls in flight this one shares, so several
   * makers read the files once and see each other's new cards (pi-ab's streams), and its replayed requests.
   * `options.requests`: requests files (`loadRequests`, `.gz` read as is) replayed when a call asks for requests; they
   * win over requests in the card files (`r` lines a live call wrote). `options.cardRequests: false` skips those `r`
   * lines, so a run that opts out of replayed intent (`--intent none`, or a run the checked-in file does not cover)
   * replays none, whatever an earlier run left in `--cards-out` (a live call's requests still count). An item with
   * requests but no replayed card is given a none card, so the cards a run matches are exactly the card files' (the
   * requests' files may hold cards of their own, from another model: they are not read here).
   */
  constructor(
    file: string,
    private readonly live?: CardMaker,
    options: {
      out?: string;
      shared?: { cards: Map<string, Card | null>; inflight: Inflight; requests?: Map<string, string[]> };
      requests?: string[];
      cardRequests?: boolean;
    } = {},
  ) {
    this.out = options.out ?? file;
    this.cards = options.shared?.cards ?? loadCards(file);
    this.inflight = options.shared?.inflight ?? new Map();
    const cardFiles = options.out && !samePath(options.out, file) ? [file, options.out] : [file];
    const replayed = options.cardRequests === false ? [] : cardFiles;
    this.requests = options.shared?.requests ?? loadRequests(...replayed, ...(options.requests ?? []));
    if (!options.shared && options.out) for (const [h, c] of loadCards(options.out)) this.cards.set(h, c);
    // The cards and the requests may come from different files (`--cards` and `--intent`): each decides apart.
    for (const [keys, held] of [
      [this.cards.keys(), this.heldCardForms],
      [this.requests.keys(), this.heldRequestForms],
    ] as const) {
      for (const h of keys) {
        const m = /:f(\d+)$/.exec(h);
        if (m) held.add(Number(m[1]));
      }
    }
  }

  async make(
    items: ContextItem[],
    today: string,
    signal: AbortSignal,
    retry = false,
    intent = false,
    options: CardMakeOptions = {},
  ): Promise<CardBatch> {
    const asked = options.form ?? 0;
    const cardForm = this.replayed(asked, this.heldCardForms);
    const requestForm = this.replayed(asked, this.heldRequestForms);
    if (options.requestsOnly) return this.makeRequests(items, today, signal, { ...options, form: requestForm });
    const got = await this.makeCards(items, today, signal, retry, intent, cardForm, requestForm);
    if (!intent) return got;
    const requests = items.map((it) => this.requests.get(formKey(it, requestForm)) ?? null);
    // Requests with no card: the item is covered, with no constraint (as a card file's uncovered item matches none).
    const cards = got.cards.map((c, i) => c ?? (requests[i] ? NONE : null));
    return { ...got, cards, requests };
  }

  /**
   * The form a call replays (D1060): its own when the files hold any line of it, else the shipped form's lines. A
   * file recorded before the form existed (the full index `intent-v2`, `cards-v2`, every reader recipe's cards) is
   * replayed as it was recorded, rather than going inert; a file that holds the form (`cards-shipped`) answers only
   * from its lines, so within one file the forms never mix (an item it has no line of the form for is a miss).
   */
  /** The key an item's replayed requests are read under when a call asks in `form` (diagnostics read it too). */
  requestKey(item: ContextItem, form = 0): string {
    return formKey(item, this.replayed(form, this.heldRequestForms));
  }

  /** The key an item's replayed card is read under when a call asks in `form`. */
  cardKeyFor(item: ContextItem, form = 0): string {
    return formKey(item, this.replayed(form, this.heldCardForms));
  }

  private replayed(form: number, held: ReadonlySet<number>): number {
    return form && held.has(form) ? form : 0;
  }

  /**
   * The forms the files held when this maker was built (fixed then: a live miss appended under a form later must not
   * switch a file recorded before it from replay as recorded to misses halfway through a run).
   */
  private readonly heldCardForms = new Set<number>();
  private readonly heldRequestForms = new Set<number>();

  /**
   * `cardsRequestsFix`'s re-ask (D1060): each item's replayed requests under the form; the items with none go to the
   * live maker when there is one, and its answers are kept and appended (`{h, r}` with the form's key).
   */
  private async makeRequests(items: ContextItem[], today: string, signal: AbortSignal, options: CardMakeOptions) {
    const form = options.form ?? 0;
    const requests = items.map((it) => this.requests.get(formKey(it, form)) ?? null);
    const missing = items.flatMap((_, i) => (requests[i] === null ? [i] : []));
    let costUsd = 0;
    if (this.live && missing.length > 0) {
      const got = await this.live.make(
        missing.map((i) => items[i]!),
        today,
        signal,
        false,
        true,
        options,
      );
      costUsd = got.costUsd;
      missing.forEach((i, k) => {
        const r = got.requests?.[k] ?? null;
        if (!r) return;
        const h = formKey(items[i]!, form);
        this.requests.set(h, r);
        this.append({ h, r });
        requests[i] = r;
      });
    }
    return { cards: items.map(() => null), requests, costUsd };
  }

  private async makeCards(
    items: ContextItem[],
    today: string,
    signal: AbortSignal,
    retry: boolean,
    intent: boolean,
    form: number,
    requestForm: number,
  ) {
    const out: (Card | null)[] = [];
    const missing: number[] = [];
    // Items whose card a call (this one's, or another stream's) is making: filled in when it settles.
    const waiting: [number, Promise<Card | undefined>][] = [];
    const settle = new Map<string, (c: Card | undefined) => void>();
    items.forEach((it, i) => {
      const h = formKey(it, form);
      out[i] = null;
      const pending = this.inflight.get(h);
      if (this.cards.has(h)) {
        // A retry (the live call was cut off) re-reads the same batch: counted once.
        if (!retry) this.hits++;
        // A card the model said was none replays as a none card: covered, nothing to match.
        out[i] = this.cards.get(h) ?? { kind: "none", actions: [], entities: [], statement: "" };
      } else if (pending) {
        if (!retry) this.hits++;
        waiting.push([i, pending]);
      } else if (intent && this.requests.has(formKey(it, requestForm)) && !worthCarding(it)) {
        if (!retry) this.skipped++;
        // Covered by its replayed requests: a none card, as `make` gives an item with requests and no card.
        out[i] = NONE;
      } else {
        if (!retry) this.misses++;
        if (!this.live) return;
        missing.push(i);
        const p = new Promise<Card | undefined>((done) => settle.set(h, done));
        this.inflight.set(h, p);
        waiting.push([i, p]);
      }
    });
    let costUsd = 0;
    let truncated = false;
    if (this.live && missing.length > 0) {
      const made = new Map<string, Card>();
      try {
        const got = await this.live.make(
          missing.map((i) => items[i]!),
          today,
          signal,
          retry,
          intent,
          form ? { form } : {},
        );
        costUsd = got.costUsd;
        truncated = got.truncated === true;
        missing.forEach((i, k) => {
          const h = formKey(items[i]!, form);
          const r = got.requests?.[k] ?? undefined;
          // Read back in this run under the requests' replay form; kept in the file under the form that made it.
          if (r) this.requests.set(formKey(items[i]!, requestForm), r);
          const c = got.cards[k];
          if (c === undefined || c === null) {
            // Requests with no card: kept for the next run, the card left uncovered (asked again then).
            if (r) this.append({ h, r });
            return;
          }
          made.set(h, c);
          this.put(h, c.kind === "none" ? null : c, r);
        });
      } finally {
        // Settled whether or not the call worked: a card it did not make is uncovered for every waiter, and the next
        // call that misses it asks again (a cut-off call's own stream sends it again as `retry`).
        for (const [h, done] of settle) {
          this.inflight.delete(h);
          done(made.get(h));
        }
      }
    }
    for (const [i, p] of waiting) out[i] = (await p) ?? null;
    return { cards: out, costUsd, truncated };
  }

  /** Keeps a card (and, when the call asked for them, the item's requests) and appends it to `out`. */
  put(h: string, c: Card | null, r?: string[]): void {
    this.cards.set(h, c);
    this.append(r ? { h, c, r } : { h, c });
  }

  private append(line: Line): void {
    appendFileSync(this.out, `${JSON.stringify(line)}\n`);
  }
}
