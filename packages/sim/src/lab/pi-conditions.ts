/**
 * The conditions of `pi-ab.ts`, one grammar for every A/B the econ tracks ran (docs/research/econ-lab.md):
 *
 *   <base>[-act[-firewall]][~variant][+flag ...][@w<ms>]
 *
 * - base: none, tools, eden, both, eden-judge or both-judge (see pi-ab.ts);
 * - `-act`: the stub action tools (`act.ts`); only in `--act` runs, a mode of its own because it changes the system
 *   prompt and the tools, and there every condition gets it (`--act --conditions tools,eden` runs tools-act and
 *   eden-act);
 * - `-act-firewall`: and the engine's action firewall (`actionCheck`, D69) checks each action call before it runs; a
 *   finding holds the call and is the tool's result (`heldResult`). Beside `tools`, Eden runs only as that check: it
 *   observes the request but injects nothing and gives no tool;
 * - `~variant`: the settings `--variant-config` gives that name, over `--config`, so a configuration's A/B runs both
 *   arms in one process, concurrently and paired task by task (the machine's load falls on both alike);
 * - `+flag`: shorthand for one engine flag on, `eden+packetDates`; it stacks on a variant (`eden~ALL2+judgeBehind`);
 * - `@w<ms>`: how long the first observe waits for Eden's slow path (default 3000, the client's `withContext`).
 *
 * An unknown base throws: a typo must not run Eden under another condition's name.
 */

/** The settings each variant name adds over `--config`. */
export type Variants = Record<string, Record<string, unknown>>;

export interface Condition {
  /** As results and timelines record it (`--act` adds `-act` to a name without it). */
  name: string;
  base: "none" | "tools" | "eden" | "both" | "eden-judge" | "both-judge";
  act: boolean;
  /** `-act-firewall`: Eden checks each action call first (`actionCheck` on in `config`). */
  firewall: boolean;
  /** The engine configuration of this condition: `--config` with its variant's settings and flags over it. */
  config: Record<string, unknown>;
  waitMs: number;
  /** Eden's context reaches the agent (packets and `ask_context`): not in `tools-act-firewall`. */
  useEden: boolean;
  /** A `ContextPartner` runs in this condition: Eden's context, or the firewall alone. */
  withPartner: boolean;
  useTools: boolean;
  judge: boolean;
}

const BASES = ["none", "tools", "eden", "both", "eden-judge", "both-judge"] as const;
const SHAPE = /^([a-z-]+?)(-act(?:-firewall)?)?(?:~([A-Za-z0-9_.-]+))?((?:\+[^+@~]+)*)(?:@(.*))?$/;

/** `--variant-config`: a JSON object mapping each variant name to the settings it adds. */
export function parseVariants(json: string): Variants {
  const v = JSON.parse(json) as unknown;
  const bad = () => new Error(`--variant-config must map names to objects of settings, got ${json.slice(0, 80)}`);
  if (!v || typeof v !== "object" || Array.isArray(v)) throw bad();
  for (const x of Object.values(v)) if (!x || typeof x !== "object" || Array.isArray(x)) throw bad();
  return v as Variants;
}

export interface ConditionOptions {
  config: Record<string, unknown>;
  variants?: Variants;
  act?: boolean;
  /**
   * The engine's settings with their defaults (`DEFAULT_CONFIG`): a variant or flag naming another setting throws, a
   * `+flag` must name an on/off setting, and a variant's value must have its setting's type. Without it (tests of the
   * grammar alone) nothing is checked against the engine.
   */
  defaults?: Readonly<Record<string, unknown>>;
}

/** A value's type as a setting's is compared: arrays and null apart from other objects. */
const kind = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

export function parseCondition(name: string, options: ConditionOptions): Condition {
  const m = SHAPE.exec(name);
  const base = m?.[1] as Condition["base"] | undefined;
  if (!m || !base || !BASES.includes(base)) {
    throw new Error(`unknown condition "${name}" (bases: ${BASES.join(", ")}; see pi-conditions.ts)`);
  }
  const [, , actTag, variant, flagPart, wait] = m;
  if (actTag && !options.act) throw new Error(`condition ${name}: -act conditions run only with --act`);
  const flags = flagPart ? flagPart.slice(1).split("+") : [];
  for (const f of flags) if (!/^[a-zA-Z]+$/.test(f)) throw new Error(`bad flag in ${name}: use +flagName`);
  let extra: Record<string, unknown> = {};
  if (variant !== undefined) {
    const v = options.variants?.[variant];
    if (!v) throw new Error(`condition ${name}: no --variant-config entry "${variant}"`);
    extra = v;
  }
  const defaults = options.defaults;
  if (defaults) {
    const unknown = [...Object.keys(extra), ...flags].filter((k) => !Object.hasOwn(defaults, k));
    if (unknown.length) throw new Error(`condition ${name}: no engine setting named ${unknown.join(", ")}`);
    // A setting of another type would run a configuration no other run uses under a name that looks valid
    // (`+judgeItemBytes` as true, a variant's `"probes": "yes"`).
    for (const f of flags) {
      if (kind(defaults[f]) !== "boolean") throw new Error(`condition ${name}: ${f} is not an on/off flag`);
    }
    for (const [k, v] of Object.entries(extra)) {
      const want = kind(defaults[k]);
      if (kind(v) !== want) throw new Error(`condition ${name}: ${k} must be ${want}, got ${JSON.stringify(v)}`);
    }
  }
  const waitMs = wait === undefined ? 3_000 : wait.startsWith("w") ? Number(wait.slice(1)) : NaN;
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new Error(`bad wait in ${name}: use @w<ms>`);
  const act = !!options.act;
  const firewall = actTag === "-act-firewall";
  const useEden = base !== "none" && base !== "tools";
  return {
    name: act && !actTag ? name.replace(base, `${base}-act`) : name,
    base,
    act,
    firewall,
    config: {
      ...options.config,
      ...extra,
      ...Object.fromEntries(flags.map((f) => [f, true])),
      ...(firewall ? { actionCheck: true } : {}),
    },
    waitMs,
    useEden,
    withPartner: useEden || firewall,
    useTools: base === "tools" || base.startsWith("both"),
    judge: base.endsWith("-judge"),
  };
}

/**
 * Every `--conditions` name, parsed; two that end up with one name throw (`--act --conditions eden,eden-act` gives
 * `eden-act` twice), since results and timelines are keyed by the name and the report would pool them.
 */
export function parseConditions(names: readonly string[], options: ConditionOptions): Condition[] {
  const out = names.map((n) => parseCondition(n, options));
  const seen = new Set<string>();
  for (const c of out) {
    if (seen.has(c.name)) throw new Error(`condition ${c.name} is given twice (with --act, x and x-act are one)`);
    seen.add(c.name);
  }
  return out;
}

/**
 * The condition a report pairs this one against: a variant or flag condition against the same condition without
 * them (`eden~ALL2` against `eden`, keeping any wait), else a wait condition against its base; null for a plain one.
 */
export function pairedWith(name: string): string | null {
  const [named, wait] = name.split("@");
  const plain = named!.replace(/[~+].*$/, "");
  if (plain !== named) return wait === undefined ? plain : `${plain}@${wait}`;
  return wait === undefined ? null : named!;
}
