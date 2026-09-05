import { createHash } from "node:crypto";

/**
 * Domain-general command shapes.
 *
 * Everything here works on ANY shell command — kubectl, aws, stripe, psql,
 * terraform, python scripts — not on a hardcoded CLI family. The job is to
 * answer three questions about a recorded command without knowing the binary:
 *
 *  1. What is its stable *shape* (the part that repeats across occurrences)?
 *  2. Which tokens are *parameters* (vary between occurrences of one shape)?
 *  3. Is it safe to treat as a read (reorderable, dedupable)?
 *
 * The classification fails conservative: an unknown command never counts as
 * a read, so it never shares a parallel wave and never collapses onto a
 * sibling — worst case it compiles into a sequential step, which is exactly
 * what the agent did by hand.
 */

/** Families that are session plumbing, not work worth compiling. */
const NOISE_BINARIES = new Set([
  "cd",
  "pwd",
  "ls",
  "echo",
  "export",
  "source",
  "which",
  "man",
  "history",
  "clear",
  "true",
  "false",
  "sleep",
  "date",
]);

/** Binaries whose subcommands are predominantly mutations or session state. */
const CAUTIOUS_BINARIES = new Set(["git", "docker", "npm", "pnpm", "yarn", "bun", "pip", "cargo"]);

