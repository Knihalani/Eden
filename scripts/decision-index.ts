#!/usr/bin/env bun
/**
 * Generates docs/DECISION-INDEX.md (one line per decision, with a status) and docs/DEAD-ENDS.md (every idea that was
 * tried or weighed and killed, by topic) from docs/DECISIONS.md (D812). DECISIONS.md is the record and stays the
 * authority; these two pages are a way into it that fits in a sitting.
 *
 *   bun run decisions:index            rewrites both pages
 *   bun run decisions:index --check    exits 1 when either committed page differs from what would be generated
 *
 * Statuses come from heuristics over the text, not from a field in the table: the row's own lead ("Finding:", "Lab
 * only", "rejected", "not built", "deleted with its code"), the "Trial switches" table (an open trial), and later
 * rows that name the decision or its switch as deleted, reversed, superseded or promoted. The output is deterministic
 * (no generation date, rows in table order) so the staleness test can compare bytes.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Row = {
  /** The number cell as written: `D812`, or a range such as `D496–D499`. */
  label: string;
  /** Every number the row holds, a range expanded. */
  numbers: number[];
  date: string;
  decision: string;
  why: string;
};

export type Trial = { name: string; numbers: number[] };

export const STATUSES = ["adopted", "rejected", "superseded", "trial", "finding", "lab"] as const;
export type Status = (typeof STATUSES)[number];

export type Verdict = {
  status: Status;
  /** The later decision that superseded, deleted or promoted this one, when the text names it. */
  by?: number;
  /** For `superseded`: whether it was deleted or rejected (a dead end) or only replaced. */
  deleted?: boolean;
  /** For an adopted row whose lead also rejects something ("X stays; removing it is rejected"): that part. */
  killedPart?: string;
};

/** Splits a markdown table row into its cells; `\|` inside a cell stays as written. */
export function cells(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 1; i < line.length; i++) {
    const c = line[i];
    if (c === "\\" && line[i + 1] === "|") {
      cur += "\\|";
      i++;
    } else if (c === "|") {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (cur.trim() !== "") out.push(cur.trim());
  return out;
}

/** The decision numbers a piece of text names: `D12`, `D500–D502`, `D500-D502` (a range wider than 30 is not one). */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\bD(\d+)(?:\s*[–-]\s*D?(\d+))?\b/g)) {
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    if (b > a && b - a <= 30) for (let n = a; n <= b; n++) out.push(n);
    else out.push(a);
  }
  return out;
}

/** The main decision table and the trial switches table of DECISIONS.md. */
export function parseDecisions(md: string): { rows: Row[]; trials: Trial[] } {
  const rows: Row[] = [];
  const trials: Trial[] = [];
  let inTrials = false;
  for (const line of md.split("\n")) {
    if (/^#+\s/.test(line)) inTrials = /^#+\s+Trial switches/.test(line);
    if (!line.startsWith("| ")) continue;
    const c = cells(line);
    const first = c[0] ?? "";
    if (inTrials) {
      if (first !== "Trial" && !/^-+$/.test(first)) trials.push({ name: first, numbers: numbersIn(first) });
    } else if (/^D\d+/.test(first)) {
      rows.push({ label: first, numbers: numbersIn(first), date: c[1] ?? "", decision: c[2] ?? "", why: c[3] ?? "" });
    }
  }
  return { rows, trials };
}

/** The bold lead of a decision cell (`**…**` at its start, after an optional parenthesised note), or null. */
export function lead(decision: string): string | null {
  // A note added afterwards may come first, plain or bold: "(Superseded by D188: …) **…**", "**(Deleted by D380.)**".
  const m = /^(?:\([^)]*\)\s*)?(?:\*\*\([^)]*\)\*\*\s*)?\*\*(.+?)\*\*/.exec(decision);
  return m ? m[1]! : null;
}