export function isNoiseCommand(command: string): boolean {
  const bin = command.trim().split(/\s+/)[0]?.replace(/^["']|["']$/g, "") ?? "";
  return NOISE_BINARIES.has(bin);
}

/** Shell words that mark a command as mutating no matter the verb. */
const SHELL_WRITE_MARKERS = /(^|\s)(>>?|tee\b|rm\b|mv\b|cp\b|chmod\b|chown\b|kill\b|pkill\b)/;

export type CommandShape = {
  /** Binary + leading subcommand path, e.g. `stripe.invoices.list`. */
  name: string;
  /** Flag names in first-seen order, values dropped. */
  flags: string[];
  /** Positional words that are not variable-looking. */
  literals: string[];
  /** Positional slots that look like identifiers (numbers, hashes, ids). */
  varSlots: number;
  /** True when nothing about the command suggests it changes the world. */
  possiblyRead: boolean;
};

function splitWords(command: string): string[] {
  // Genuinely quote-aware tokenization: single/double quotes span whitespace
  // AND newlines, and the whole quoted span collapses to one opaque token —
  // free-form data (SQL bodies, commit messages) must not leak fragments into
  // shape identities. The old split-on-whitespace version claimed this in its
  // docstring while splitting `"two words"` in half.
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  const flush = () => {
    if (cur) out.push(quote ? `"${cur}"` : cur);
    cur = "";
  };
  for (const ch of command) {
    if (quote) {
      if (ch === quote) {
        flush();
        quote = null;
      } else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      flush();
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    cur += ch;
  }
  flush();
  return out.filter(Boolean);
}

/**
 * Dense witness: a token that can appear in a program envelope as a real
 * entity (account id, UUID, email, ARN, Stripe/Twilio prefix, S3 URI, GID).
 * Bare integers (`123`) and ordinary words (`staging`, `ticket`) are not dense
 * — exact envelope membership is the only match, and those values must
 * themselves pass this filter or they never enter the witness set.
 */
export function looksLikeDenseWitness(token: string): boolean {
  const t = token.replace(/["'],?$/, "").replace(/[.,;:!?)]+$/g, "");
  if (t.length < 4 || t.length > 256) return false;
  if (/^\d+$/.test(t)) return false;
  if (/^[A-Z]+-\d+$/.test(t)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) return true;
  if (/^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(t)) return true;
  if (/^s3:\/\//i.test(t)) return true;
  if (/^arn:aws:/i.test(t)) return true;
  if (/^gid:\/\//i.test(t)) return true;
  if (/^\+[1-9]\d{6,14}$/.test(t)) return true;
  if (/^[a-z]{2,8}_[A-Za-z0-9]{8,}$/.test(t)) return true;
  if (/^SM[a-f0-9]{32}$/i.test(t)) return true;
  if (/^U[A-Z0-9]{8,11}$/.test(t)) return true;
  if (/^00[a-zA-Z0-9]{13,16}$/.test(t)) return true;
  if (/^[a-f0-9]{24}$/i.test(t)) return true;
  if (/^[a-z][a-z0-9]*-[a-z0-9]*\d[a-z0-9]*$/i.test(t) && t.length >= 6) return true;
  return false;
}

/** Identifier-looking token: number, long hex, uuid, dotted count, slug-id. */
export function looksLikeIdentifier(token: string): boolean {
  const t = token.replace(/["'],?$/, "");
  return (
    /^\d+$/.test(t) ||
    /^[a-f0-9]{7,64}$/i.test(t) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}/i.test(t) ||
    /^(v?\d+\.){1,3}\d+/.test(t) ||
    /^[A-Z]+-\d+$/.test(t) ||
    /^\$\{?\w+\}?$/.test(t)
  );
}

/**
 * PowerShell cmdlet detection (G11): Verb-Noun pairs where the VERB carries
 * the effect. Approved read verbs vs everything else — the same
 * positively-prove-read-or-it's-a-write rule the POSIX path uses, expressed
 * in PowerShell's own vocabulary.
 */
const PS_READ_VERBS = new Set([
  "get",
  "read",
  "search",
  "test",
  "show",
  "measure",
  "find",
  "import",
  "select",
  "compare",
]);
const PS_VERB_NOUN = /^([A-Za-z]+)-([A-Z][A-Za-z]+)$/;

function isPowerShellCmdlet(bin: string): boolean {
  return PS_VERB_NOUN.test(bin);
}

function psVerb(bin: string): string {
  return bin.split("-")[0]!.toLowerCase();
}

/**
 * Shape of one recorded command. Values of `--flag value` pairs are dropped
 * from the signature (they are parameters by construction) but counted; a
 * value that looks like an identifier increments `varSlots`.
 */
export function commandShape(command: string): CommandShape | null {
  const cleaned = command.trim().replace(/\b sudo \b/, "").replace(/^sudo\s+/,"").replace(/[;&|]+\s*$/, "");
  if (!cleaned) return null;
  const segments = cleaned.split(/\s*(?:&&|\|\||;|\|)\s*/);
  // Shape reflects the first segment; pipelines are handled by callers that
  // explode them. A pipeline's shape is still extractable from its head.
  const words = splitWords(segments[0] ?? cleaned);
  if (!words.length) return null;
  const bin = words[0]!.replace(/^["']|["']$/g, "");
  // A lone token is not a command shape. This matters beyond aesthetics:
  // witness values from the envelope ("prod", "stage") flow through the same
  // shape extraction as live commands, and one-word junk signatures would
  // make unrelated calls look like matches.
  if (words.length < 2 && !/[./]/.test(bin)) return null;
  if (!/^[A-Za-z_][\w.\-/=]*$/.test(bin)) return null;
  const sub: string[] = [];
  const flags: string[] = [];
  const literals: string[] = [];
  let varSlots = 0;

  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    if (w.startsWith("-")) {
      const f = w.split("=")[0]!;
      flags.push(f);
      // `--flag=value`: the value rides on the token; a bare `--flag value`
      // consumes the next word unless the next word is another flag.
      if (!w.includes("=") && i + 1 < words.length && !words[i + 1]!.startsWith("-")) {
        const v = words[++i]!;
        if (looksLikeIdentifier(v)) varSlots++;
        else if (v.startsWith('"')) varSlots++;
      }
      continue;
    }
    if (w.startsWith('"') || w.startsWith("$") || looksLikeIdentifier(w)) {
      varSlots++;
      continue;
    }
    if (sub.length < 2) sub.push(w);
    else literals.push(w);
  }

  const parts = [(() => {
    // PowerShell cmdlets normalize into a readable, lowercase identity
    // (Get-ChildItem → powershell.get.childitem) so PS stretches name and
    // cluster like everything else.
    const psm = bin.match(PS_VERB_NOUN);
    if (psm) return `powershell.${psm[1]!.toLowerCase()}.${psm[2]!.toLowerCase()}`;
    return bin.replace(/[.\-/]/g, ".");
  })(), ...sub];
  return {
    // Collapse doubled dots: a subcommand like ".field" (jq .field f.json)
    // used to emit "jq..field".
    name: parts
      .join(".")
      .replace(/\.{2,}/g, ".")
      .slice(0, 64)
      .replace(/\.$/, ""),
    flags,
    literals,
    varSlots,
    possiblyRead: commandPossiblyRead(cleaned, bin, words),
  };
}

function commandPossiblyRead(cleaned: string, bin: string, words: string[]): boolean {
  if (SHELL_WRITE_MARKERS.test(cleaned)) return false;
  // PowerShell cmdlets (G11): the VERB-NOUN head decides, in PowerShell's
  // own approved-verb vocabulary. Get-ChildItem reads; Remove-Item does not.
  const ps = bin.match(PS_VERB_NOUN);
  if (ps) return PS_READ_VERBS.has(ps[1]!.toLowerCase());
  if (CAUTIOUS_BINARIES.has(bin)) {
    // Known-cautious binaries: trust only a positively-read first subcommand.
    const first = (words[1] ?? "").toLowerCase();
    return /^(get|list|show|view|describe|status|log|diff|search|inspect|info|ps|ls)$/.test(first);
  }
  // Unknown binaries fail conservative: the command must *open* with a read
  // verb somewhere in its first two words to be considered possibly-read.
  const head = [words[1], words[2]].map((w) => (w ?? "").toLowerCase().replace(/[^\w]/g, ""));
  return head.some((w) => /^(get|list|show|view|describe|status|search|fetch|read|query|scan|inspect|select|cat|print|dump)$/.test(w));
}

/**
 * Stable fingerprint of a command shape: same binary/subcommand/flags across
 * occurrences, values ignored except that identifier-valued slots must stay
 * identifier-valued. Two occurrences share a shape when this hash matches,
 * which is what makes *repetition* — not GitHub, not any vendor — the thing
 * that qualifies a stretch for compilation.
 */
export function commandShapeKey(command: string): string | null {
  const s = commandShape(command);
  if (!s) return null;
  return createHash("sha256")
    .update(JSON.stringify({ n: s.name, f: [...s.flags].sort(), v: s.varSlots > 0 }))
    .digest("hex")
    .slice(0, 16);
}

// Shape extraction re-tokenizes the same command strings many times per
// compile (islands predicates and mining alignment each call these), and at
// steering time every observed call passes through too. Tokenization is pure
// and commands repeat heavily during mining, so a bounded memo turns repeat
// inspections free — the same pattern as the redactor's key memo. Bounded so
// a pathological stream of unique commands cannot grow it without limit;
// clear-on-full keeps correctness trivially (a miss simply recomputes).
const SHAPE_MEMO_CAP = 4096;

const shapeMemo = new Map<string, ReturnType<typeof commandShape>>();
const shapeKeyMemo = new Map<string, string | null>();

export function commandShapeCached(command: string): CommandShape | null {
  const hit = shapeMemo.get(command);
  if (hit !== undefined || shapeMemo.has(command)) return hit ?? null;
  const fresh = commandShape(command);
  if (shapeMemo.size >= SHAPE_MEMO_CAP) shapeMemo.clear();
  shapeMemo.set(command, fresh);
  return fresh;
}

export function commandShapeKeyCached(command: string): string | null {
  const hit = shapeKeyMemo.get(command);
  if (hit !== undefined || shapeKeyMemo.has(command)) return hit ?? null;
  const fresh = commandShapeKey(command);
  if (shapeKeyMemo.size >= SHAPE_MEMO_CAP) shapeKeyMemo.clear();
  shapeKeyMemo.set(command, fresh);
  return fresh;
}

/**
 * Variation-driven slot abstraction (the FlashFill move, applied to shells).
 *
 * A single command cannot know which of its words are data: `kubectl logs
 * api -n dev` reads `api` as a second-level subcommand, so three of these —
 * one per app — look like three unrelated commands and never cluster. But
 * ACROSS witnesses the truth falls out structurally: tokens that are
 * identical in every occurrence are structure (literals); tokens that vary
 * are parameters. That inversion is the whole algorithm:
 *
 *   1. Group peers by binary + first subcommand + token count (mixed arity
 *      cannot align token-for-token).
 *   2. Per position: constant across the group → literal; varies → slot,
 *      numbered by first appearance ({v0}, {v1}, …).
 *
 * Returns one skeleton NAME per input command (absent when its group could
 * not align). Skeleton names are stable across witnesses — that stability is
 * what lets mining cluster them — and distinct per resource — so
 * `get pods|svc|deployments` stay separate compiled steps rather than
 * collapsing into one mushy identity.
 */
export function abstractShellGroup(commands: string[]): Map<string, string> {
  const out = new Map<string, string>();
  interface Group {
    members: Array<{ cmd: string; tokens: string[] }>;
    finalName?: string;
  }
  const groups = new Map<string, Group>();
  for (const cmd of commands) {
    const tokens = splitWords(cmd.trim());
    if (tokens.length < 2) continue;
    const bin = tokens[0]!.replace(/^["']|["']$/g, "");
    if (!/^[A-Za-z_][\w.\-/=]*$/.test(bin)) continue;
    const sub1 = tokens[1]!.startsWith("-") ? "" : tokens[1]!;
    const key = `${bin}.${sub1}.${tokens.length}`;
    const g = groups.get(key);
    if (g) g.members.push({ cmd, tokens });
    else groups.set(key, { members: [{ cmd, tokens }] });
  }
  for (const [, g] of groups) {
    if (g.members.length < 2) continue; // no variation evidence without peers
    const width = g.members[0]!.tokens.length;
    const skeletonTokens: string[] = [];
    let slotIdx = 0;
    for (let i = 0; i < width; i++) {
      const first = g.members[0]!.tokens[i]!;
      const varies = g.members.some((m) => m.tokens[i] !== first);
      if (!varies) skeletonTokens.push(i === 0 ? first.replace(/^["']|["']$/g, "") : first);
      else skeletonTokens.push(`{v${slotIdx++}}`);
    }
    // Build the name token-by-token so truncation can never cut inside a
    // {vN} placeholder (a dangling "{" is unparseable downstream), and keep
    // the FULL raw skeleton for the disambiguation hash below.
    const raw = skeletonTokens.join(".");
    const nameTokens: string[] = [];
    let len = 0;
    let truncated = false;
    for (const tok of skeletonTokens) {
      const clean = tok.replace(/[^A-Za-z0-9_.{}]/g, "");
      if (!clean) continue;
      if (len + clean.length + 1 > 56) {
        truncated = true;
        break;
      }
      nameTokens.push(clean);
      len += clean.length + 1;
    }
    const name = nameTokens.join(".").replace(/\.{2,}/g, ".").replace(/\.$/, "");
    if (!name && !truncated) continue;
    const finalName =
      truncated || !name ? `${nameTokens.join(".") || "shell"}.${hash8(skeletonTokens.join(" "))}`.slice(0, 80) : name;
    g.finalName = finalName;
  }
  // Sanitization merges distinct binaries ("my-tool" vs "mytool") and
  // truncated skeletons into identical names. Groups whose FINAL name
  // collides with a different group's get their raw-skeleton hash appended,
  // so distinct commands never share one identity.
  const byName = new Map<string, string[]>();
  for (const [key, g] of groups) {
    if (!g.finalName) continue;
    const list = byName.get(g.finalName);
    if (list) list.push(key);
    else byName.set(g.finalName, [key]);
  }
  for (const [, keys] of byName) {
    if (keys.length < 2) continue;
    for (const key of keys.slice(1)) {
      const g = groups.get(key)!;
      g.finalName = `${g.finalName}.${hash8(g.members[0]!.tokens.join(" "))}`;
    }
  }
  for (const [, g] of groups) {
    if (!g.finalName) continue;
    for (const m of g.members) out.set(m.cmd, g.finalName);
  }
  return out;
}

function hash8(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 8);
}