/** The first sentence: up to a full stop followed by a space and a capital, a backtick or a bracket. */
export function firstSentence(text: string): string {
  const m = /^(.+?[.!?])\s+(?=[A-Z`(*[])/.exec(text);
  return m ? m[1]! : text;
}

/** Text safe inside one table cell: no bold, links reduced to their text, pipes escaped, code spans balanced. */
export function cellSafe(text: string): string {
  let t = text
    .replace(/\*\*/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(?<!\\)\|/g, "\\|")
    .replace(/\s+/g, " ")
    .trim();
  // Outside code spans a `<` could open raw HTML; inside one it is shown as written.
  t = t
    .split("`")
    .map((part, i) => (i % 2 === 0 ? part.replace(/</g, "&lt;") : part))
    .join("`");
  if ((t.match(/`/g) ?? []).length % 2 === 1) t += "`";
  return t;
}

/** Shortens to at most `max` characters at a word boundary, with an ellipsis when cut. */
export function trimTo(text: string, max: number): string {
  if ([...text].length <= max) return text;
  const cut = [...text].slice(0, max - 1).join("");
  const space = cut.lastIndexOf(" ");
  const base = (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:(–-]+$/, "");
  return `${base}…`;
}

/** One line of at most `max` characters: trimmed first, then made table-safe (which closes a code span cut open). */
function oneLine(text: string, max: number): string {
  return cellSafe(trimTo(cellSafe(text).replace(/\\\|/g, "|"), max));
}

/** A bracket that only says where a decision came from: a doc, an audit, a commit, an owner, track tags. */
const META =
  /\s*\((?=[^()]*(?:docs\/|\.md\b|audit|renumber|collide|numbered D|commit|owner|ends 20|opened and closed|track ))[^()]*\)|\s*\((?:(?!D\d)[A-Z]{1,4}\d+\w*|H\d+)(?:[;, ]+(?:[A-Z]{1,4}\d+\w*|H\d+|§\d+\w*|and))*\)/g;

/** The words a summary is made from: the bold lead, else the first sentence past openers that only say "proposed". */
function summaryText(decision: string): string {
  const bold = lead(decision);
  // "**Not built, on $0 evidence (…):** (1) an entity census line …": the lead alone says nothing of what.
  if (bold?.endsWith(":"))
    return `${bold} ${firstSentence(decision.slice(decision.indexOf(bold) + bold.length + 2).trim())}`;
  if (bold) return bold;
  let t = decision.replace(/^\([^)]*\)\s*/, "").replace(PROPOSED, "");
  // "Rejected (deep audit …; may collide …). The reader's pool is not widened" → "Rejected: The reader's pool …".
  const opener = /^([A-Z][\w ,]{0,30}?) \([^()]*\)\.\s+/.exec(t);
  if (opener) t = `${opener[1]}: ${t.slice(opener[0].length)}`;
  return firstSentence(t);
}

/** The one-line summary of a decision: its bold lead, else its first sentence, without provenance, trimmed. */
export function summarize(decision: string, max = 140): string {
  return oneLine(summaryText(decision).replace(META, ""), max);
}

/** "Proposed (track x; …)." opens many early rows and says nothing of the verdict. */
const PROPOSED = /^Proposed(?: until the live measure)?(?:,? off by default)?(?: \([^)]*\))?[.:,]\s+/;

/**
 * The text a status heuristic reads for a row's own verdict: the lead when there is one, else the first sentence
 * after any "Proposed (…)." opener, cut at 250 characters (an unbolded row's first sentence can run to a paragraph
 * of numbered fixes).
 */
function headOf(row: Row): string {
  return lead(row.decision) ?? firstSentence(row.decision.replace(PROPOSED, "")).slice(0, 250);
}

const FINDING = /^(?:\([^)]*\)\s*)?\**\s*(?:Finding|Findings)\b/i;
const LAB = /^(?:\([^)]*\)\s*)?\**\s*(?:Lab only|Lab:|Pre-registered|A measurement is pre-registered|Adopted \(lab)/i;
/** A lead that states the verdict outright ("Not kept: …"): the words after it cannot make it a keep. */
const KILLED_LEAD =
  /^\W*(?:Not kept|Not taken|Not adopted|Rejected|Killed)\b|^\W*(?:Deleted|Rejected|Removed)\b[^:]{0,60}:/i;
/** A clause that records an idea measured or weighed and not kept. */
const KILLED =
  /\b(rejected|not built|not taken|not kept|not promoted|killed|ends without promotion|measured and deleted|and deleted|deleted with (?:its|their) code|is withdrawn|is reverted|not adopted|not reopened|no measurable effect)\b|[,:] deleted\b|^\W*deleted:/i;
/**
 * Words that also describe behaviour ("a user's file is deleted when its newest item expires", "a test file that
 * passed is not run again"): a kill only when the clause names a switch, a trial or code.
 */
const KILLED_IF_NAMED = /\b((?:is|are) deleted|(?:is|are) dropped|(?:is|are) not run)\b/i;
const NAMES_THING = /`|\btrial\b|\bswitch|\bcode\b/i;

/** A clause whose own verb keeps the thing it names, though a killed word appears in it. */
const NOT_KILLED = /\b(?:is|are) not (?:deleted|rejected|removed)\b/i;

/** Whether a clause records something killed. */
export function killedClause(clause: string): boolean {
  if (NOT_KILLED.test(clause)) return false;
  return KILLED.test(clause) || (KILLED_IF_NAMED.test(clause) && NAMES_THING.test(clause));
}
/** A clause that keeps what it names ("`pushCandidates` stays 5: … are rejected", "D65 holds"). */
const KEEPS = /\b(?:stays?|keeps|holds|stands)\b|(?<!not )\bkept\b/i;
/** A clause of a later row that deletes or reverses what it names. */
const DELETES =
  /\b(deleted|rejected|removed|reverted|withdrawn|killed|dropped|ends without promotion|not promoted|not kept|reverses|undoes)\b/i;
const PROMOTES =
  /\b(?:(?<!not )promoted|promotes|into the default|becomes the default|joins? the default|(?:is|are|on) in the default)\b|\b(?:in|into) `DEFAULT_CONFIG`/i;

/** Clauses: sentences and semicolon-separated parts, so a verb is read only with the numbers next to it. */
export function clauses(text: string): string[] {
  // Split at "; " and at ". " before a capital, a backtick or a bracket, but never inside brackets or code spans:
  // "(`graph`, `graphMerge`; D58, D107) is deleted" is one clause.
  const out: string[] = [];
  let depth = 0;
  let code = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "`") code = !code;
    if (code) continue;
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (c === ";" || c === ".") && text[i + 1] === " ") {
      if (c === "." && !/[A-Z`(*]/.test(text[i + 2] ?? "")) continue;
      out.push(text.slice(start, i + 1));
      start = i + 2;
    }
  }
  out.push(text.slice(start));
  return out.map((c) => c.trim().replace(/[;.]$/, "")).filter((c) => c !== "");
}

/** Words before a number that make it a citation ("as D112 asked", "amends D163"), not the thing acted on. */
const CITES = /^(?:as|by|per|under|see|after|on|amends|from|with|since|in|numbered)$/i;

/** Numbers a clause names as itself (`D246`, `(… D246)`), not as a possessive or a citation (`D112's rule`). */
export function namedWhole(clause: string): number[] {
  const out: number[] = [];
  for (const m of clause.matchAll(/(?:\b(\w+) )?\bD(\d+)(?:\s*[–-]\s*D?(\d+))?\b(['’]s)?/g)) {
    if (m[4] || (m[1] && CITES.test(m[1]))) continue;
    out.push(...numbersIn(m[0]));
  }
  return out;
}

/** A clause's verb about what it names: deleted, promoted, or neither (both, or a clause that keeps it). */
export function verbOf(clause: string): { verb: "deleted" | "promoted"; subject: string } | null {
  if (KEEPS.test(clause) || NOT_KILLED.test(clause)) return null;
  const del = DELETES.exec(clause);
  const pro = PROMOTES.exec(clause);
  if (!del === !pro) return null;
  const m = (del ?? pro)!;
  // The subject is what the verb acts on: the words before it ("`pushPointer` (D708) … is deleted"), or after a
  // heading-style verb up to the first bracket or comma ("Promoted: `partyCheck` is on …, part `parties` (A25;
  // D112)"), so numbers cited after the verb are not taken for its object.
  const heading = /^\W*(?:\w+(?: and \w+)?|(?:Deleted|Rejected|Removed)\b[^:]{0,60}):/.exec(clause);
  const subject =
    heading && m.index < heading[0].length
      ? clause.slice(heading[0].length).split(/ \(|,/)[0]!
      : clause.slice(0, m.index);
  return { verb: del ? "deleted" : "promoted", subject };
}

/** The switch a trial row opens: "Trial `name`", "`name` (trial", "`name` becomes a trial". */
export function trialSwitch(row: Row): string | null {
  const h = headOf(row);
  const m =
    /\btrial\s+`([^`]+)`/i.exec(h) ?? /^`([^`]+)`\s*\(trial/i.exec(h) ?? /^`([^`]+)`.{0,40} becomes a trial/i.exec(h);
  return m ? m[1]! : null;
}

/**
 * Switches a row opens: its trial switch, or near its start a flag it proposes ("`askVerdicts`, off by default",
 * "behind `graph` and `graphMerge`, off by default").
 */
export function introducedSwitches(row: Row): string[] {
  const out: string[] = [];
  const t = trialSwitch(row);
  if (t) out.push(t);
  // "Trial (off): a cold tier for the synced copy (`syncCold`, …)": the first name the head gives.
  const unnamed = t ? null : /^\W*Trial\b[^`]*`(\w+)`/.exec(headOf(row));
  if (unnamed) out.push(unnamed[1]!);
  const start = row.decision.slice(0, 400);
  if (!/off by default|\btrial\b/i.test(start)) return out;
  for (const m of start.matchAll(/\bbehind ((?:`\w+`(?:,? (?:and )?)?)+)/g)) {
    for (const s of m[1]!.matchAll(/`(\w+)`/g)) out.push(s[1]!);
  }
  for (const m of start.matchAll(/`(\w+)`(?: \([^)]*\))?,? (?:is )?off by default/g)) out.push(m[1]!);
  // "Proposed, off by default (…). The request-time bridging query, `bridgeQuery` (…)": the first name it gives.
  const named = /^Proposed, off by default[^`]*`(\w+)`/.exec(start);
  if (named) out.push(named[1]!);
  return [...new Set(out)];
}

type Later = { by?: number; deleted: boolean; promoted: boolean };

/** A row that sets the recommended configuration of its day ("The recommended experimental configuration is F …"). */
const RECOMMENDS = /\brecommended (?:experimental )?configuration\b/i;

/**
 * What later rows say about earlier ones, by number. Rows are in table order, which is number order; the last word
 * wins (a deletion after a promotion is a deletion).
 */
function laterWords(rows: Row[]): Map<number, Later> {
  const known = new Set(rows.flatMap((r) => r.numbers));
  const later = new Map<number, Later>();
  const note = (n: number, by: number | undefined, l: Omit<Later, "by">) => {
    if (!known.has(n) || (by !== undefined && n >= by)) return;
    later.set(n, { by, ...l });
  };
  // The switch each trial or proposal opened, by the first row that names it so.
  const switches = new Map<string, number>();
  for (const r of rows) {
    for (const s of introducedSwitches(r)) if (!switches.has(s)) switches.set(s, r.numbers[0]!);
  }
  // Only near a head's start, where a row names what it is about, not what it lists.
  const heads = rows.map((r) => ({ n: r.numbers[0]!, head: headOf(r).slice(0, 100) }));
  const firstNamed = (name: string, before: number) =>
    heads.find((h) => h.n < before && h.head.includes(`\`${name}\``))?.n;
  // The recommended configurations by name (F, H, ALL3, NEW, NEWL…): each is replaced by the next row that sets
  // one, and the last of them by the row that deletes the named presets (D112).
  const configs = rows.filter(
    (r) => RECOMMENDS.test(r.decision.slice(0, 300)) || /^(?:ALL|NEW)\w* = /.test(summaryText(r.decision)),
  );
  configs.forEach((r, i) => {
    const next = configs[i + 1];
    if (next) note(r.numbers[0]!, next.numbers[0]!, { deleted: false, promoted: false });
  });
  const presetsGone = rows.find((r) =>
    /\bthe rest of the named family\b|\bnamed presets were deleted\b/.test(r.decision),
  );
  const lastConfig = configs.at(-1);
  if (presetsGone && lastConfig)
    note(lastConfig.numbers[0]!, presetsGone.numbers[0]!, { deleted: false, promoted: false });
  for (const r of rows) {
    const self = r.numbers[0]!;
    const text = `${r.decision} ${r.why}`;
    // Explicit pointers anywhere in the row; "supersedes D28's always-on cascade" only amends D28.
    for (const m of text.matchAll(
      /\b(supersedes|reverses|replaces|deletes) (D\d+(?:\s*[–-]\s*D?\d+)?)(?!\d|['’]s)/gi,
    )) {
      for (const n of numbersIn(m[2]!)) note(n, self, { deleted: /deletes/i.test(m[1]!), promoted: false });
    }
    // "NEW (D96: …) replaces ALL3 (D80) as the recommended configuration": a name with its number in brackets.
    for (const m of text.matchAll(/\breplaces ([\w-]{1,20}) \((D\d+)\)/g)) {
      note(Number(m[2]!.slice(1)), self, { deleted: false, promoted: false });
    }
    // A bold outcome added to the row afterwards: "**Outcome: deleted by the pre-set rule**".
    for (const m of r.decision.matchAll(/\*\*Outcome\b([^*]*)\*\*/g)) {
      if (/\b(deleted|rejected|removed|not kept)\b/i.test(m[1]!))
        note(self, undefined, { deleted: true, promoted: false });
    }
    // "(ends D142's trial early)": the trial is over and its code goes.
    for (const m of text.matchAll(/\bends D(\d+)['’]s trial\b/g))
      note(Number(m[1]), self, { deleted: true, promoted: false });
    // "deleted by Dm", "(Superseded by Dm", "promoted by Dm": about the numbers just before it ("D89, deleted by
    // D112"), or, with none there and near the row's start, about the row itself (a note added afterwards).
    for (const m of text.matchAll(/\b(superseded|deleted|rejected|reversed|replaced|promoted) by D(\d+)/gi)) {
      // Only a number right before it counts: in "(D87, D159) or a model at ask time (D89, deleted by D112" it is D89.
      const adjacent = /\b(D\d+(?:\s*[–-]\s*D?\d+)?)\s*,?\s*$/.exec(text.slice(Math.max(0, m.index - 40), m.index));
      const targets = adjacent ? numbersIn(adjacent[1]!) : m.index < 600 ? r.numbers : [];
      const promoted = /promoted/i.test(m[1]!);
      const deleted = !promoted && !/superseded|replaced/i.test(m[1]!);
      for (const n of targets) note(n, Number(m[2]), { deleted, promoted });
    }
    // A "why" cell that records the end: "Measured and deleted (D704)", "Deleted (D704)".
    const end = /^(?:Measured and deleted|Deleted|Rejected) \(D(\d+)\)/i.exec(r.why);
    if (end) note(self, Number(end[1]), { deleted: true, promoted: false });
    // "(D51, since removed)": deleted, by a decision the row does not name.
    for (const m of text.matchAll(/\bD(\d+), since (?:removed|deleted)/g)) {
      note(Number(m[1]), undefined, { deleted: true, promoted: false });
    }
    // The row's own lead: the numbers and the trial switches each clause names, with the clause's verb.
    // A bold "**Deleted**" or "**Rejected**" section further in ("**Deleted** (no measurement favoured them on): 44
    // settings, … `bridgeQuery` …") deletes every switch it names.
    // A name no row opened as a switch ("`askWithModel` (`EDEN_ASK_MODEL=1`) restores …") is matched to the first
    // earlier row whose head names it.
    for (const m of r.decision.matchAll(/\*\*(?:Deleted|Rejected)\*\*(.*?)(?=\*\*|$)/g)) {
      for (const n of m[1]!.matchAll(/`([a-z]\w+)\*?`/g)) {
        const opened = switches.get(n[1]!) ?? firstNamed(n[1]!, self);
        // A guess by name never overrides what a row said outright about that decision.
        const guessed = !switches.has(n[1]!);
        if (opened !== undefined && !(guessed && later.has(opened))) {
          note(opened, self, { deleted: true, promoted: false });
        }
      }
    }
    for (const clause of clauses(headOf(r))) {
      const found = verbOf(clause);
      if (!found) continue;
      const l = { deleted: found.verb === "deleted", promoted: found.verb === "promoted" };
      for (const n of namedWhole(found.subject)) note(n, self, l);
      for (const [s, opened] of switches) if (found.subject.includes(`\`${s}\``)) note(opened, self, l);
    }
  }
  return later;
}

/** Each row's status (the vocabulary is documented at the top of the index page, `INDEX_HEAD`). */
export function classify(rows: Row[], trials: Trial[]): Map<string, Verdict> {
  const out = new Map<string, Verdict>();
  // A trial's cell names its own decision first and provenance after ("Action firewall (D69, D72)"); the first
  // number is the trial only when that row's head opens one ("tsgo as the merge gate (D113)" points at a list of
  // the owner's calls).
  const openTrials = new Set(trials.map((t) => t.numbers[0]).filter((n) => n !== undefined));
  const later = laterWords(rows);
  for (const r of rows) {
    const head = headOf(r);
    const l = later.get(r.numbers[0]!);
    const parts = clauses(head);
    const killed = parts.filter(killedClause);
    let v: Verdict;
    // A finding that also deletes code ("…; `syncOwedPollMs` is deleted") keeps that part for the dead-ends page.
    const deletes = killed.filter((c) => /\b(?:deleted|removed)\b/i.test(c));
    if (FINDING.test(r.decision) && deletes.length > 0) v = { status: "finding", killedPart: deletes.join("; ") };
    else if (FINDING.test(r.decision)) v = { status: "finding" };
    // Lab tooling a later decision deleted is a dead end like any other; lab tooling still in use is "lab".
    else if (LAB.test(r.decision) && !(l && l.deleted)) v = { status: "lab" };
    else if (r.numbers.some((n) => openTrials.has(n)) && /\btrial\b|off by default/i.test(head))
      v = { status: "trial" };
    else if (l && !l.promoted) v = { status: "superseded", by: l.by, deleted: l.deleted };
    else if (l) v = { status: "adopted", by: l.by };
    else if (/^(Measured and deleted|Deleted|No measurable effect)/i.test(r.why)) v = { status: "rejected" };
    // The first clause decides: "X is rejected; Y comes back as a trial" is a rejection, "X stays; removing it is
    // rejected" an adoption whose rejected part still belongs on the dead-ends page.
    else if (KILLED_LEAD.test(parts[0] ?? "")) v = { status: "rejected" };
    else if (killed.length > 0 && killed[0] === parts[0] && !KEEPS.test(parts[0]!)) v = { status: "rejected" };
    else if (killed.length > 0) v = { status: "adopted", killedPart: killed.join("; ") };
    else v = { status: "adopted" };
    out.set(r.label, v);
  }
  return out;
}

/** Topics for the dead-ends page: the first entry whose pattern the idea's text matches; "Other" when none does. */
export const TOPICS: Array<[string, RegExp]> = [
  ["Push and candidates", /\bpush|\bcandidates?\b|pushOpen|pushWiden|pointer/i],
  ["Reader", /\breader\b|reader[A-Z]|verifyAhead|re-?read/i],
  ["Cards and intent", /\bcards?\b|\bintent\b|enrich/i],
  ["Check", /\bcheck\b|firewall|actionCheck/i],
  [
    "Sync, sources and scale",
    /\bsync|\bsources?\b|connector|backfill|sweep|router|memory|heap|users? per|fan-out|scale/i,
  ],
  ["Ask", /\bask\b|\bask[A-Z]|\basks\b|ask's/i],
  ["Latency and path", /latenc|speculat|\bwait|deadline|off the (?:agent's )?path/i],
  ["Delivery and packet", /deliver|packet|inject|envelope|\bnote\b|excerpt/i],
  ["Lab and eval", /\blab\b|\beval|funnel|suite|harness|seed|judge|grade|test cache|replay|\bPi\b/i],
];

export function topicOf(text: string): string {
  for (const [name, re] of TOPICS) if (re.test(text)) return name;
  return "Other";
}

/** A clause that says why an idea ended: a cause, a failed bar, a cost or a missing gain. */
const BECAUSE =
  /\b(?:because|failed|fails|fell short|missed|did not|does not (?:pay|help|hold|raise|lower|change)|not worth|no (?:gain|fall|measurable|significant|false-concern gain)|bar\b|rule (?:asked|set)|too (?:slow|costly|expensive)|costs? (?:more|too)|judged)/i;
/** A clause that only lists sources: a doc, a section, a commit, a ledger. */
const FIGURE = /(?<![A-Za-z§#\d.])\d/;
const CITATION_ONLY = /^(?:[\w./-]+\.md|§|docs\/|`?packages\/|N\d|F\d|M\d|O\d|A\d+;|Pi on |Ledger)/;

/**
 * Why an idea ended, in a line: a clause that says so outright when the row has one; else a hidden-facts delta (a
 * gain is flagged, since an idea with a gain died for some other reason); else a short first sentence of "why".
 */
export function reasonOf(row: Row, causeOnly = false): string {
  const plain = (s: string) => s.replace(/\*\*/g, "");
  const all = [...clauses(plain(row.decision)), ...clauses(plain(row.why))];
  // First a clause that gives the cause ("Deleted because the stored answers cost an ingest call …"), then one that
  // names a missed bar or a missing gain with a figure (a number not part of "D708" or a commit).
  // A clause that restates the verdict ("… is rejected and deleted (W2b …)") is not a reason.
  const noted = /\b(?:Deleted|Rejected|Removed) \(([^()]{5,80})\)/.exec(plain(row.decision));
  if (noted) return oneLine(noted[1]!, 110);
  const cause =
    all.find((c) => /\bbecause\b|\bjudged\b/i.test(c)) ??
    all.find((c) => BECAUSE.test(c) && FIGURE.test(c) && !killedClause(c));
  if (cause) return oneLine(cause.replace(/^.*?\b(?=because\b)/i, ""), 110);
  if (causeOnly) return "";
  // The number must follow the words directly: "hidden, −4" or "hidden for +48" is some other figure.
  const text = plain(`${row.decision} ${row.why}`);
  const m = /\bhidden(?: facts)?(?: raised)?:? ([+−-])(\d+(?:\.\d+)?)(?: points?)?(?: \([^)]{1,24}\))?/i.exec(text);
  if (m) {
    const gain = m[1] === "+" && Number(m[2]) > 0;
    const figure = m[0].replace(/^H/, "h");
    return gain ? `measured ${oneLine(figure, 60)}; killed for another reason (read the row)` : oneLine(figure, 80);
  }
  const why = firstSentence(plain(row.why));
  // Not a cell that only echoes the status ("Measured and deleted (D704)", "Trial, off").
  const echo = /^(Accepted|The same runs?\b|Measured and deleted|Deleted|Rejected|Trial\b)/;
  if ([...why].length <= 140 && why !== "" && !echo.test(why) && !CITATION_ONLY.test(why)) {
    return oneLine(why, 110);
  }
  return "";
}

const INDEX_HEAD = `# Decision index

Generated from [DECISIONS.md](DECISIONS.md) by \`bun run decisions:index\` (scripts/decision-index.ts, D812). Do not
edit: change DECISIONS.md and regenerate; a test fails while this page is stale. DECISIONS.md is the record; this is
the way into it. Dead ends by topic: [DEAD-ENDS.md](DEAD-ENDS.md).

Statuses are read from the text by heuristics, so read the row before relying on one:

- **adopted**: in force, amended or not. "adopted (by Dn)": a trial or proposal that Dn promoted.
- **rejected**: the row records an idea measured or weighed and not kept (rejected, not built, deleted).
- **superseded**: a later decision deleted, reversed or replaced it. "deleted by Dn" is a dead end; "replaced by
  Dn" is not.
- **trial**: the decision a row of DECISIONS.md's "Trial switches" table names first, when it opens a trial; still
  open.
- **finding**: a measurement recorded as a finding; it decides nothing by itself.
- **lab**: lab tooling, a pre-registration or a lab-only change; nothing ships.
`;

const DEAD_HEAD = `# Dead ends

Generated from [DECISIONS.md](DECISIONS.md) by \`bun run decisions:index\` (scripts/decision-index.ts, D812). Do not
edit: change DECISIONS.md and regenerate. **Read this before proposing an idea**: it may have been tried, measured
and killed already.

Each line is one idea: a decision whose status in [DECISION-INDEX.md](DECISION-INDEX.md) is \`rejected\` or
\`superseded\` by a deletion ("killed by Dn": the row that deleted it, which has no line of its own), or the rejected
or deleted part of an adopted decision or a finding (marked "part of"). The last column says why it ended when the
text says so briefly; a bare gain ("measured hidden +x") means it died for another reason, so read the row. Topics
come from a keyword map, so an idea can sit under a neighbouring topic: search the page for its switch name.
`;

function statusCell(v: Verdict): string {
  if (v.status === "superseded") {
    const how = v.deleted ? "deleted" : "replaced";
    return v.by === undefined ? `superseded (${how})` : `superseded (${how} by D${v.by})`;
  }
  if (v.status === "adopted" && v.by !== undefined) return `adopted (by D${v.by})`;
  return v.status;
}

/** "503 decisions: adopted …": printed, never written to the pages, where it would conflict on every merge. */
export function tally(rows: Row[], verdicts: Map<string, Verdict>): string {
  const counts = new Map<Status, number>();
  for (const v of verdicts.values()) counts.set(v.status, (counts.get(v.status) ?? 0) + 1);
  return `${rows.length} decisions: ${STATUSES.map((s) => `${s} ${counts.get(s) ?? 0}`).join(", ")}.`;
}

export function renderIndex(rows: Row[], verdicts: Map<string, Verdict>): string {
  const lines = [INDEX_HEAD, "| # | Date | Decision | Status |"];
  lines.push("|---|---|---|---|");
  for (const r of rows) {
    lines.push(`| ${r.label} | ${r.date} | ${summarize(r.decision)} | ${statusCell(verdicts.get(r.label)!)} |`);
  }
  return `${lines.join("\n")}\n`;
}

export function isDeadEnd(v: Verdict): boolean {
  return v.status === "rejected" || (v.status === "superseded" && v.deleted === true) || v.killedPart !== undefined;
}

export function renderDeadEnds(rows: Row[], verdicts: Map<string, Verdict>): string {
  const byNumber = new Map<number, Row>();
  for (const r of rows) for (const n of r.numbers) byNumber.set(n, r);
  // One line per idea: a row that deleted ideas listed here ("`pushPointer` (D708) … is deleted") is folded into
  // their lines as "killed by Dn" instead of a line of its own.
  const killedBy = new Map<number, number[]>();
  for (const r of rows) {
    const v = verdicts.get(r.label)!;
    if (isDeadEnd(v) && v.status === "superseded" && v.by !== undefined) {
      killedBy.set(v.by, [...(killedBy.get(v.by) ?? []), r.numbers[0]!]);
    }
  }
  const groups = new Map<string, string[]>();
  for (const r of rows) {
    const v = verdicts.get(r.label)!;
    if (!isDeadEnd(v) || killedBy.has(r.numbers[0]!)) continue;
    const killer = v.status === "superseded" && v.by !== undefined ? byNumber.get(v.by) : undefined;
    // A killer that ended several ideas speaks for all of them, so the idea's own reason comes first then.
    const shared = v.by !== undefined && (killedBy.get(v.by)?.length ?? 0) > 1;
    // Shared, the killer's figures may be another idea's ("+0.0" was arm K's, not `+amend`'s): only its cause counts.
    const reason = killer
      ? shared
        ? reasonOf(killer, true) || reasonOf(r)
        : reasonOf(killer) || reasonOf(r)
      : reasonOf(r);
    let how = reason;
    if (v.status === "superseded") {
      how = `killed${v.by === undefined ? " later" : ` by D${v.by}`}${reason ? `: ${reason}` : ""}`;
    }
    const tried = v.killedPart ? `part of: ${oneLine(v.killedPart, 130)}` : summarize(r.decision);
    const topic = topicOf(v.killedPart ?? summaryText(r.decision).replace(META, ""));
    const list = groups.get(topic) ?? [];
    list.push(`| ${r.label} | ${tried} | ${how} |`);
    groups.set(topic, list);
  }
  const lines = [DEAD_HEAD];
  for (const topic of [...TOPICS.map(([name]) => name), "Other"]) {
    const list = groups.get(topic);
    if (list) lines.push(`## ${topic}`, "", "| # | What was tried | Why it ended |", "|---|---|---|", ...list, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** Both pages for a DECISIONS.md text. */
export function generate(md: string): { index: string; deadEnds: string; summary: string } {
  const { rows, trials } = parseDecisions(md);
  const verdicts = classify(rows, trials);
  const deadEnds = renderDeadEnds(rows, verdicts);
  const lines = deadEnds.split("\n").filter((l) => /^\| D\d/.test(l));
  const reasoned = lines.filter((l) => !/\| (?:killed(?: later| by D\d+))? \|$/.test(l)).length;
  const summary = `${tally(rows, verdicts)} ${lines.length} dead ends, ${reasoned} with a reason.`;
  return { index: renderIndex(rows, verdicts), deadEnds, summary };
}

const DOCS = join(import.meta.dir, "..", "docs");
export const PATHS = {
  decisions: join(DOCS, "DECISIONS.md"),
  index: join(DOCS, "DECISION-INDEX.md"),
  deadEnds: join(DOCS, "DEAD-ENDS.md"),
};

/** The committed pages that differ from what would be generated now; empty when both are current. */
export function stale(): string[] {
  const { index, deadEnds } = generate(readFileSync(PATHS.decisions, "utf8"));
  const read = (p: string) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  };
  const out: string[] = [];
  if (read(PATHS.index) !== index) out.push("docs/DECISION-INDEX.md");
  if (read(PATHS.deadEnds) !== deadEnds) out.push("docs/DEAD-ENDS.md");
  return out;
}

if (import.meta.main) {
  const { index, deadEnds, summary } = generate(readFileSync(PATHS.decisions, "utf8"));
  if (process.argv.includes("--check")) {
    const out = stale();
    console.log(summary);
    if (out.length > 0) {
      console.error(`${out.join(" and ")} out of date with docs/DECISIONS.md: run \`bun run decisions:index\`.`);
      process.exit(1);
    }
    console.log("Decision index and dead ends are current.");
  } else {
    writeFileSync(PATHS.index, index);
    writeFileSync(PATHS.deadEnds, deadEnds);
    console.log(`${summary}\nWrote docs/DECISION-INDEX.md and docs/DEAD-ENDS.md.`);
  }
}
